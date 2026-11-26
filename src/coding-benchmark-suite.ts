// P1 分层编码基准与消融评测引擎：
// 支持 single / lemma-adaptive / ablation-no-fastpath / ablation-no-blind / ablation-no-scope 五组实验臂，
// 既支持离线确定性模拟验证全链路（0 费用），也支持 --real 调用真实配置模型产出可汇报的定量对照报告。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type MutableModels, type Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "./app.ts";
import { createMemberTools, memberProvider } from "./api-member.ts";
import { Board } from "./board.ts";
import { applyChange } from "./change-ops.ts";
import { normalizeConfig, type AppConfig } from "./config.ts";
import { resolveOrchestratorKey } from "./models.ts";
import { CODING_BENCHMARK_TASKS, type BenchmarkTier, type CodingBenchmarkTask } from "./coding-benchmark-fixtures.ts";

export type BenchmarkArm =
	| "single"
	| "lemma-adaptive"
	| "ablation-no-fastpath"
	| "ablation-no-blind"
	| "ablation-no-scope";

export interface HiddenTestResult {
	ok: boolean;
	passed: number;
	total: number;
	output: string;
}

export interface TieredCodingRun {
	taskId: string;
	tier: BenchmarkTier;
	title: string;
	arm: BenchmarkArm;
	repeat: number;
	success: boolean;
	hiddenPassed: number;
	hiddenTotal: number;
	durationMs: number;
	requests: number;
	tokens: number | null;
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> | null;
	costUsd: number | null;
	costSource: "provider" | "configured-estimate" | "unavailable";
	usedFastPath: boolean;
	blindReviewCaught: number;
	scopeViolationsCaught: number;
	integrationPassed: boolean;
	error?: string;
}

export function defaultArmsForTier(tier: BenchmarkTier): BenchmarkArm[] {
	if (tier === 1) return ["single", "lemma-adaptive", "ablation-no-fastpath"];
	if (tier === 2) return ["single", "lemma-adaptive", "ablation-no-blind"];
	return ["single", "lemma-adaptive", "ablation-no-scope"];
}

