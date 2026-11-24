import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
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
