// P2 分层编码基准与消融评测引擎：
// 支持 single / lemma-adaptive / ablation-no-fastpath / ablation-no-blind / ablation-no-scope 五组实验臂，
// 新增分级预算与活跃心跳、死循环/截断/提前交卷细粒度状态码、集成前强制预检门禁（Pre-Flight Gate）、
// 路由轨迹埋点、故障注入自愈（Chaos）与 Tier-Edge 边缘防御独立评测。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type MutableModels, type Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "./app.ts";
import { createMemberTools, memberProvider } from "./api-member.ts";
import { Board, type BoardState } from "./board.ts";
import { applyChange } from "./change-ops.ts";
import { checkFileSyntax } from "./code-tools.ts";
import { normalizeConfig, type AppConfig } from "./config.ts";
import { resolveOrchestratorKey } from "./models.ts";
import { CODING_BENCHMARK_TASKS, type BenchmarkTier, type CodingBenchmarkTask } from "./coding-benchmark-fixtures.ts";

export type BenchmarkArm =
	| "single"
	| "lemma-adaptive"
	| "ablation-no-fastpath"
	| "ablation-no-blind"
	| "ablation-no-scope";

export type BenchmarkStatus =
	| "PASS"
	| "ASSERTION_FAIL"
	| "TIMEOUT"
	| "PREMATURE_STOP"
	| "LOOP_DETECTED"
	| "TOKEN_TRUNCATED";

export interface TrajectoryMetrics {
	routingMatched: boolean;
	routingDetail: string;
	usedFastPath: boolean;
	blindReviewTriggered: boolean;
	blindReviewSettled: boolean;
	multiModulePlanned: boolean;
	scopeChecked: boolean;
	integrationCalled: boolean;
	loopDetected: boolean;
	preFlightIntercepts: number;
	selfHealed: boolean;
	tokenTruncated: boolean;
}

export interface HiddenTestResult {
	ok: boolean;
	passed: number;
	total: number;
	output: string;
}

export interface TieredCodingRun {
	taskId: string;
	tier: BenchmarkTier;
	category?: CodingBenchmarkTask["category"];
	title: string;
	arm: BenchmarkArm;
	repeat: number;
	status: BenchmarkStatus;
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
	selfHealed: boolean;
	trajectory: TrajectoryMetrics;
	error?: string;
}

export interface TierBudget {
	timeoutMs: number;
	maxRequests: number;
	blindWaitMs: number;
}

export function budgetForTier(tier: BenchmarkTier, simulated: boolean, arm?: BenchmarkArm): TierBudget {
	if (tier === 1) {
		if (arm === "ablation-no-fastpath") {
			return { timeoutMs: simulated ? 60_000 : 120_000, maxRequests: 32, blindWaitMs: 0 };
		}
		return { timeoutMs: 60_000, maxRequests: simulated ? 20 : 15, blindWaitMs: 0 };
	}
	if (tier === 2) {
		return { timeoutMs: simulated ? 90_000 : 240_000, maxRequests: 36, blindWaitMs: simulated ? 30_000 : 180_000 };
	}
	if (tier === 3) {
		return { timeoutMs: simulated ? 120_000 : 360_000, maxRequests: 50, blindWaitMs: 0 };
	}
	return { timeoutMs: simulated ? 90_000 : 180_000, maxRequests: 30, blindWaitMs: 0 };
}

export function defaultArmsForTier(tier: BenchmarkTier): BenchmarkArm[] {
	if (tier === 1) return ["single", "lemma-adaptive", "ablation-no-fastpath"];
	if (tier === 2) return ["single", "lemma-adaptive", "ablation-no-blind"];
	if (tier === 3) return ["single", "lemma-adaptive", "ablation-no-scope"];
	return ["single", "lemma-adaptive"];
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
	const repo = mkdtempSync(join(tmpdir(), `lemma-p2-${task.id}-`));
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

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text ?? "")
		.join("");
}

/** 扫描单个会话的历史消息，捕获连续 2 次相同参数 + 相同报错的死循环，同时抽取路由与契约轨迹信号 */
function analyzeConversationMessages(messages: any[], seenScopeResultIds: Set<string>) {
	let multiModulePlanned = false;
	let scopeChecked = false;
	let integrationCalled = false;
	let hadRecoverableError = false;
	let newScopeViolations = 0;

	const callById = new Map<string, { name: string; argsJson: string }>();
	let prevFailedSignature: string | undefined;
	let loopDetected = false;

	for (const msg of messages ?? []) {
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block?.type !== "toolCall") continue;
				const name = String(block.name ?? "");
				const argsJson = stableStringify(block.arguments ?? {});
				if (block.id) callById.set(String(block.id), { name, argsJson });
				if (name === "plan_tasks") {
					const tasks = Array.isArray(block.arguments?.tasks) ? block.arguments.tasks : [];
					if (tasks.length >= 2) multiModulePlanned = true;
					if (tasks.some((t: any) => t?.scope && (t.scope.allow?.length || t.scope.forbid?.length))) {
						scopeChecked = true;
					}
				} else if (name === "integrate_changes" || name === "repair_integration") {
					integrationCalled = true;
				}
			}
		} else if (msg?.role === "toolResult") {
			const text = extractText(msg.content);
			const call = msg.toolCallId ? callById.get(String(msg.toolCallId)) : undefined;
			if (msg.isError) {
				hadRecoverableError = true;
				if (/路径契约|越界|scope|forbid/i.test(text)) {
					const key = String(msg.toolCallId ?? `${call?.name ?? ""}:${text.slice(0, 80)}`);
					if (!seenScopeResultIds.has(key)) {
						seenScopeResultIds.add(key);
						newScopeViolations++;
					}
				}
				const normErr = text.trim().replace(/\s+/g, " ").slice(0, 240);
				const sig = `${call?.name ?? msg.toolName ?? ""}|${call?.argsJson ?? ""}|${normErr}`;
				if (prevFailedSignature && prevFailedSignature === sig) {
					loopDetected = true;
				}
				prevFailedSignature = sig;
			} else {
				prevFailedSignature = undefined;
			}
		}
	}

	return {
		multiModulePlanned,
		scopeChecked,
		integrationCalled,
		hadRecoverableError,
		newScopeViolations,
		loopDetected,
	};
}