/** 在指定仓库目录运行隐藏测试脚本（node --test --test-reporter=tap），运行完毕后立即删除临时测试文件 */
export function runHiddenTests(repoDir: string, hiddenTestCode: string, timeoutMs = 15_000): HiddenTestResult {
	const testFile = join(repoDir, ".lemma-hidden.test.mjs");
	writeFileSync(testFile, hiddenTestCode, "utf8");
	try {
		const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
			cwd: repoDir,
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
		});
		const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
		const passMatch = out.match(/^#\s+pass\s+(\d+)/m);
		const failMatch = out.match(/^#\s+fail\s+(\d+)/m);
		const totalMatch = out.match(/^#\s+tests\s+(\d+)/m);
		const passed = passMatch ? Number(passMatch[1]) : 0;
		const failed = failMatch ? Number(failMatch[1]) : 0;
		const total = totalMatch ? Number(totalMatch[1]) : passed + failed;
		return {
			ok: res.status === 0 && total > 0 && passed === total,
			passed,
			total,
			output: out.trim().slice(-1500),
		};
	} finally {
		try { rmSync(testFile, { force: true }); } catch {}
	}
}

export function initTaskRepo(task: CodingBenchmarkTask): string {
	const repo = mkdtempSync(join(tmpdir(), `lemma-p1-${task.id}-`));
	writeFileSync(join(repo, ".gitignore"), "*.sqlite*\nworktrees/\ncalls.jsonl\n.pi-agent/\n.lemma-hidden.test.mjs\n", "utf8");
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: `bench-${task.id}`, type: "module" }, null, 2), "utf8");
	for (const [rel, content] of Object.entries(task.initialFiles)) {
		const full = join(repo, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	const runGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", windowsHide: true });
	runGit("init", "-q");
	runGit("add", "-A");
	runGit("-c", "user.name=bench", "-c", "user.email=bench@local", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
	return repo;
}

/** 离线确定性模拟运行时：驱动真实 openApp、fastDispatch、盲审返工、路径契约拦截与联合集成 */
export function localTieredCodingRuntime(task: CodingBenchmarkTask, arm: BenchmarkArm) {
	const models = createModels();
	const ctrl = fauxProvider({ provider: "bench-ctrl", models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(ctrl.provider);

	const toolResults = (ctx: any) =>
		ctx.messages
			.filter((m: any) => m.role === "toolResult")
			.map((m: any) => ({
				name: m.toolName,
				isError: !!m.isError,
				text: (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join(""),
			}));

	const writeFileCalls = (files: Record<string, string>) =>
		Object.entries(files).map(([path, content]) => fauxToolCall("write", { path, content }));

	// 1. coder 成员模拟
	const coder = fauxProvider({ provider: memberProvider("coder"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(coder.provider);
	let coderTriedScopeEscape = false;
	coder.setResponses(
		Array.from({ length: 16 }, () => (ctx: any) => {
			const res = toolResults(ctx);
			// Tier 3：首轮故意尝试修改 test/，验证 lemma-adaptive 下 scope 路径契约会实时拦截
			if (task.tier === 3 && arm === "lemma-adaptive" && !coderTriedScopeEscape && !res.length && task.testPath) {
				coderTriedScopeEscape = true;
				return fauxAssistantMessage(
					[fauxToolCall("write", { path: task.testPath, content: "// attempted tamper\n" })],
					{ stopReason: "toolUse" },
				);
			}
			// Tier 2：首轮先交付带隐藏缺陷的初稿；若在盲审返工后进入第二轮则交付修复版
			if (task.tier === 2 && task.reference.buggyFirstDraft) {
				const userMsgs = ctx.messages.filter((m: any) => m.role === "user");
				const isRework = userMsgs.length >= 2;
				const okWrites = res.filter((r: any) => r.name === "write" && !r.isError).length;
				if (isRework) {
					if (okWrites < 2) return fauxAssistantMessage(writeFileCalls(task.reference.files), { stopReason: "toolUse" });
					return fauxAssistantMessage(fauxText("已按盲审意见修复边界缺陷。"));
				}
				if (okWrites < 1) {
					return fauxAssistantMessage(writeFileCalls(task.reference.buggyFirstDraft), { stopReason: "toolUse" });
				}
				return fauxAssistantMessage(fauxText("已完成初步实现。"));
			}
			// Tier 1 & Tier 3 正常写参考实现
			if (!res.some((r: any) => r.name === "write" && !r.isError)) {
				return fauxAssistantMessage(writeFileCalls(task.reference.files), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(fauxText(`已完成 ${task.implPath} 的修改。`));
		}),
	);

	// 2. tester 成员模拟（Tier 3 专用）
	const tester = fauxProvider({ provider: memberProvider("tester"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(tester.provider);
	tester.setResponses(
		Array.from({ length: 10 }, () => (ctx: any) => {
			const res = toolResults(ctx);
			if (!res.some((r: any) => r.name === "write" && !r.isError) && task.reference.testFiles) {
				return fauxAssistantMessage(writeFileCalls(task.reference.testFiles), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(fauxText(`已编写独立测试 ${task.testPath ?? ""}。`));
		}),
	);

	// 3. auditor 盲审成员模拟（Tier 2 专用）
	const auditor = fauxProvider({ provider: memberProvider("auditor"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(auditor.provider);
	let auditCount = 0;
	auditor.setResponses(
		Array.from({ length: 10 }, () => (ctx: any) => {
			const res = toolResults(ctx);
			const diffRes = res.findLast((r: any) => r.name === "git_diff");
			if (!diffRes) {
				return fauxAssistantMessage([fauxToolCall("git_diff", {})], { stopReason: "toolUse" });
			}
			const userMsgs = ctx.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join(""))).join("\n");
			const rid = userMsgs.match(/result_id"\s*:\s*"([^"]+)"/)?.[1] ?? userMsgs.match(/result_id="([^"]+)"/)?.[1] ?? "unknown";
			auditCount++;
			if (auditCount === 1) {
				return fauxAssistantMessage(
					fauxText(JSON.stringify({ verdict: "rework", result_id: rid, evidence: "盲审 git_diff 发现隐藏边界缺陷（未处理高基数清理/预发布规则/引号转义），请修复后重交。" })),
				);
			}
			return fauxAssistantMessage(
				fauxText(JSON.stringify({ verdict: "accept", result_id: rid, evidence: "盲审 git_diff 确认全部边界条件已修复。" })),
			);
		}),
	);

	// 4. 总控模拟（根据 arm 与 tier 驱动对应编排路径）
	ctrl.setResponses(
		Array.from({ length: 30 }, () => (ctx: any) => {
			const res = toolResults(ctx);
			const call = (name: string, args: any) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

			if (arm === "single") {
				if (!res.some((r: any) => r.name === "write" && !r.isError)) {
					const files = task.tier === 2 && task.reference.buggyFirstDraft
						? task.reference.buggyFirstDraft
						: { ...task.reference.files, ...(task.reference.testFiles ?? {}) };
					return fauxAssistantMessage(writeFileCalls(files), { stopReason: "toolUse" });
				}
				return fauxAssistantMessage(fauxText("单 Agent 已完成修改。"));
			}

			if (task.tier === 1 && arm === "ablation-no-fastpath") {
				if (!res.some((r: any) => r.name === "plan_tasks")) {
					return call("plan_tasks", { tasks: [{ title: task.title, role: "编码", acceptance: "通过全部隐藏边界测试" }] });
				}
				const asked = res.find((r: any) => r.name === "ask_coder");
				if (!asked) return call("ask_coder", { task: task.prompt, task_id: "T1" });
				const rid = asked.text.match(/result_id:\s*([^\s|\]]+)/)?.[1] ?? "";
				if (!res.some((r: any) => r.name === "review_task")) {
					return call("review_task", { id: "T1", action: "accept", result_id: rid, evidence: "单文件改动已验收" });
				}
				return fauxAssistantMessage(fauxText("已按标准流程完成并验收 T1。"));
			}

			if (task.tier === 2 && arm === "lemma-adaptive") {
				if (!res.some((r: any) => r.name === "plan_tasks")) {
					return call("plan_tasks", {
						tasks: [{
							title: task.title,
							role: "编码",
							acceptance: "严格满足需求契约与全部隐藏边界条件",
							automation: { member: "coder", maxReworks: 2 },
							reviewer: { member: "auditor", blind: true },
						}],
					});
				}
				return fauxAssistantMessage(fauxText("已建任务并启用异构盲审自动推进。"));
			}

			if (task.tier === 2 && arm === "ablation-no-blind") {
				const asked = res.find((r: any) => r.name === "ask_coder");
				if (!asked) return call("ask_coder", { task: task.prompt });
				return fauxAssistantMessage(fauxText("已完成实现（无盲审消融组）。"));
			}

			if (task.tier === 3) {
				const useScope = arm === "lemma-adaptive";
				if (!res.some((r: any) => r.name === "plan_tasks")) {
					return call("plan_tasks", {
						tasks: [
							{
								title: `实现 ${task.implPath}`,
								role: "编码",
								acceptance: `正确实现 ${task.implPath}`,
								...(useScope ? { scope: { allow: ["src/"], forbid: ["test/"] } } : {}),
							},
							{
								title: `编写测试 ${task.testPath}`,
								role: "测试",
								acceptance: `在 ${task.testPath} 编写独立单元测试`,
								...(useScope ? { scope: { allow: ["test/"], forbid: ["src/"] } } : {}),
							},
						],
					});
				}
				const coderRes = res.find((r: any) => r.name === "ask_coder");
				const testerRes = res.find((r: any) => r.name === "ask_tester");
				if (!coderRes && !testerRes) {
					return fauxAssistantMessage([
						fauxToolCall("ask_coder", { task: `仅修改 ${task.implPath}：${task.prompt}`, task_id: "T1" }),
						fauxToolCall("ask_tester", { task: `仅修改 ${task.testPath}：编写独立单元测试`, task_id: "T2" }),
					], { stopReason: "toolUse" });
				}
				const rid1 = coderRes?.text.match(/result_id:\s*([^\s|\]]+)/)?.[1];
				const rid2 = testerRes?.text.match(/result_id:\s*([^\s|\]]+)/)?.[1];
				const acceptedT1 = res.some((r: any) => r.name === "review_task" && r.text.includes('"task":"T1"'));
				const acceptedT2 = res.some((r: any) => r.name === "review_task" && r.text.includes('"task":"T2"'));
				if (rid1 && rid2 && (!acceptedT1 || !acceptedT2)) {
					return fauxAssistantMessage([
						fauxToolCall("review_task", { id: "T1", action: "accept", result_id: rid1, evidence: "实现代码已交付" }),
						fauxToolCall("review_task", { id: "T2", action: "accept", result_id: rid2, evidence: "独立测试已交付" }),
					], { stopReason: "toolUse" });
				}
				const c1 = coderRes?.text.match(/改动 #([a-f0-9]+)/)?.[1];
				const c2 = testerRes?.text.match(/改动 #([a-f0-9]+)/)?.[1];
				const intRes = res.find((r: any) => r.name === "integrate_changes");
				if (!intRes && c1 && c2) {
					return call("integrate_changes", { changes: [c1, c2] });
				}
				const intId = intRes?.text.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? intRes?.text.match(/#([a-f0-9]+)/)?.[1];
				if (intId && !res.some((r: any) => r.name === "read_integration")) {
					return call("read_integration", { id: intId, wait: true });
				}
				return fauxAssistantMessage(fauxText("多分支并行实现与联合集成已完成。"));
			}

			return fauxAssistantMessage(fauxText("完成。"));
		}),
	);

	return { models, ref: { provider: "bench-ctrl", modelId: "fixture" } };
}

export async function runTieredCodingBenchmark(options: {
	base: AppConfig;
	runtime?: (task: CodingBenchmarkTask, arm: BenchmarkArm) => { models: MutableModels; ref: { provider: string; modelId: string } };
	simulated: boolean;
	tiers?: BenchmarkTier[];
	arms?: BenchmarkArm[];
	repeats?: number;
	onRun?: (run: TieredCodingRun) => void;
	signal?: AbortSignal;
}): Promise<TieredCodingRun[]> {
	const repeats = options.repeats ?? 1;
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("repeats 需为 1–5 的整数。");
	const key = options.simulated ? "local-fixture-only" : resolveOrchestratorKey(options.base.orchestrator);
	if (!key) throw new Error("真实编码基准缺少总控凭据，请先 /setup。");
	const keyEnv = "LEMMA_CODING_BENCH_KEY";
	const oldKey = process.env[keyEnv];
	process.env[keyEnv] = key;

	const selectedTasks = CODING_BENCHMARK_TASKS.filter((t) => !options.tiers?.length || options.tiers.includes(t.tier));
	const runs: TieredCodingRun[] = [];

	try {
		for (const task of selectedTasks) {
			const armsForTask = options.arms?.length
				? options.arms.filter((a) => defaultArmsForTier(task.tier).includes(a) || a === "single" || a === "lemma-adaptive")
				: defaultArmsForTier(task.tier);

			for (let repeat = 0; repeat < repeats; repeat++) {
				for (const arm of armsForTask) {
					options.signal?.throwIfAborted();
					const repo = initTaskRepo(task);
					let requests = 0;
					let scopeViolationsCaught = 0;
					const observations: Usage[] = [];
					const pending: Promise<void>[] = [];
					let app: Awaited<ReturnType<typeof openApp>> | undefined;
					const started = performance.now();
					let error: string | undefined;
					let usedFastPath = false;
					let blindReviewCaught = 0;
					let integrationPassed = false;

					try {
						const runtime = options.runtime
							? options.runtime(task, arm)
							: localTieredCodingRuntime(task, arm);
						const models = new Proxy(runtime.models, {
							get(target, prop) {
								if (prop === "streamSimple") {
									return (model: any, input: any, settings: any) => {
										if (requests >= 36) throw new Error("该样本达到 36 次模型请求上限");
										requests++;
										const stream = target.streamSimple(model, input, { ...settings, maxTokens: 2048, temperature: 0, maxRetries: 0 });
										pending.push(
											stream.result().then((msg) => {
												observations.push(msg.usage);
												const errToolMsgs = (input?.messages ?? []).filter((m: any) => m.role === "toolResult" && m.isError);
												if (errToolMsgs.some((m: any) => /路径契约|越界|scope/i.test(JSON.stringify(m.content ?? "")))) {
													scopeViolationsCaught = Math.max(scopeViolationsCaught, 1);
												}
											}, () => {}),
										);
										return stream;
									};
								}
								const v = Reflect.get(target, prop);
								return typeof v === "function" ? v.bind(target) : v;
							},
						});

						const o = options.base.orchestrator;
						const baseUrl = options.simulated
							? "http://fixture.invalid"
							: runtime.models.getModel(runtime.ref.provider, runtime.ref.modelId)?.baseUrl ?? "http://fixture.invalid";
						const apiType = o.type === "anthropic-compatible" ? "anthropic-compatible" as const : "openai-compatible" as const;
						const makeMember = (desc: string, tools: ("read" | "write" | "edit" | "bash")[], bash: "allowlist" | "off") => ({
							enabled: true,
							description: desc,
							workspace: "code" as const,
							extraArgs: [],
							models: [{ id: runtime.ref.modelId, tier: "standard" as const, ...(o.price ? { price: o.price } : {}) }],
							defaultModel: runtime.ref.modelId,
							timeoutMinutes: 2,
							maxOutputChars: 8000,
							api: {
								type: apiType,
								baseUrl,
								apiKeyEnv: [keyEnv],
								tools,
								bash,
								bashAllow: bash === "off" ? [] : ["node"],
								maxTurns: 10,
							},
						});

						const checks = task.tier === 3
							? [{ name: "node-test", command: "node", args: ["--test", task.testPath ?? "test/"], timeoutSeconds: 20 }]
							: [];
						const config = normalizeConfig({
							workdir: repo,
							storage: join(repo, ".lemma-bench.sqlite"),
							orchestrator: { ...o, maxTurns: 18 },
							isolation: { enabled: arm !== "single", linkDirs: [] },
							autonomy: { enabled: false, checks, maxRepairAttempts: 0, resultMaxChars: 4000 },
							budget: { perRunUsd: options.simulated ? null : options.base.budget.perRunUsd },
							lead: { enabled: false },
							web: { enabled: false, port: 0 },
							roles: [
								{ name: "编码", agent: "coder", note: "实现功能代码" },
								...(task.tier === 3 ? [{ name: "测试", agent: "tester", note: "编写独立单元测试" }] : []),
								...(task.tier === 2 && arm === "lemma-adaptive" ? [{ name: "审查", agent: "auditor", note: "独立只读代码盲审" }] : []),
							],
							agents: {
								...Object.fromEntries(["claude", "codex", "gemini", "deepseek"].map((id) => [id, { enabled: false }])),
								coder: makeMember("负责编写和修复实现代码", ["read", "write", "edit", "bash"], "allowlist"),
								...(task.tier === 3 ? { tester: makeMember("负责编写独立测试", ["read", "write", "edit", "bash"], "allowlist") } : {}),
								...(task.tier === 2 && arm === "lemma-adaptive" ? { auditor: makeMember("只读代码盲审成员", ["read"], "off") } : {}),
							},
						} as Partial<AppConfig>);

						const simulatedProviders = options.simulated
							? ["coder", "tester", "auditor"].map((id) => runtime.models.getProvider(memberProvider(id))).filter((p) => p !== undefined)
							: [];

						const singleExt = arm === "single"
							? createMemberTools("single", config.agents.coder.api!, { workspace: "code" })
							: undefined;

						app = await openApp(config, { models, ref: runtime.ref }, BACKGROUND_CONTEXT, {
							memory: true,
							extensions: singleExt ? [singleExt] : [],
							settings: {
								retry: { enabled: false, maxRetries: 0 },
								stream: { timeoutMs: 45_000, maxRetries: 0, cacheRetention: "none" },
								compaction: { enabled: false },
								afterFailedRun: "keep",
							},
						});
						for (const provider of simulatedProviders) models.setProvider(provider);
						await app.root.configure({ compaction: { enabled: false } }, BACKGROUND_CONTEXT);
						if (singleExt) {
							await app.root.configure({ extensions: [singleExt], cwd: repo }, BACKGROUND_CONTEXT);
						}

						const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(options.signal ? [options.signal] : [])]);
						const runCtx = withAbortSignal(signal, BACKGROUND_CONTEXT);

						if (task.tier === 1 && arm === "lemma-adaptive") {
							usedFastPath = true;
							const fast = await app.fastDispatch(app.root.id, task.prompt, { member: "coder", autoConfirmApply: false, signal });
							if (fast.result.isError) error = fast.result.text;
							if (fast.changeId) {
								const applied = await applyChange(app.changes, fast.changeId);
								if (!applied.ok) error = applied.message;
							}
						} else {
							let prompt = task.prompt;
							if (arm === "single") {
								prompt = `${task.prompt}\n请直接在本仓库修改文件完成任务，不要委派给其他成员。`;
							} else if (task.tier === 1 && arm === "ablation-no-fastpath") {
								prompt = `${task.prompt}\n请严格按标准多步流程执行：先用 plan_tasks 建立任务 T1，再派 ask_coder 完成 T1，最后用 review_task 验收后汇报。`;
							} else if (task.tier === 2 && arm === "lemma-adaptive") {
								prompt = `${task.prompt}\n请用 plan_tasks 建立 T1，声明 automation:{member:"coder",maxReworks:2} 与 reviewer:{member:"auditor",blind:true}，由 Durable 自动推进实现与代码盲审返工。`;
							} else if (task.tier === 2 && arm === "ablation-no-blind") {
								prompt = `${task.prompt}\n直接用 ask_coder 完成，不启用独立盲审。`;
							} else if (task.tier === 3) {
								prompt = arm === "lemma-adaptive"
									? `${task.prompt}\n请用 plan_tasks 建立 T1（scope:{allow:["src/"],forbid:["test/"]}）与 T2（scope:{allow:["test/"],forbid:["src/"]}），并行派 ask_coder 和 ask_tester，完成后用 integrate_changes 与 read_integration(wait:true) 联合集成验证。`
									: `${task.prompt}\n请用 plan_tasks 建立 T1 与 T2（不设置 scope 路径契约），并行派 ask_coder 和 ask_tester，完成后用 integrate_changes 与 read_integration(wait:true) 联合集成验证。`;
							}

							const submission = await app.root.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
							await submission.wait(runCtx);

							// Tier 2 自动盲审链路需要等待 Durable workflow 收尾
							if (task.tier === 2 && arm === "lemma-adaptive") {
								const deadline = Date.now() + 30_000;
								while (Date.now() < deadline) {
									const board = await app.harness.snapshot(Board, BACKGROUND_CONTEXT);
									const t1 = board?.tasks?.T1;
									if (t1 && (t1.status === "done" || t1.status === "blocked")) break;
									await new Promise((r) => setTimeout(r, 80));
								}
								const board = await app.harness.snapshot(Board, BACKGROUND_CONTEXT);
								const checksByMember = board?.tasks?.T1?.checksByMember ?? [];
								blindReviewCaught = checksByMember.filter((c) => c.status === "rework" || c.status === "blocked").length;
							}

							// 把最终有效改动应用到基准仓库以运行隐藏测试
							if (arm !== "single") {
								const allChanges = app.changes.list();
								const intChange = allChanges.find((c) => c.integration && c.integration.status === "passed");
								if (intChange) {
									integrationPassed = true;
									const applied = await applyChange(app.changes, intChange.id);
									if (!applied.ok) error = applied.message;
								} else {
									const latest = [...allChanges].reverse().find((c) => !c.integration && c.files.length > 0 && c.status !== "dropped");
									if (latest) {
										const applied = await applyChange(app.changes, latest.id);
										if (!applied.ok) error = applied.message;
									}
								}
							}
						}
					} catch (failure) {
						error = failure instanceof Error ? failure.message : String(failure);
						await app?.root.abort(BACKGROUND_CONTEXT).catch(() => {});
					}

					await Promise.all(pending);
					const hidden = runHiddenTests(repo, task.hiddenTest);
					const measured = !options.simulated && requests > 0 && observations.length === requests && observations.every((v) => v.totalTokens > 0);
					const providerPriced = measured && observations.every((v) => v.cost.totalFromProvider);
					const usage = measured
						? observations.reduce(
								(acc, v) => ({
									input: acc.input + v.input,
									output: acc.output + v.output,
									cacheRead: acc.cacheRead + v.cacheRead,
									cacheWrite: acc.cacheWrite + v.cacheWrite,
									totalTokens: acc.totalTokens + v.totalTokens,
								}),
								{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
							)
						: null;
					const costUsd = measured && (!!options.base.orchestrator.price || providerPriced)
						? observations.reduce((sum, v) => sum + v.cost.total, 0)
						: null;

					const run: TieredCodingRun = {
						taskId: task.id,
						tier: task.tier,
						title: task.title,
						arm,
						repeat,
						success: !error && hidden.ok,
						hiddenPassed: hidden.passed,
						hiddenTotal: hidden.total,
						durationMs: Math.round(performance.now() - started),
						requests,
						tokens: usage?.totalTokens ?? null,
						usage,
						costUsd,
						costSource: costUsd === null ? "unavailable" : providerPriced ? "provider" : "configured-estimate",
						usedFastPath,
						blindReviewCaught,
						scopeViolationsCaught,
						integrationPassed,
						...(error ? { error } : hidden.ok ? {} : { error: `隐藏测试未全过 (${hidden.passed}/${hidden.total})` }),
					};
					runs.push(run);
					options.onRun?.(run);

					try { await app?.harness.close(BACKGROUND_CONTEXT); } catch {}
					try { rmSync(repo, { recursive: true, force: true }); } catch {}
				}
			}
		}
		return runs;
	} finally {
		if (oldKey === undefined) delete process.env[keyEnv];
		else process.env[keyEnv] = oldKey;
	}
}

export function renderCodingBenchmarkReport(
	meta: { revision: string; dirty: boolean; simulated: boolean; model: string; repeats: number },
	runs: TieredCodingRun[],
): string {
	const fmtPct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : "—");
	const fmtAvg = (vals: number[]) => (vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "—");
	const fmtTokens = (items: TieredCodingRun[]) =>
		items.length && items.every((r) => r.tokens !== null)
			? String(items.reduce((s, r) => s + r.tokens!, 0))
			: "未测量";
	const fmtCost = (items: TieredCodingRun[]) =>
		items.length && items.every((r) => r.costUsd !== null)
			? `$${items.reduce((s, r) => s + r.costUsd!, 0).toFixed(4)}`
			: "未测量";

	const arms = [...new Set(runs.map((r) => r.arm))];
	const summaryRows = arms.map((arm) => {
		const list = runs.filter((r) => r.arm === arm);
		const passedTasks = list.filter((r) => r.success).length;
		const hp = list.reduce((s, r) => s + r.hiddenPassed, 0);
		const ht = list.reduce((s, r) => s + r.hiddenTotal, 0);
		return `| \`${arm}\` | ${passedTasks}/${list.length} (${fmtPct(passedTasks, list.length)}) | ${hp}/${ht} (${fmtPct(hp, ht)}) | ${fmtAvg(list.map((r) => r.requests))} | ${Math.round(list.reduce((s, r) => s + r.durationMs, 0) / Math.max(1, list.length))}ms | ${fmtTokens(list)} | ${fmtCost(list)} |`;
	});

	const tierSections: string[] = [];
	for (const tier of [1, 2, 3] as const) {
		const tRuns = runs.filter((r) => r.tier === tier);
		if (!tRuns.length) continue;
		const tierName = tier === 1 ? "Tier 1 · 单文件小改（Fast Path 效率验证）" : tier === 2 ? "Tier 2 · 核心算法隐藏边界（异构盲审价值验证）" : "Tier 3 · 多模块并行开发（路径契约与联合集成验证）";
		const tArms = [...new Set(tRuns.map((r) => r.arm))];
		const rows = tArms.map((arm) => {
			const list = tRuns.filter((r) => r.arm === arm);
			const ok = list.filter((r) => r.success).length;
			const hp = list.reduce((s, r) => s + r.hiddenPassed, 0);
			const ht = list.reduce((s, r) => s + r.hiddenTotal, 0);
			const extra = tier === 1
				? `快路 ${list.filter((r) => r.usedFastPath).length}/${list.length}`
				: tier === 2
					? `盲审拦截返工 ${list.reduce((s, r) => s + r.blindReviewCaught, 0)} 次`
					: `契约拦截 ${list.reduce((s, r) => s + r.scopeViolationsCaught, 0)} 次 · 集成通过 ${list.filter((r) => r.integrationPassed).length}/${list.length}`;
			return `| \`${arm}\` | ${ok}/${list.length} | ${hp}/${ht} (${fmtPct(hp, ht)}) | ${fmtAvg(list.map((r) => r.requests))} | ${Math.round(list.reduce((s, r) => s + r.durationMs, 0) / Math.max(1, list.length))}ms | ${extra} |`;
		});
		tierSections.push(
			`### ${tierName}`,
			"",
			"| 实验臂 | 任务通过 | 隐藏用例通过 | 平均模型请求 | 平均耗时 | 机制观测 |",
			"|---|---:|---:|---:|---:|---|",
			...rows,
			"",
		);
	}

	const detailRows = runs.map((r) =>
		`| T${r.tier} | \`${r.taskId}\` | \`${r.arm}\` | ${r.success ? "PASS" : "FAIL"} | ${r.hiddenPassed}/${r.hiddenTotal} | ${r.requests} | ${r.durationMs}ms | ${r.error ? r.error.replace(/\|/g, "/").slice(0, 70) : "—"} |`,
	);

	return [
		"# Lemma P1 分层编码基准与消融实验报告",
		"",
		`- **代码版本**：\`${meta.revision}\`${meta.dirty ? "（工作区含未提交变更）" : ""}`,
		`- **运行模式**：${meta.simulated ? "离线确定性模拟（验证评测链路与机制生效，不作为真实模型能力结论）" : `真实模型评测（\`${meta.model}\`，repeats=${meta.repeats}）`}`,
		`- **样本总量**：${runs.length} 次运行`,
		"",
		"## 总体对比",
		"",
		"| 实验臂 | 任务通过率 | 隐藏用例通过率 | 平均模型请求 | 平均耗时 | 总 Token | 美元费用 |",
		"|---|---:|---:|---:|---:|---:|---:|",
		...summaryRows,
		"",
		"## 分层对照与消融结果",
		"",
		...tierSections,
		"## 逐题明细",
		"",
		"| 层级 | 任务 | 实验臂 | 结果 | 隐藏用例 | 请求数 | 耗时 | 备注 |",
		"|---|---|---|---|---:|---:|---:|---|",
		...detailRows,
		"",
	].join("\n");
}
