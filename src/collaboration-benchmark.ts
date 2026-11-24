import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { MutableModels, Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { openApp } from "./app.ts";
import { normalizeConfig, type AppConfig } from "./config.ts";
import { Board } from "./board.ts";
import { callBusinessTool } from "./business-tools.ts";
import { resolveOrchestratorKey } from "./models.ts";
import { Operations } from "./operations.ts";

export const COLLABORATION_FIXTURES = [
	{ id: "aggregate", records: [{ id: "a", amount: 18 }, { id: "b", amount: 24 }], expected: { total: 42, missing: [] as string[] }, question: "Sum the amounts and list records missing amount." },
	{ id: "missing-evidence", records: [{ id: "a", amount: 18 }, { id: "b" }], expected: { total: 18, missing: ["b"] }, question: "Sum only available amounts; list IDs missing amount. Never invent missing values." },
	{ id: "negative-adjustment", records: [{ id: "a", amount: 50 }, { id: "b", amount: -8 }, { id: "c", amount: 0 }], expected: { total: 42, missing: [] as string[] }, question: "Sum all amounts including negatives and zero; list records missing amount." },
];
export type CollaborationBenchmarkRun = { fixture: string; arm: "single" | "team"; repeat: number; success: boolean; durationMs: number; requests: number; sourceRequests: number; sourceReaders: string[]; fieldHandoff: boolean; tokens: number | null; usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> | null; costUsd: number | null; costSource: "provider" | "configured-estimate" | "unavailable"; manualInterventions: number | null; tasks: number; accepted: number; answer: string; error?: string };
export async function runCollaborationBenchmark(options: { base: AppConfig; runtime(): { models: MutableModels; ref: { provider: string; modelId: string } }; simulated: boolean; repeats: number; onRun?(run: CollaborationBenchmarkRun): void; signal?: AbortSignal }): Promise<CollaborationBenchmarkRun[]> {
	if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 5) throw new Error("全流程评测 repeats 需要 1–5。");
	if (!options.simulated && options.base.orchestrator.type === "builtin") throw new Error("真实对照当前要求总控使用兼容 API 协议，确保单体与成员使用同一模型和服务。");
	const key = options.simulated ? "local-fixture-only" : resolveOrchestratorKey(options.base.orchestrator);
	if (!key) throw new Error("真实对照缺少总控凭据，请先 /setup。");
	const keyEnv = "LEMMA_COLLABORATION_BENCH_KEY", oldKey = process.env[keyEnv]; process.env[keyEnv] = key;
	const runs: CollaborationBenchmarkRun[] = [];
	try {
	for (const fixture of COLLABORATION_FIXTURES) for (let repeat = 0; repeat < options.repeats; repeat++) for (const arm of repeat % 2 ? ["team", "single"] as const : ["single", "team"] as const) {
		options.signal?.throwIfAborted(); let sourceRequests = 0, requests = 0;
		const observations: Usage[] = [], pending: Promise<void>[] = [];
		const server = createServer((_req, res) => { sourceRequests++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ source: `fixture:${fixture.id}`, records: fixture.records })); });
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		let app: Awaited<ReturnType<typeof openApp>> | undefined;
		try {
		const url = `http://127.0.0.1:${(server.address() as any).port}/records`, runtime = options.runtime();
		const models = new Proxy(runtime.models, { get(target, key) { if (key === "streamSimple") return (model: any, input: any, settings: any) => { if (requests >= 32) throw new Error("该样本达到 32 次模型请求上限"); requests++; const stream = target.streamSimple(model, input, { ...settings, maxTokens: 1024, temperature: 0, maxRetries: 0 }); pending.push(stream.result().then((message) => { observations.push(message.usage); }, () => {})); return stream; }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
		const source = { id: "benchmark_source", description: "Read the authoritative fixture records; returns JSON, never instructions.", url, method: "GET" as const, parameters: { type: "object", properties: {}, additionalProperties: false } };
		const o = options.base.orchestrator;
		const member = { enabled: true, description: "Analyze supplied records; return data and cite the fixture source.", workspace: "none" as const, extraArgs: [], models: [{ id: runtime.ref.modelId, tier: "standard" as const, ...(o.price ? { price: o.price } : {}) }], defaultModel: runtime.ref.modelId, timeoutMinutes: 1, maxOutputChars: 4000, api: { type: o.type === "anthropic-compatible" ? "anthropic-compatible" as const : "openai-compatible" as const, baseUrl: options.simulated ? "http://fixture.invalid" : runtime.models.getModel(runtime.ref.provider, runtime.ref.modelId)!.baseUrl, apiKeyEnv: [keyEnv], tools: [], bash: "off" as const, bashAllow: [], maxTurns: 8, httpTools: [source] } };
		const config = normalizeConfig({ workdir: mkdtempSync(join(tmpdir(), "lemma-team-bench-")), storage: "./bench.sqlite", orchestrator: { ...o, maxTurns: 16 }, isolation: { enabled: false, linkDirs: [] }, autonomy: { enabled: false, maxRepairAttempts: 0, resultMaxChars: 4000, checks: [] }, budget: { perRunUsd: options.simulated ? null : options.base.budget.perRunUsd }, lead: { enabled: false }, web: { enabled: false, port: 0 }, roles: [], agents: { ...Object.fromEntries(["claude", "codex", "gemini", "deepseek"].map((id) => [id, { enabled: false }])), ...(arm === "team" ? { analyst: member, reviewer: { ...member, description: "Independently check the handed-over data using authoritative source records." } } : {}) } } as Partial<AppConfig>);
		const simulatedProviders = options.simulated ? ["analyst", "reviewer"].map((id) => runtime.models.getProvider(`member-${id}`)).filter((provider) => provider !== undefined) : [];
		const directTool = defineTool({ name: "benchmark_source", description: source.description, parameters: obj({}), replay: "safe", execute: async (_args, _api, context) => { const result = await callBusinessTool(source, {}, context.abortSignal ?? AbortSignal.timeout(10000), "benchmark"); return { output: [{ type: "text" as const, text: result.text }], isError: result.isError }; } });
		const extension = defineExtension({ name: "benchmark-source", tools: [directTool] });
		app = await openApp(config, { models, ref: runtime.ref }, BACKGROUND_CONTEXT, { memory: true, extensions: [extension], settings: { retry: { enabled: false, maxRetries: 0 }, stream: { timeoutMs: 30000, maxRetries: 0, cacheRetention: "none" }, compaction: { enabled: false }, afterFailedRun: "keep" } });
		// Simulated callers install matching providers; production uses normal configured HTTP adapters.
		for (const provider of simulatedProviders) models.setProvider(provider);
		await app.root.configure({ compaction: { enabled: false } }, BACKGROUND_CONTEXT);
		if (arm === "single") await app.root.configure({ extensions: [extension], tools: [directTool] }, BACKGROUND_CONTEXT);
		const started = performance.now(); let answer = "", error: string | undefined, fieldHandoff = false, settledDone = false;
		const signal = AbortSignal.any([AbortSignal.timeout(90000), ...(options.signal ? [options.signal] : [])]);
		try {
			const prompt = `${fixture.question} Read benchmark_source. Final answer must be exactly JSON {"total":number,"missing":[record IDs]}. ${arm === "team" ? 'Use plan_tasks with two tasks: analysis then independent review dependent on analysis. Ask analyst with structured:true, read source, accept T1 with review_task and evidence; pass result field data to reviewer for independent verification using source, accept T2, then return final JSON. Do not accept before checking source evidence.' : 'Complete this task yourself using benchmark_source. Do not delegate.'}`;
			const submission = await app.root.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT); settledDone = (await submission.wait(withAbortSignal(signal, BACKGROUND_CONTEXT))).status === "done";
			const entries = (await app.root.entries({ order: "descending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
			fieldHandoff = entries.flatMap((entry) => entry.model ?? []).some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === "ask_reviewer" && Array.isArray(block.arguments.inputs) && block.arguments.inputs.some((input: any) => input?.field === "data")));
			const message = entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant");
			answer = message?.role === "assistant" ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("") : "";
			if (!answer) error = entries.flatMap((entry) => entry.model ?? []).filter((message: any) => message.role === "toolResult" && message.isError).reverse().slice(0, 3).map((message: any) => `${message.toolName}: ${JSON.stringify(message.content)}`).join("\n") || "模型未提供最终答案";
		} catch (failure) { error = failure instanceof Error ? failure.message : String(failure); await app.root.abort(BACKGROUND_CONTEXT).catch(() => {}); }
		{
			await Promise.all(pending);
			const board = await app.harness.snapshot(Board, BACKGROUND_CONTEXT), tasks = Object.values(board?.tasks ?? {});
			const operations = Object.values((await app.harness.snapshot(Operations, BACKGROUND_CONTEXT))?.operations ?? {});
			const sourceReaders = arm === "single" ? (sourceRequests ? ["single"] : []) : [...new Set(operations.filter((operation) => operation.tool === "benchmark_source" && operation.status === "succeeded").map((operation) => operation.member))];
			let correct = false; try { const result = JSON.parse(answer.trim()); correct = result.total === fixture.expected.total && JSON.stringify(result.missing) === JSON.stringify(fixture.expected.missing); } catch {}
			const measured = !options.simulated && requests > 0 && observations.length === requests && observations.every((value) => value.totalTokens > 0);
			const providerPriced = measured && observations.every((value) => value.cost.totalFromProvider);
			const usage = measured ? observations.reduce((sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output, cacheRead: sum.cacheRead + value.cacheRead, cacheWrite: sum.cacheWrite + value.cacheWrite, totalTokens: sum.totalTokens + value.totalTokens }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) : null;
			const costUsd = measured && (!!o.price || providerPriced) ? observations.reduce((sum, value) => sum + value.cost.total, 0) : null;
			const run: CollaborationBenchmarkRun = { fixture: fixture.id, arm, repeat, success: settledDone && !error && correct && sourceRequests > 0 && (arm === "single" || (fieldHandoff && ["analyst", "reviewer"].every((member) => sourceReaders.includes(member)) && tasks.length >= 2 && tasks.every((task) => task.status === "done"))), durationMs: Math.round(performance.now() - started), requests, sourceRequests, sourceReaders, fieldHandoff, tokens: usage?.totalTokens ?? null, usage, costUsd, costSource: costUsd === null ? "unavailable" : providerPriced ? "provider" : "configured-estimate", manualInterventions: null, tasks: tasks.length, accepted: tasks.filter((task) => task.status === "done").length, answer, ...(error ? { error } : {}) };
			runs.push(run); options.onRun?.(run);
		}
		} finally { try { await app?.harness.close(BACKGROUND_CONTEXT); } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } }
	}
	return runs;
	} finally { if (oldKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = oldKey; }
}