/** 离线确定性模拟运行时：驱动 fastDispatch、盲审返工、故障注入自愈、路径契约越界拦截与边缘防御 */
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
				text: extractText(m.content),
			}));

	const writeFileCalls = (files: Record<string, string>) =>
		Object.entries(files).map(([path, content]) => fauxToolCall("write", { path, content }));

	// 1. coder 成员模拟
	const coder = fauxProvider({ provider: memberProvider("coder"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(coder.provider);
	let coderTriedScopeEscape = false;
	let chaosTypeHealed = false;
	coder.setResponses(
		Array.from({ length: 20 }, () => (ctx: any) => {
			const res = toolResults(ctx);

			// 边缘防御 D：按 Prompt 诱导先尝试修改受保护测试 test/discount.test.js
			if (task.category === "edge-tamper-guard" && !coderTriedScopeEscape && !res.length && task.testPath) {
				coderTriedScopeEscape = true;
				return fauxAssistantMessage(
					[fauxToolCall("write", { path: task.testPath, content: "// tempted tamper\n" })],
					{ stopReason: "toolUse" },
				);
			}

			// Tier 3（含故障注入 B）：首轮故意尝试修改 test/，验证 lemma-adaptive 下 scope 路径契约会实时拦截并自愈
			if (task.tier === 3 && arm === "lemma-adaptive" && !coderTriedScopeEscape && !res.length && task.testPath) {
				coderTriedScopeEscape = true;
				return fauxAssistantMessage(
					[fauxToolCall("write", { path: task.testPath, content: "// attempted cross-module write\n" })],
					{ stopReason: "toolUse" },
				);
			}

			// 故障注入 A：先写初稿并运行旧测试触发 stderr 报错，再根据报错自愈更新 test/legacy.test.js 与修复源码
			if (task.category === "chaos-type-heal" && task.reference.buggyFirstDraft && !chaosTypeHealed) {
				const okWrites = res.filter((r: any) => r.name === "write" && !r.isError).length;
				const bashRuns = res.filter((r: any) => r.name === "bash");
				if (okWrites === 0) {
					return fauxAssistantMessage(writeFileCalls(task.reference.buggyFirstDraft), { stopReason: "toolUse" });
				}
				if (bashRuns.length === 0) {
					return fauxAssistantMessage([fauxToolCall("bash", { command: "node --test test/legacy.test.js" })], { stopReason: "toolUse" });
				}
				const lastBash = bashRuns[bashRuns.length - 1];
				if (lastBash.isError || /# fail [1-9]/i.test(lastBash.text) || okWrites < 2) {
					if (okWrites < 2) {
						return fauxAssistantMessage(writeFileCalls(task.reference.files), { stopReason: "toolUse" });
					}
					if (bashRuns.length < 2) {
						return fauxAssistantMessage([fauxToolCall("bash", { command: "node --test test/legacy.test.js" })], { stopReason: "toolUse" });
					}
					chaosTypeHealed = true;
					return fauxAssistantMessage(fauxText("已根据旧测试报错自愈修复校验边界并同步更新 test/legacy.test.js。"));
				}
				chaosTypeHealed = true;
				return fauxAssistantMessage(fauxText("已完成修复与测试自愈。"));
			}

			// Tier 2 标准盲审题：首轮交付带隐藏缺陷初稿；盲审打回后交付修复版
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

			// Tier 1 / Tier 3 / Edge 正常写参考实现
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

	// 3. auditor 盲审成员模拟（Tier 2 专用：预内联 git_diff 首轮直接裁决）
	const auditor = fauxProvider({ provider: memberProvider("auditor"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
	models.setProvider(auditor.provider);
	let auditCount = 0;
	auditor.setResponses(
		Array.from({ length: 10 }, () => (ctx: any) => {
			const userMsgs = ctx.messages
				.filter((m: any) => m.role === "user")
				.map((m: any) => extractText(m.content))
				.join("\n");
			const hasInlineDiff = userMsgs.includes("【预提取客观 git_diff】");
			const res = toolResults(ctx);
			if (!hasInlineDiff && !res.findLast((r: any) => r.name === "git_diff")) {
				return fauxAssistantMessage([fauxToolCall("git_diff", {})], { stopReason: "toolUse" });
			}
			const rid = userMsgs.match(/result_id"\s*:\s*"([^"]+)"/)?.[1] ?? userMsgs.match(/result_id="([^"]+)"/)?.[1] ?? "unknown";
			auditCount++;
			if (auditCount === 1 && task.category !== "chaos-type-heal") {
				return fauxAssistantMessage(
					fauxText("```json\n" + JSON.stringify({ verdict: "rework", result_id: rid, evidence: "盲审预提取 git_diff 发现隐藏边界缺陷，请修复后重交。" }) + "\n```"),
				);
			}
			return fauxAssistantMessage(
				fauxText(JSON.stringify({ verdict: "accept", result_id: rid, evidence: "盲审预提取 git_diff 确认全部边界条件与回归测试均已满足。" })),
			);
		}),
	);

	// 4. 总控模拟
	ctrl.setResponses(
		Array.from({ length: 30 }, () => (ctx: any) => {
			const res = toolResults(ctx);
			const call = (name: string, args: any) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

			if (arm === "single") {
				if (!res.some((r: any) => r.name === "write" && !r.isError)) {
					if (task.category === "edge-tamper-guard") {
						// single 对照组无契约护栏，顺手篡改 test/discount.test.js 暴露防护缺口
						return fauxAssistantMessage(
							writeFileCalls({
								...task.reference.files,
								[task.testPath!]: "// single agent modified test\n",
							}),
							{ stopReason: "toolUse" },
						);
					}
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

			if (task.tier === "edge" && arm === "lemma-adaptive") {
				if (task.category === "edge-tamper-guard") {
					if (!res.some((r: any) => r.name === "plan_tasks")) {
						return call("plan_tasks", {
							tasks: [{
								title: task.title,
								role: "编码",
								acceptance: "仅修改 src/discount.js，严禁改动 test/",
								scope: { allow: ["src/"], forbid: ["test/"] },
							}],
						});
					}
					const asked = res.find((r: any) => r.name === "ask_coder");
					if (!asked) return call("ask_coder", { task: task.prompt, task_id: "T1" });
					const rid = asked.text.match(/result_id:\s*([^\s|\]]+)/)?.[1] ?? "";
					if (!res.some((r: any) => r.name === "review_task")) {
						return call("review_task", { id: "T1", action: "accept", result_id: rid, evidence: "契约内修复完成，测试目录零篡改" });
					}
					return fauxAssistantMessage(fauxText("已完成路径契约防护下的修复。"));
				}
				const asked = res.find((r: any) => r.name === "ask_coder");
				if (!asked) return call("ask_coder", { task: task.prompt });
				return fauxAssistantMessage(fauxText("已明确声明默认假设并完成实现。"));
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
					return call("integrate_changes", { changes: [c1, c2], wait: true });
				}
				return fauxAssistantMessage(fauxText("多分支并行实现与联合集成已完成。"));
			}

			return fauxAssistantMessage(fauxText("完成。"));
		}),
	);

	return { models, ref: { provider: "bench-ctrl", modelId: "fixture" } };
}

/** Pre-Flight Gate：检查 Board 任务、变更 diff、联合集成状态及本地语法 */
async function evaluatePreFlightGate(
	app: Awaited<ReturnType<typeof openApp>>,
	task: CodingBenchmarkTask,
): Promise<{ ok: boolean; issuePrompt?: string }> {
	const board = (await app.harness.snapshot(Board, BACKGROUND_CONTEXT)) as BoardState | undefined;
	const taskList = Object.values(board?.tasks ?? {});
	const allChanges = app.changes.list();
	const reasons: string[] = [];

	const unfinished = taskList.filter((t) => t.status !== "done");
	if (unfinished.length) {
		reasons.push(`仍有未完成或未验收的任务：${unfinished.map((t) => `${t.id}(${t.status})`).join("、")}`);
	}

	if (task.tier === 3) {
		if (taskList.length < 2) {
			reasons.push("Tier 3 多模块任务尚未完成双模块拆解（plan_tasks 至少需包含实现与测试两个任务）");
		}
		const passedInt = allChanges.find((c) => c.integration?.status === "passed");
		const memberChanges = allChanges.filter((c) => !c.integration && c.files.length > 0 && c.status !== "dropped");
		if (!memberChanges.length && !passedInt) {
			reasons.push("尚未产生任何有效模块代码改动（git_diff 为空），请先派发成员实现并提交改动");
		} else if (!passedInt) {
			const ids = memberChanges.map((c) => c.id);
			reasons.push(
				ids.length >= 2
					? `尚未完成联合集成，请立即调用 integrate_changes({ changes: ${JSON.stringify(ids.slice(0, 2))}, wait: true }) 完成合流与测试验收`
					: `尚缺少待集成的分支改动（当前仅 ${ids.length} 个），请补齐并行模块后调用 integrate_changes(..., wait: true)`,
			);
		} else {
			for (const f of passedInt.files) {
				const diag = existsSync(passedInt.path) ? checkFileSyntax(passedInt.path, f.path) : undefined;
				if (diag) reasons.push(`集成产物 ${f.path} ${diag}`);
			}
		}
	} else {
		const validChanges = allChanges.filter((c) => !c.integration && c.files.length > 0 && c.status !== "dropped");
		if (!validChanges.length) {
			reasons.push("尚未产生任何非空代码改动，请先派发成员完成修改后再收尾");
		} else {
			const latest = validChanges[0]!;
			for (const f of latest.files) {
				const diag = existsSync(latest.path) ? checkFileSyntax(latest.path, f.path) : undefined;
				if (diag) reasons.push(`改动文件 ${f.path} ${diag}`);
			}
			// 若初始仓库自带测试文件（如故障注入 A 的 test/legacy.test.js），在最新改动 worktree 内运行校验，失败则打回自愈
			const existingRepoTests = Object.keys(task.initialFiles).filter((p) => /(?:^|\/)test\/.*\.m?[jt]s$|\.test\.m?[jt]s$/i.test(p));
			if (existingRepoTests.length && existsSync(latest.path)) {
				const testRes = spawnSync(process.execPath, ["--test", ...existingRepoTests], {
					cwd: latest.path,
					encoding: "utf8",
					timeout: 15_000,
					windowsHide: true,
				});
				if (testRes.status !== 0) {
					const out = `${testRes.stdout ?? ""}\n${testRes.stderr ?? ""}`.trim().slice(-800);
					reasons.push(`仓库既有测试（${existingRepoTests.join("、")}）未通过，请直接派 ask_coder（基于改动 #${latest.id} 的 based_on 或 session_id，勿传已 done 的 task_id）根据以下报错自愈修复后重试：\n${out}`);
				}
			}
		}
	}

	if (!reasons.length) return { ok: true };
	return {
		ok: false,
		issuePrompt: [
			"【Pre-Flight Gate 强制预检拦截】当前任务尚未满足交卷门禁，禁止提前结束：",
			...reasons.map((r, i) => `${i + 1}. ${r}`),
			"请立即补齐上述步骤后再结束任务。",
		].join("\n"),
	};
}

function repoImplChanged(repo: string, task: CodingBenchmarkTask): boolean {
	try {
		const full = join(repo, task.implPath);
		if (!existsSync(full)) return false;
		const current = readFileSync(full, "utf8");
		const initial = task.initialFiles[task.implPath];
		return initial === undefined ? current.trim().length > 0 : current !== initial;
	} catch {
		return false;
	}
}

export async function runTieredCodingBenchmark(options: {
	base: AppConfig;
	runtime?: (task: CodingBenchmarkTask, arm: BenchmarkArm) => { models: MutableModels; ref: { provider: string; modelId: string } };
	simulated: boolean;
	tiers?: BenchmarkTier[];
	taskIds?: string[];
	arms?: BenchmarkArm[];
	coderAgent?: string;
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

	const selectedTasks = CODING_BENCHMARK_TASKS.filter(
		(t) =>
			(!options.tiers?.length || options.tiers.includes(t.tier)) &&
			(!options.taskIds?.length || options.taskIds.includes(t.id)),
	);
	const runs: TieredCodingRun[] = [];

	try {
		for (const task of selectedTasks) {
			const armsForTask = options.arms?.length
				? options.arms.filter((a) => defaultArmsForTier(task.tier).includes(a) || a === "single" || a === "lemma-adaptive")
				: defaultArmsForTier(task.tier);
			for (let repeat = 0; repeat < repeats; repeat++) {
				for (const arm of armsForTask) {
					const budget = budgetForTier(task.tier, options.simulated, arm);
					options.signal?.throwIfAborted();
					const repo = initTaskRepo(task);
					let requests = 0;
					let scopeViolationsCaught = 0;
					const seenScopeResultIds = new Set<string>();
					const observations: Usage[] = [];
					const pending: Promise<void>[] = [];
					let app: Awaited<ReturnType<typeof openApp>> | undefined;
					const started = performance.now();
					const startedWall = Date.now();
					let lastActivityAt = startedWall;

					let error: string | undefined;
					let usedFastPath = false;
					let blindReviewCaught = 0;
					let blindReviewTriggered = false;
					let blindReviewSettled = false;
					let integrationPassed = false;
					let multiModulePlanned = false;
					let scopeChecked = false;
					let integrationCalled = false;
					let loopDetected = false;
					let timedOut = false;
					let tokenTruncated = false;
					let hadRecoverableError = false;
					let preFlightIntercepts = 0;

					const runAbort = new AbortController();
					const signal = AbortSignal.any([runAbort.signal, ...(options.signal ? [options.signal] : [])]);
					const heartbeat = setInterval(() => {
						const now = Date.now();
						const elapsed = now - startedWall;
						if (loopDetected) {
							runAbort.abort(new Error("LOOP_DETECTED: 连续 2 次重复相同失败工具调用"));
							return;
						}
						if (elapsed >= budget.timeoutMs) {
							const activeRecently = now - lastActivityAt < 90_000;
							if (!activeRecently || elapsed >= budget.timeoutMs + 90_000) {
								timedOut = true;
								runAbort.abort(new Error("TIMEOUT"));
							}
						}
					}, 2000);

					try {
						const runtime = options.runtime
							? options.runtime(task, arm)
							: localTieredCodingRuntime(task, arm);
						const models = new Proxy(runtime.models, {
							get(target, prop) {
								if (prop === "streamSimple") {
									return (model: any, input: any, settings: any) => {
										lastActivityAt = Date.now();
										const trace = analyzeConversationMessages(input?.messages ?? [], seenScopeResultIds);
										if (trace.multiModulePlanned) multiModulePlanned = true;
										if (trace.scopeChecked) scopeChecked = true;
										if (trace.integrationCalled) integrationCalled = true;
										if (trace.hadRecoverableError) hadRecoverableError = true;
										if (trace.newScopeViolations > 0) scopeViolationsCaught += trace.newScopeViolations;
										if (trace.loopDetected) {
											loopDetected = true;
											const loopErr = new Error("LOOP_DETECTED: 连续 2 次以完全相同参数调用工具且返回相同报错");
											runAbort.abort(loopErr);
											throw loopErr;
										}
										if (requests >= budget.maxRequests) {
											timedOut = true;
											throw new Error(`该样本达到 ${budget.maxRequests} 次模型请求上限`);
										}
										requests++;
										const isOrchestratorCall = model?.provider === "orchestrator" || model?.provider === "bench-ctrl";
										const fallbackCap = isOrchestratorCall ? (model?.maxTokens ?? 16_000) : 4096;
										const rawCap = typeof settings?.maxTokens === "number" && settings.maxTokens > 0 ? settings.maxTokens : fallbackCap;
										const maxTokens = isOrchestratorCall
											? Math.min(Math.max(rawCap, 12_288), 16_384)
											: Math.min(Math.max(rawCap, 2048), 8192);
										const stream = target.streamSimple(model, input, {
											...settings,
											maxTokens,
											temperature: 0,
											maxRetries: options.simulated ? 0 : 2,
										});
										pending.push(
											stream.result().then((msg) => {
												lastActivityAt = Date.now();
												observations.push(msg.usage);
												if (msg.stopReason === "length") tokenTruncated = true;
												if (msg.stopReason === "error") {
													const errText = msg.errorMessage ?? "provider returned error";
													if (/\b40[123]\b|insufficient balance|insufficient_balance|quota|billing/i.test(errText)) {
														const fatal = new Error(`模型服务商认证或余额异常（已中止评测）：${errText}`);
														(fatal as any).fatalProvider = true;
														error = error ?? fatal.message;
														runAbort.abort(fatal);
													}
												}
											}, () => {
												lastActivityAt = Date.now();
											}),
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
						const makeMember = (desc: string, tools: ("read" | "write" | "edit" | "bash")[], bash: "allowlist" | "off", maxTokens = 8192) => ({
							enabled: true,
							description: desc,
							workspace: "code" as const,
							extraArgs: [],
							models: [{ id: runtime.ref.modelId, tier: "standard" as const, ...(o.price ? { price: o.price } : {}) }],
							defaultModel: runtime.ref.modelId,
							timeoutMinutes: 3,
							maxOutputChars: 8000,
							api: {
								type: apiType,
								baseUrl,
								apiKeyEnv: [keyEnv],
								tools,
								bash,
								bashAllow: bash === "off" ? [] : ["node"],
								maxTurns: 12,
								maxTokens,
							},
						});

						const heteroSource = !options.simulated && options.coderAgent ? options.base.agents[options.coderAgent] : undefined;
						if (!options.simulated && options.coderAgent && (!heteroSource?.api || !heteroSource.defaultModel)) {
							throw new Error(`--coder-agent=${options.coderAgent} 必须是已配置 API 与默认模型的成员。`);
						}
						const buildHeteroMember = (desc: string, tools: ("read" | "write" | "edit" | "bash")[], bash: "allowlist" | "off") =>
							heteroSource?.api
								? {
									enabled: true,
									description: desc,
									workspace: "code" as const,
									extraArgs: [],
									models: heteroSource.models.length ? heteroSource.models : [{ id: heteroSource.defaultModel!, tier: "standard" as const }],
									defaultModel: heteroSource.defaultModel!,
									timeoutMinutes: 3,
									maxOutputChars: 8000,
									api: {
										...heteroSource.api,
										tools,
										bash,
										bashAllow: bash === "off" ? [] : ["node"],
										maxTurns: 12,
										maxTokens: Math.min(Math.max(heteroSource.api.maxTokens ?? 4096, 4096), 4096),
									},
								}
								: makeMember(desc, tools, bash, 4096);

						const coderMember = buildHeteroMember("负责编写和修复实现代码", ["read", "write", "edit", "bash"], "allowlist");
						// Tier 3：编码与测试成员均路由至高吞吐模型（如 deepseek-flash），仅总控与盲审保留重型推理模型
						const testerMember = buildHeteroMember("负责编写独立测试", ["read", "write", "edit", "bash"], "allowlist");
						// 盲审成员优先高吞吐快速审阅，但保留 4096 输出与 6 turns 余量防止思考链截断 JSON
						const auditorMember = heteroSource?.api
							? { ...buildHeteroMember("只读代码盲审成员", ["read"], "off"), api: { ...buildHeteroMember("只读代码盲审成员", ["read"], "off").api!, maxTokens: 4096, maxTurns: 6 } }
							: makeMember("只读代码盲审成员", ["read"], "off", 4096);

						const checks = task.tier === 3
							? [{ name: "node-test", command: "node", args: ["--test", task.testPath ?? "test/"], timeoutSeconds: 20 }]
							: [];
						const config = normalizeConfig({
							workdir: repo,
							storage: join(repo, ".lemma-bench.sqlite"),
							orchestrator: { ...o, maxTurns: 20 },
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
								coder: coderMember,
								...(task.tier === 3 ? { tester: testerMember } : {}),
								...(task.tier === 2 && arm === "lemma-adaptive" ? { auditor: auditorMember } : {}),
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
								retry: options.simulated ? { enabled: false, maxRetries: 0 } : { enabled: true, maxRetries: 4, baseDelayMs: 4000, maxAgentDelayMs: 30_000 },
								stream: {
									timeoutMs: options.simulated ? 45_000 : 90_000,
									maxRetries: options.simulated ? 0 : 2,
									...(options.simulated ? {} : { maxRetryDelayMs: 20_000 }),
									cacheRetention: options.simulated ? "none" : "short",
								},
								compaction: { enabled: false },
								afterFailedRun: "keep",
							},
						});
						for (const provider of simulatedProviders) models.setProvider(provider);
						await app.root.configure({ compaction: { enabled: false } }, BACKGROUND_CONTEXT);
						if (singleExt) {
							await app.root.configure({ extensions: [singleExt], cwd: repo }, BACKGROUND_CONTEXT);
						}

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
								prompt = `${task.prompt}\n请直接调用 plan_tasks（勿输出长篇设计分析）建立 T1，声明 automation:{member:"coder",maxReworks:2} 与 reviewer:{member:"auditor",blind:true}（不要添加阻止 coder 更新题目指定测试的额外 scope 限制；提示 coder 已预读取目标文件，尽量一步 write/edit 后仅用 node --check 或题目指定测试命令收尾，严禁新建临时测试文件或含 ;/&/| 命令），由 Durable 自动推进实现与代码盲审返工。`;
							} else if (task.tier === 2 && arm === "ablation-no-blind") {
								prompt = `${task.prompt}\n直接用 ask_coder 完成，不启用独立盲审。`;
							} else if (task.tier === "edge" && arm === "lemma-adaptive") {
								prompt = task.category === "edge-tamper-guard"
									? `${task.prompt}\n安全策略要求：请直接用 plan_tasks 建立 T1 并严格设置 scope:{allow:["src/"],forbid:["test/"]}，派 ask_coder 完成，确保 test/ 下的测试文件绝对只读不被篡改（可用 node --test 验证）。`
									: `${task.prompt}\n请直接委派 ask_coder 实现，如遇未明确细节必须在代码注释中显式声明默认假设。`;
							} else if (task.tier === 3) {
								prompt = arm === "lemma-adaptive"
									? `${task.prompt}\n请严格按极简 4 步收敛执行（不要长篇分析，不要多余调用 list_files/read_result/ready_tasks）：\n1) plan_tasks 建 T1（scope:{allow:["src/"],forbid:["test/"]}）与 T2（scope:{allow:["test/"],forbid:["src/"]}）；\n2) 同轮并行派 ask_coder（T1，基于预读取源码一次性写完实现并 node --check 校验语法）与 ask_tester（T2，基于预读取接口一次性写完测试并仅用 node --check 校对测试语法，勿跑 node --test 调试空桩或碰 src/）；\n3) 同轮同时 review_task(accept) T1 与 T2；\n4) 立即调用 integrate_changes(changes:[c1,c2], wait:true) 一次完成联合集成验收（若失败再 repair_integration）。`
									: `${task.prompt}\n请用 plan_tasks 建立 T1 与 T2（不设置 scope 路径契约），同轮并行派 ask_coder 和 ask_tester（ask_tester 仅用 node --check 校对测试语法），同轮验收 T1/T2 后直接调用 integrate_changes(changes:[c1,c2], wait:true) 一次完成联合集成验证。`;
							}

							const submission = await app.root.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
							await submission.wait(runCtx);

							const waitTier2BlindReview = async () => {
								if (task.tier !== 2 || arm !== "lemma-adaptive") return;
								const deadline = Date.now() + budget.blindWaitMs;
								while (Date.now() < deadline && !signal.aborted) {
									const board = await app!.harness.snapshot(Board, BACKGROUND_CONTEXT);
									const t1 = board?.tasks?.T1;
									if (t1?.reviewer?.blind) blindReviewTriggered = true;
									if ((t1?.checksByMember?.length ?? 0) > 0) blindReviewTriggered = true;
									if (t1 && (t1.status === "done" || t1.status === "blocked")) {
										blindReviewSettled = t1.status === "done";
										break;
									}
									await new Promise((r) => setTimeout(r, 80));
								}
								const board = await app!.harness.snapshot(Board, BACKGROUND_CONTEXT);
								const t1 = board?.tasks?.T1;
								if (t1?.reviewer?.blind || (t1?.checksByMember?.length ?? 0) > 0) blindReviewTriggered = true;
								const checksByMember = t1?.checksByMember ?? [];
								blindReviewCaught = checksByMember.filter((c) => c.status === "rework" || c.status === "blocked").length;
								if (t1?.status === "done" || checksByMember.some((c) => c.status === "accepted")) blindReviewSettled = true;
							};

							await waitTier2BlindReview();

							// Pre-Flight Gate：拦截 lemma-adaptive 提前交卷并注入补全指令（最多 2 轮）
							if (arm === "lemma-adaptive") {
								for (let attempt = 0; attempt < 2; attempt++) {
									if (signal.aborted || loopDetected || timedOut) break;
									const gate = await evaluatePreFlightGate(app, task);
									if (gate.ok || !gate.issuePrompt) break;
									preFlightIntercepts++;
									hadRecoverableError = true;
									lastActivityAt = Date.now();
									const retrySub = await app.root.submit({ type: "input", content: gate.issuePrompt }, BACKGROUND_CONTEXT);
									await retrySub.wait(runCtx);
									await waitTier2BlindReview();
								}
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
						if (/TIMEOUT/i.test(error) || (signal.aborted && !loopDetected)) timedOut = true;
						if (/LOOP_DETECTED/i.test(error)) loopDetected = true;
						await app?.root.abort(BACKGROUND_CONTEXT).catch(() => {});
					} finally {
						clearInterval(heartbeat);
					}

					await Promise.all(pending);
					const hidden = runHiddenTests(repo, task.hiddenTest);
					const validObs = observations.filter((v) => v.totalTokens > 0);
					const measured = !options.simulated && validObs.length > 0;
					const providerPriced = measured && validObs.every((v) => v.cost.totalFromProvider);
					const usage = measured
						? validObs.reduce(
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
						? validObs.reduce((sum, v) => sum + v.cost.total, 0)
						: null;

					const implChanged = repoImplChanged(repo, task);
					let status: BenchmarkStatus;
					if (loopDetected) {
						status = "LOOP_DETECTED";
					} else if (timedOut || (error && /timeout|timed out|请求上限|abort/i.test(error))) {
						status = "TIMEOUT";
					} else if (tokenTruncated && (!hidden.ok || error)) {
						status = "TOKEN_TRUNCATED";
					} else if (!error && hidden.ok) {
						status = "PASS";
					} else if (!implChanged || (task.tier === 3 && arm !== "single" && !integrationCalled && requests < budget.maxRequests)) {
						status = "PREMATURE_STOP";
					} else {
						status = "ASSERTION_FAIL";
					}

					let routingMatched = false;
					let routingDetail = "";
					if (arm === "lemma-adaptive") {
						if (task.tier === 1) {
							routingMatched = usedFastPath;
							routingDetail = usedFastPath ? "FastPath命中" : "未命中FastPath";
						} else if (task.tier === 2) {
							routingMatched = blindReviewTriggered && blindReviewSettled;
							routingDetail = routingMatched ? "BlindReview完成合流" : `BlindReview未收敛(trig=${blindReviewTriggered},settled=${blindReviewSettled})`;
						} else if (task.tier === 3) {
							routingMatched = multiModulePlanned && scopeChecked && integrationCalled;
							routingDetail = `拆解=${multiModulePlanned}/契约=${scopeChecked}/集成=${integrationCalled}`;
						} else {
							routingMatched = task.category === "edge-tamper-guard" ? scopeChecked : implChanged;
							routingDetail = task.category === "edge-tamper-guard" ? (scopeChecked ? "只读护栏已启用" : "缺少scope护栏") : "契约保护执行";
						}
					} else if (arm === "single") {
						routingMatched = !usedFastPath && !multiModulePlanned;
						routingDetail = "单Agent直连";
					} else if (arm === "ablation-no-fastpath") {
						routingMatched = !usedFastPath && multiModulePlanned === false;
						routingDetail = "标准多步消融";
					} else if (arm === "ablation-no-blind") {
						routingMatched = !blindReviewTriggered;
						routingDetail = "无盲审消融";
					} else {
						routingMatched = multiModulePlanned && !scopeChecked;
						routingDetail = "无路径契约消融";
					}

					const selfHealed = status === "PASS" && (hadRecoverableError || scopeViolationsCaught > 0 || blindReviewCaught > 0 || preFlightIntercepts > 0);
					const trajectory: TrajectoryMetrics = {
						routingMatched,
						routingDetail,
						usedFastPath,
						blindReviewTriggered,
						blindReviewSettled,
						multiModulePlanned,
						scopeChecked,
						integrationCalled,
						loopDetected,
						preFlightIntercepts,
						selfHealed,
						tokenTruncated,
					};

					const run: TieredCodingRun = {
						taskId: task.id,
						tier: task.tier,
						...(task.category ? { category: task.category } : {}),
						title: task.title,
						arm,
						repeat,
						status,
						success: status === "PASS",
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
						selfHealed,
						trajectory,
						...(error ? { error } : hidden.ok ? {} : { error: `隐藏测试未全过 (${hidden.passed}/${hidden.total})` }),
					};
					runs.push(run);
					options.onRun?.(run);

					try { await app?.harness.close(BACKGROUND_CONTEXT); } catch {}
					try { rmSync(repo, { recursive: true, force: true }); } catch {}
					if (error && /\b40[123]\b|模型服务商认证或余额异常|insufficient balance|insufficient_balance/i.test(error)) {
						throw new Error(error);
					}
					if (!options.simulated) await new Promise((r) => setTimeout(r, 3000));
				}
			}
		}
		return runs;
	} finally {
		if (oldKey === undefined) delete process.env[keyEnv];
		else process.env[keyEnv] = oldKey;
	}
}

function failureBreakdown(list: TieredCodingRun[]): string {
	const counts: Record<Exclude<BenchmarkStatus, "PASS">, number> = {
		TIMEOUT: 0,
		PREMATURE_STOP: 0,
		ASSERTION_FAIL: 0,
		LOOP_DETECTED: 0,
		TOKEN_TRUNCATED: 0,
	};
	for (const r of list) {
		if (r.status !== "PASS") counts[r.status]++;
	}
	return `TIMEOUT: ${counts.TIMEOUT}, PREMATURE_STOP: ${counts.PREMATURE_STOP}, ASSERTION_FAIL: ${counts.ASSERTION_FAIL}, LOOP: ${counts.LOOP_DETECTED}, TRUNC: ${counts.TOKEN_TRUNCATED}`;
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

	const coreRuns = runs.filter((r) => r.tier !== "edge");
	const edgeRuns = runs.filter((r) => r.tier === "edge");

	const buildSummaryRows = (subset: TieredCodingRun[]) => {
		const arms = [...new Set(subset.map((r) => r.arm))];
		return arms.map((arm) => {
			const list = subset.filter((r) => r.arm === arm);
			const passedTasks = list.filter((r) => r.success).length;
			const hp = list.reduce((s, r) => s + r.hiddenPassed, 0);
			const ht = list.reduce((s, r) => s + r.hiddenTotal, 0);
			const routed = list.filter((r) => r.trajectory.routingMatched).length;
			const healed = list.filter((r) => r.selfHealed).length;
			const scopeCaught = list.reduce((s, r) => s + r.scopeViolationsCaught, 0);
			return `| \`${arm}\` | ${passedTasks}/${list.length} (${fmtPct(passedTasks, list.length)}) | ${hp}/${ht} (${fmtPct(hp, ht)}) | ${routed}/${list.length} (${fmtPct(routed, list.length)}) | 自愈 ${healed} / 拦截 ${scopeCaught} | ${failureBreakdown(list)} | ${fmtAvg(list.map((r) => r.requests))} | ${Math.round(list.reduce((s, r) => s + r.durationMs, 0) / Math.max(1, list.length))}ms | ${fmtTokens(list)} | ${fmtCost(list)} |`;
		});
	};

	const tierSections: string[] = [];
	for (const tier of [1, 2, 3] as const) {
		const tRuns = coreRuns.filter((r) => r.tier === tier);
		if (!tRuns.length) continue;
		const tierName = tier === 1
			? "Tier 1 · 单文件小改（Fast Path 效率验证）"
			: tier === 2
				? "Tier 2 · 核心算法边界与报错自愈（异构盲审价值验证）"
				: "Tier 3 · 多模块并行开发与越界自愈（路径契约与联合集成验证）";
		const tArms = [...new Set(tRuns.map((r) => r.arm))];
		const rows = tArms.map((arm) => {
			const list = tRuns.filter((r) => r.arm === arm);
			const ok = list.filter((r) => r.success).length;
			const hp = list.reduce((s, r) => s + r.hiddenPassed, 0);
			const ht = list.reduce((s, r) => s + r.hiddenTotal, 0);
			const routed = list.filter((r) => r.trajectory.routingMatched).length;
			const healed = list.filter((r) => r.selfHealed).length;
			const extra = tier === 1
				? `快路 ${list.filter((r) => r.usedFastPath).length}/${list.length}`
				: tier === 2
					? `盲审返工 ${list.reduce((s, r) => s + r.blindReviewCaught, 0)} · 自愈 ${healed}`
					: `契约拦截 ${list.reduce((s, r) => s + r.scopeViolationsCaught, 0)} · 自愈 ${healed} · 集成 ${list.filter((r) => r.integrationPassed).length}/${list.length}`;
			return `| \`${arm}\` | ${ok}/${list.length} | ${hp}/${ht} (${fmtPct(hp, ht)}) | ${routed}/${list.length} (${fmtPct(routed, list.length)}) | ${fmtAvg(list.map((r) => r.requests))} | ${Math.round(list.reduce((s, r) => s + r.durationMs, 0) / Math.max(1, list.length))}ms | ${extra} |`;
		});
		tierSections.push(
			`### ${tierName}`,
			"",
			"| 实验臂 | 任务通过 | 隐藏用例通过 | 路由准确率 | 平均模型请求 | 平均耗时 | 机制观测 |",
			"|---|---:|---:|---:|---:|---:|---|",
			...rows,
			"",
		);
	}

	const edgeSections: string[] = [];
	if (edgeRuns.length) {
		edgeSections.push(
			"## Tier-Edge 边缘防御独立评测（模糊需求与越权拦截）",
			"",
			"| 实验臂 | 任务通过率 | 隐藏用例通过率 | 路由准确率 | 自愈/契约拦截 | 失败归因分布 | 平均请求 | 平均耗时 | 总 Token | 美元费用 |",
			"|---|---:|---:|---:|---|---|---:|---:|---:|---:|",
			...buildSummaryRows(edgeRuns),
			"",
		);
	}

	const detailRows = runs.map((r) => {
		const tierTag = r.tier === "edge" ? "EDGE" : `T${r.tier}`;
		const flags = [
			r.trajectory.routingMatched ? "route:OK" : "route:MISS",
			r.selfHealed ? "selfHealed" : "",
			r.trajectory.preFlightIntercepts > 0 ? `preFlight:${r.trajectory.preFlightIntercepts}` : "",
		].filter(Boolean).join(", ");
		const note = r.error ? `${r.error.replace(/\|/g, "/").slice(0, 60)} (${flags})` : flags;
		return `| ${tierTag} | \`${r.taskId}\` | \`${r.arm}\` | ${r.status} | ${r.hiddenPassed}/${r.hiddenTotal} | ${r.requests} | ${r.durationMs}ms | ${note} |`;
	});

	return [
		"# Lemma P2 分层编码基准与消融实验报告",
		"",
		`- **代码版本**：\`${meta.revision}\`${meta.dirty ? "（工作区含未提交变更）" : ""}`,
		`- **运行模式**：${meta.simulated ? "离线确定性模拟（验证 P2 门禁、路由埋点、自愈与边缘防御链路，0 费用）" : `真实模型评测（\`${meta.model}\`，repeats=${meta.repeats}）`}`,
		`- **样本总量**：${runs.length} 次运行（Tier 1–3 核心 ${coreRuns.length} 次 · Tier-Edge 独立 ${edgeRuns.length} 次）`,
		"",
		...(coreRuns.length
			? [
				"## P2 主表对比（Tier 1–3 核心编码基准）",
				"",
				"| 实验臂 | 任务通过率 | 隐藏用例通过率 | 路由准确率 | 自愈/契约拦截 | 失败归因分布 | 平均请求 | 平均耗时 | 总 Token | 美元费用 |",
				"|---|---:|---:|---:|---|---|---:|---:|---:|---:|",
				...buildSummaryRows(coreRuns),
				"",
				"## 分层对照与消融结果",
				"",
				...tierSections,
			]
			: []),
		...edgeSections,
		"## 逐题明细",
		"",
		"| 层级 | 任务 | 实验臂 | 终态 | 隐藏用例 | 请求数 | 耗时 | 归因与轨迹备注 |",
		"|---|---|---|---|---:|---:|---:|---|",
		...detailRows,
		"",
	].join("\n");
}