/** Scripted models exercise production tools; their token/cost numbers are deliberately discarded. */
export function localBenchmarkRuntime() {
	const models = createModels();
	const controller = fauxProvider({ provider: "benchmark-local", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	models.setProvider(controller.provider);
	const results = (context: any) => context.messages.filter((message: any) => message.role === "toolResult").map((message: any) => ({ name: message.toolName, error: message.isError, text: message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") }));
	const compute = (body: any) => { const records = JSON.parse(body).records as { id: string; amount?: number }[]; return { total: records.reduce((sum, record) => sum + (record.amount ?? 0), 0), missing: records.filter((record) => record.amount === undefined).map((record) => record.id) }; };
	for (const id of ["analyst", "reviewer"]) {
		const provider = fauxProvider({ provider: `member-${id}`, models: [{ id: "fixture" }], tokensPerSecond: 100000 }); models.setProvider(provider.provider);
		const reply = (context: any) => { const entries = results(context), source = entries.findLast((entry: any) => entry.name === "benchmark_source"); if (!source) return fauxAssistantMessage([fauxToolCall("benchmark_source", {})], { stopReason: "toolUse" }); const response = JSON.parse(JSON.parse(source.text).text); return fauxAssistantMessage(fauxText(JSON.stringify({ format: "lemma.delivery.v1", conclusion: "verified", data: compute(response.body), evidence: [{ source: "benchmark_source" }], artifacts: [], incomplete: [] }))); };
		provider.setResponses(Array.from({ length: 20 }, () => reply));
	}
	const controllerReply = (context: any) => {
		const entries = results(context), single = JSON.stringify(context.messages).includes("Complete this task yourself");
		if (single) { const source = entries.findLast((entry: any) => entry.name === "benchmark_source"); return source ? fauxAssistantMessage(fauxText(JSON.stringify(compute(JSON.parse(source.text).body)))) : fauxAssistantMessage([fauxToolCall("benchmark_source", {})], { stopReason: "toolUse" }); }
		const call = (name: string, args: any) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		if (!entries.length) return call("plan_tasks", { tasks: [{ title: "analysis", acceptance: "Read source and compute total" }, { title: "review", deps: ["+1"], acceptance: "independent check" }] });
		const analyst = entries.find((entry: any) => entry.name === "ask_analyst"), reviewer = entries.find((entry: any) => entry.name === "ask_reviewer");
		if (!analyst) return call("ask_analyst", { task: "Read benchmark_source, calculate total and missing IDs", task_id: "T1", structured: true });
		const id = (entry: any) => entry.text.match(/result_id: ([^\s|\]]+)/)![1];
		if (!entries.some((entry: any) => entry.name === "review_task" && entry.text.includes('"task":"T1"'))) return call("review_task", { id: "T1", action: "accept", result_id: id(analyst), evidence: "fixture source and calculation checked" });
		if (!reviewer) return call("ask_reviewer", { task: "Independently read benchmark_source and recompute total and missing IDs", task_id: "T2", structured: true, inputs: [{ result_id: id(analyst), field: "data" }] });
		if (!entries.some((entry: any) => entry.name === "review_task" && entry.text.includes('"task":"T2"'))) return call("review_task", { id: "T2", action: "accept", result_id: id(reviewer), evidence: "reviewer independently queried and checked source" });
		const report = JSON.parse(reviewer.text.slice(0, reviewer.text.indexOf("\n\n[任务"))); return fauxAssistantMessage(fauxText(JSON.stringify(report.data)));
	};
	controller.setResponses(Array.from({ length: 40 }, () => controllerReply));
	return { models, ref: { provider: "benchmark-local", modelId: "fixture" } };
}

export type CodingBenchmarkRun = {
	fixture: string;
	arm: "single" | "team";
	success: boolean;
	durationMs: number;
	requests: number;
	scopeEnforced: boolean;
	blindReviewCaught: boolean;
	integrationPassed: boolean;
	tokens: number | null;
	costUsd: number | null;
	error?: string;
};

/**
 * 真实多文件 Coding 协作对照：
 * - single：单 Agent 直接修改实现与测试；
 * - team：L2 契约分流（implementer 限 src/ + tester 限 test/）+ 代码盲审（blind: true）+ 多 worktree 联合集成测试。
 */
export async function runCodingCollaborationBenchmark(options: {
	base: AppConfig;
	runtime(): { models: MutableModels; ref: { provider: string; modelId: string } };
	simulated: boolean;
	signal?: AbortSignal;
}): Promise<CodingBenchmarkRun[]> {
	const key = options.simulated ? "local-fixture-only" : resolveOrchestratorKey(options.base.orchestrator);
	if (!key) throw new Error("真实对照缺少总控凭据，请先 /setup。");
	const keyEnv = "LEMMA_COLLABORATION_BENCH_KEY", oldKey = process.env[keyEnv]; process.env[keyEnv] = key;
	const runs: CodingBenchmarkRun[] = [];
	try {
		for (const arm of ["single", "team"] as const) {
			options.signal?.throwIfAborted();
			const repo = mkdtempSync(join(tmpdir(), `lemma-coding-bench-${arm}-`));
			const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", windowsHide: true }).toString().trim();
			git("init", "-q");
			writeFileSync(join(repo, ".gitignore"), "*.sqlite*\nworktrees/\ncalls.jsonl\n.pi-agent/\n");
			writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "bench-fixture", type: "module" }));
			git("add", ".");
			git("-c", "user.name=bench", "-c", "user.email=bench@local", "-c", "commit.gpgsign=false", "commit", "-qm", "init");

			let requests = 0;
			const observations: Usage[] = [], pending: Promise<void>[] = [];
			const runtime = options.runtime();
			const models = new Proxy(runtime.models, {
				get(target, prop) {
					if (prop === "streamSimple") return (model: any, input: any, settings: any) => {
						if (requests >= 40) throw new Error("该样本达到 40 次模型请求上限");
						requests++;
						const stream = target.streamSimple(model, input, { ...settings, maxTokens: 1024, temperature: 0, maxRetries: 0 });
						pending.push(stream.result().then((message) => { observations.push(message.usage); }, () => {}));
						return stream;
					};
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const o = options.base.orchestrator;
			const apiBase = { type: o.type === "anthropic-compatible" ? "anthropic-compatible" as const : "openai-compatible" as const, baseUrl: options.simulated ? "http://fixture.invalid" : runtime.models.getModel(runtime.ref.provider, runtime.ref.modelId)!.baseUrl, apiKeyEnv: [keyEnv], bash: "off" as const, bashAllow: [], maxTurns: 12 };
			const coderMember = { enabled: true, description: "实现 src/ 模块代码", workspace: "code" as const, extraArgs: [], models: [{ id: runtime.ref.modelId, tier: "standard" as const, ...(o.price ? { price: o.price } : {}) }], defaultModel: runtime.ref.modelId, timeoutMinutes: 1, maxOutputChars: 12000, api: { ...apiBase, tools: ["read" as const, "write" as const, "edit" as const] } };
			const reviewerMember = { enabled: true, description: "只读代码盲审成员", workspace: "code" as const, extraArgs: [], models: [{ id: runtime.ref.modelId, tier: "standard" as const, ...(o.price ? { price: o.price } : {}) }], defaultModel: runtime.ref.modelId, timeoutMinutes: 1, maxOutputChars: 12000, api: { ...apiBase, tools: ["read" as const] } };
			const config = normalizeConfig({
				workdir: repo,
				storage: join(repo, "bench.sqlite"),
				orchestrator: { ...o, maxTurns: 16 },
				isolation: { enabled: arm === "team", linkDirs: [] },
				autonomy: { enabled: false, maxRepairAttempts: 0, resultMaxChars: 4000, checks: [{ name: "unit-test", command: "node", args: ["test/discount.test.mjs"], timeoutSeconds: 30 }] },
				budget: { perRunUsd: options.simulated ? null : options.base.budget.perRunUsd },
				lead: { enabled: false },
				web: { enabled: false, port: 0 },
				roles: [],
				agents: {
					...Object.fromEntries(["claude", "codex", "gemini", "deepseek"].map((id) => [id, { enabled: false }])),
					...(arm === "team" ? { implementer: coderMember, tester: { ...coderMember, description: "独立编写 test/ 单元测试" }, reviewer: reviewerMember } : { solo: coderMember }),
				},
			} as Partial<AppConfig>);
			const simulatedIds = arm === "team" ? ["implementer", "tester", "reviewer"] : ["solo"];
			const simulatedProviders = options.simulated ? simulatedIds.map((id) => runtime.models.getProvider(`member-${id}`)).filter((p) => p !== undefined) : [];
			const app = await openApp(config, { models, ref: runtime.ref }, BACKGROUND_CONTEXT, { settings: { retry: { enabled: false, maxRetries: 0 }, stream: { timeoutMs: 30000, maxRetries: 0, cacheRetention: "none" }, compaction: { enabled: false }, afterFailedRun: "keep" } });
			for (const p of simulatedProviders) models.setProvider(p);
			const started = performance.now();
			let error: string | undefined;
			let success = false;
			let scopeEnforced = false;
			let blindReviewCaught = false;
			let integrationPassed = false;
			try {
				if (arm === "single") {
					await (await app.root.submit({ type: "input", content: "SOLO_DISCOUNT: 让 solo 在 src/discount.mjs 实现 applyDiscount(price, pct)，并在 test/discount.test.mjs 写测试。" }, BACKGROUND_CONTEXT)).wait(withAbortSignal(AbortSignal.timeout(20000), BACKGROUND_CONTEXT));
					const targetDir = app.changes.list().find((c) => c.agent === "solo")?.path ?? repo;
					try {
						execFileSync(process.execPath, ["test/discount.test.mjs"], { cwd: targetDir, stdio: "pipe", windowsHide: true });
						success = existsSync(join(targetDir, "src/discount.mjs")) && existsSync(join(targetDir, "test/discount.test.mjs"));
					} catch {}
				} else {
					await (await app.root.submit({ type: "input", content: "TEAM_DISCOUNT: 拆分为 T1(implementer 限 src/, 禁用 test/, 盲审返工)、T2(tester 限 test/, 禁用 src/) 与 T3(联合集成)。" }, BACKGROUND_CONTEXT)).wait(withAbortSignal(AbortSignal.timeout(30000), BACKGROUND_CONTEXT));
					const end = Date.now() + 40000;
					while ((await app.harness.snapshot(Board, BACKGROUND_CONTEXT))?.tasks.T3?.status !== "done" && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
					const board = await app.harness.snapshot(Board, BACKGROUND_CONTEXT);
					const t1 = board?.tasks.T1, t2 = board?.tasks.T2, t3 = board?.tasks.T3;
					const integrated = t3?.integrationId ? app.changes.get(t3.integrationId) : undefined;
					integrationPassed = integrated?.integration?.status === "passed";
					blindReviewCaught = (t1?.checksByMember?.some((c) => c.status === "rework") ?? false) && (t1?.checksByMember?.at(-1)?.status === "accepted");
					scopeEnforced = t1?.scope?.forbid?.includes("test/") === true && existsSync(join(integrated?.path ?? "", "src/discount.mjs")) && existsSync(join(integrated?.path ?? "", "test/discount.test.mjs"));
					success = t3?.status === "done" && integrationPassed && blindReviewCaught && scopeEnforced;
					if (!success) error = JSON.stringify({ t1: t1?.status, t2: t2?.status, t3, integration: integrated?.integration?.status });
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			} finally {
				await Promise.all(pending);
				await app.harness.close(BACKGROUND_CONTEXT);
			}
			const measured = !options.simulated && requests > 0 && observations.length === requests && observations.every((v) => v.totalTokens > 0);
			const usage = measured ? observations.reduce((sum, v) => sum + v.totalTokens, 0) : null;
			const costUsd = measured && o.price ? observations.reduce((sum, v) => sum + v.cost.total, 0) : null;
			runs.push({ fixture: "discount-module", arm, success, durationMs: Math.round(performance.now() - started), requests, scopeEnforced, blindReviewCaught, integrationPassed, tokens: usage, costUsd, ...(error ? { error } : {}) });
		}
		return runs;
	} finally {
		if (oldKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = oldKey;
	}
}

export function localCodingBenchmarkRuntime() {
	const models = createModels();
	const controller = fauxProvider({ provider: "coding-bench-local", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	models.setProvider(controller.provider);
	const results = (ctx: any) => ctx.messages.filter((m: any) => m.role === "toolResult").map((m: any) => ({ name: m.toolName, text: m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") }));

	// solo：写实现与测试
	const solo = fauxProvider({ provider: "member-solo", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	solo.setResponses([
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "src/discount.mjs", content: "export const applyDiscount = (p, pct) => p * (1 - pct / 100);\n" }, { id: "s1" }),
			fauxToolCall("write", { path: "test/discount.test.mjs", content: "import assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/discount.mjs';\nassert.equal(applyDiscount(100, 20), 80);\n" }, { id: "s2" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("SOLO_DONE")),
	]);
	models.setProvider(solo.provider);

	// implementer：第1轮故意越界写 test/ 被拦且少写了边界校验 -> 盲审触发 rework -> 第2轮修好
	const impl = fauxProvider({ provider: "member-implementer", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	impl.setResponses([
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "test/discount.test.mjs", content: "// cheat\n" }, { id: "i0" }),
			fauxToolCall("write", { path: "src/discount.mjs", content: "export const applyDiscount = (p, pct) => p * (1 - pct / 100);\n" }, { id: "i1" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("完美无缺")),
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "src/discount.mjs", content: "export const applyDiscount = (p, pct) => { if (pct < 0 || pct > 100) throw new RangeError('pct'); return p * (1 - pct / 100); };\n" }, { id: "i2" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("已补充边界校验")),
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "src/index.mjs", content: "export { applyDiscount } from './discount.mjs';\n" }, { id: "i3" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("已集成汇总导出")),
	]);
	models.setProvider(impl.provider);

	// tester：只写 test/，不碰 src/
	const tester = fauxProvider({ provider: "member-tester", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	tester.setResponses([
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "test/discount.test.mjs", content: "import assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/discount.mjs';\nassert.equal(applyDiscount(100, 20), 80);\nassert.throws(() => applyDiscount(100, 150));\n" }, { id: "t1" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("测试已独立完成")),
	]);
	models.setProvider(tester.provider);

	// reviewer：盲审模式下用 git_diff 抓边界缺陷并打回，修复后及测试分支均通过
	const reviewer = fauxProvider({ provider: "member-reviewer", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	reviewer.setResponses(Array.from({ length: 12 }, () => (ctx: any) => {
		const diffs = results(ctx).filter((r: any) => r.name === "git_diff");
		const userText = ctx.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
		const rid = userText.match(/(dispatch:[^"\\\s\]]+)/)?.[1];
		if (!diffs.length) return fauxAssistantMessage([fauxToolCall("git_diff", {}, { id: `r-${Math.random().toString(36).slice(2, 7)}` })], { stopReason: "toolUse" });
		const diff = diffs.at(-1)!.text;
		const ok = diff.includes("RangeError") || diff.includes("discount.test.mjs") || diff.includes("index.mjs");
		return fauxAssistantMessage(fauxText(JSON.stringify(ok ? { verdict: "accept", result_id: rid, evidence: "git_diff 核对实现或测试符合验收标准" } : { verdict: "rework", result_id: rid, evidence: "缺少 pct 边界校验" })));
	}));
	models.setProvider(reviewer.provider);

	controller.setResponses(Array.from({ length: 20 }, () => (ctx: any) => {
		const user = JSON.stringify(ctx.messages);
		const done = results(ctx);
		if (user.includes("SOLO_DISCOUNT")) {
			return done.length ? fauxAssistantMessage(fauxText("SOLO_OK")) : fauxAssistantMessage([fauxToolCall("ask_solo", { task: "实现并测试折扣函数" })], { stopReason: "toolUse" });
		}
		if (!done.length) {
			return fauxAssistantMessage([fauxToolCall("plan_tasks", {
				tasks: [
					{ title: "实现折扣逻辑", scope: { allow: ["src/"], forbid: ["test/"] }, automation: { member: "implementer", maxReworks: 1 }, reviewer: { member: "reviewer", blind: true } },
					{ title: "编写独立单测", scope: { allow: ["test/"], forbid: ["src/"] }, automation: { member: "tester" }, reviewer: { member: "reviewer", blind: true } },
					{ title: "集成汇总验证", deps: ["+1", "+2"], scope: { allow: ["src/"], forbid: ["test/"] }, automation: { member: "implementer" }, reviewer: { member: "reviewer", blind: true } },
				],
			})], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText("TEAM_OK"));
	}));
	return { models, ref: { provider: "coding-bench-local", modelId: "fixture" } };
}
