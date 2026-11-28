// P2 分层编码基准与消融评测套件测试：
// 验证 13 题隐藏测试有效性、Tier 1-3 + Chaos 自愈 + Tier-Edge 边缘防御、
// 路由轨迹埋点、Pre-Flight Gate 提前交卷拦截、LOOP_DETECTED 死循环熔断与 PREMATURE_STOP 状态码分类。
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { memberProvider } from "../src/api-member.ts";
import { CODING_BENCHMARK_TASKS } from "../src/coding-benchmark-fixtures.ts";
import {
	initTaskRepo,
	renderCodingBenchmarkReport,
	runHiddenTests,
	runTieredCodingBenchmark,
} from "../src/coding-benchmark-suite.ts";
import { check, testConfig } from "./helpers.ts";

// 1. 验证全部 13 题的初始代码都无法通过隐藏测试（防空壳题）
for (const task of CODING_BENCHMARK_TASKS) {
	const repo = initTaskRepo(task);
	try {
		const initial = runHiddenTests(repo, task.hiddenTest);
		assert.ok(initial.total >= 1 && !initial.ok, `题目 ${task.id} 初始代码不应通过隐藏测试`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}
check(CODING_BENCHMARK_TASKS.length === 13, "全部 13 道分层编码与边缘防御题初始代码按预期未通过隐藏测试");

// 2. 运行完整离线 P2 对照 + 消融 + 故障注入 + 边缘防御评测（3*3 + 4*3 + 4*3 + 2*2 = 37 次运行）
const base = testConfig();
const runs = await runTieredCodingBenchmark({
	base,
	simulated: true,
	repeats: 1,
});
check(runs.length === 37, `完整 P2 离线基准与消融运行完成（共 ${runs.length} 次）`);

// Tier 1：Fast Path 与 single 请求数持平且显著低于无快路消融组，路由命中 100%
const t1Single = runs.filter((r) => r.tier === 1 && r.arm === "single");
const t1Fast = runs.filter((r) => r.tier === 1 && r.arm === "lemma-adaptive");
const t1NoFast = runs.filter((r) => r.tier === 1 && r.arm === "ablation-no-fastpath");
check(t1Fast.every((r) => r.status === "PASS" && r.usedFastPath && r.trajectory.routingMatched), "Tier 1 lemma-adaptive 全部命中快路（路由 100%）并通过隐藏测试");
const avgReq = (list: typeof runs) => list.reduce((s, r) => s + r.requests, 0) / list.length;
check(avgReq(t1Fast) <= avgReq(t1Single) && avgReq(t1Fast) < avgReq(t1NoFast), `Tier 1 快路平均请求数（${avgReq(t1Fast)}）<= 单 Agent（${avgReq(t1Single)}）且低于无快路消融组（${avgReq(t1NoFast)}）`);

// Tier 2：异构盲审抓缺陷返工 + 故障注入 A 报错自愈通过
const t2Team = runs.filter((r) => r.tier === 2 && r.arm === "lemma-adaptive");
const t2NoBlind = runs.filter((r) => r.tier === 2 && r.arm === "ablation-no-blind");
const t2Chaos = t2Team.find((r) => r.taskId === "t2-chaos-type-heal");
check(
	t2Team.every((r) => r.status === "PASS" && r.trajectory.routingMatched && r.trajectory.blindReviewTriggered && r.trajectory.blindReviewSettled),
	"Tier 2 lemma-adaptive 全部触发并等待异构盲审合流，全部通过隐藏测试",
);
check(t2Team.filter((r) => r.category !== "chaos-type-heal").every((r) => r.blindReviewCaught >= 1), "Tier 2 核心题盲审均拦截初稿缺陷并触发返工");
check(!!t2Chaos && t2Chaos.selfHealed && t2Chaos.status === "PASS", "【故障注入A】过时旧测试报错后自主修复并计入 selfHealed");
check(t2NoBlind.filter((r) => r.category !== "chaos-type-heal").every((r) => r.status === "ASSERTION_FAIL"), "Tier 2 无盲审消融组核心题按预期暴露隐藏边界缺陷（ASSERTION_FAIL）");

// Tier 3：路径契约拦截 + 故障注入 B 越界自愈 + 多分支联合集成通过
const t3Team = runs.filter((r) => r.tier === 3 && r.arm === "lemma-adaptive");
const t3NoScope = runs.filter((r) => r.tier === 3 && r.arm === "ablation-no-scope");
const t3Chaos = t3Team.find((r) => r.taskId === "t3-chaos-scope-heal");
check(
	t3Team.every((r) => r.status === "PASS" && r.integrationPassed && r.scopeViolationsCaught >= 1 && r.trajectory.routingMatched),
	"Tier 3 lemma-adaptive 全部触发路径契约越界拦截、路由合规且完成联合集成",
);
check(!!t3Chaos && t3Chaos.selfHealed && t3Chaos.scopeViolationsCaught >= 1, "【故障注入B】路径契约越界拦截后收敛修改并最终通过隐藏测试");
check(t3NoScope.every((r) => r.scopeViolationsCaught === 0), "Tier 3 无路径契约消融组未触发越界拦截");

// Tier-Edge：模糊需求显式假设 + 越权篡改只读测试拦截
const edgeRuns = runs.filter((r) => r.tier === "edge");
const edgeTeamAmbiguity = edgeRuns.find((r) => r.taskId === "edge-ambiguity-wallet" && r.arm === "lemma-adaptive");
const edgeTeamTamper = edgeRuns.find((r) => r.taskId === "edge-guardrail-tamper" && r.arm === "lemma-adaptive");
const edgeSingleTamper = edgeRuns.find((r) => r.taskId === "edge-guardrail-tamper" && r.arm === "single");
check(edgeRuns.length === 4, "Tier-Edge 独立分组运行数量正确（2 题 × 2 臂 = 4 次）");
check(!!edgeTeamAmbiguity && edgeTeamAmbiguity.status === "PASS", "【边缘防御C】模糊契约缺失错误码时显式声明默认假设且保持原有接口");
check(
	!!edgeTeamTamper && edgeTeamTamper.status === "PASS" && edgeTeamTamper.scopeViolationsCaught >= 1 && edgeTeamTamper.selfHealed,
	"【边缘防御D】lemma-adaptive 成功拦截篡改 test/discount.test.js 并完成合规修复",
);
check(!!edgeSingleTamper && edgeSingleTamper.status === "ASSERTION_FAIL", "【边缘防御D】无路径护栏的 single 对照组受诱导篡改测试目录并判失败");

// 3. 专项验证：LOOP_DETECTED 死循环熔断（连续 2 次相同失败工具调用立即中止）
const loopRuns = await runTieredCodingBenchmark({
	base,
	simulated: true,
	tiers: [2],
	taskIds: ["t2-semver-sort"],
	arms: ["ablation-no-blind"],
	runtime: (task) => {
		if (task.id !== "t2-semver-sort") return { models: createModels(), ref: { provider: "bench-ctrl", modelId: "fixture" } };
		const models = createModels();
		const ctrl = fauxProvider({ provider: "bench-ctrl", models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(ctrl.provider);
		ctrl.setResponses([
			() => fauxAssistantMessage([fauxToolCall("ask_coder", { task: "fix semver" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxText("done")),
		]);
		const coder = fauxProvider({ provider: memberProvider("coder"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(coder.provider);
		const badEdit = () => fauxAssistantMessage([fauxToolCall("edit", { path: "src/semver.js", oldText: "NON_EXISTENT_SNIPPET", newText: "x" })], { stopReason: "toolUse" });
		coder.setResponses([badEdit, badEdit, badEdit, () => fauxAssistantMessage(fauxText("give up"))]);
		return { models, ref: { provider: "bench-ctrl", modelId: "fixture" } };
	},
});
const semverLoopRun = loopRuns.find((r) => r.taskId === "t2-semver-sort");
check(
	!!semverLoopRun && semverLoopRun.status === "LOOP_DETECTED" && semverLoopRun.trajectory.loopDetected,
	`死循环检测在连续 2 次相同失败工具调用后准确熔断（status=${semverLoopRun?.status}）`,
);

// 4. 专项验证：Pre-Flight Gate 拦截总控提前交卷并驱动补齐 integrate_changes（以及纯空结束判为 PREMATURE_STOP）
const gateRuns = await runTieredCodingBenchmark({
	base,
	simulated: true,
	tiers: [3],
	taskIds: ["t3-event-bus", "t3-ledger-engine"],
	arms: ["lemma-adaptive"],
	runtime: (task) => {
		const models = createModels();
		const ctrl = fauxProvider({ provider: "bench-ctrl", models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(ctrl.provider);
		const coder = fauxProvider({ provider: memberProvider("coder"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(coder.provider);
		coder.setResponses([
			() => fauxAssistantMessage(Object.entries(task.reference.files).map(([path, content]) => fauxToolCall("write", { path, content })), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxText("impl ready")),
		]);
		const tester = fauxProvider({ provider: memberProvider("tester"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(tester.provider);
		tester.setResponses([
			() => fauxAssistantMessage(Object.entries(task.reference.testFiles ?? {}).map(([path, content]) => fauxToolCall("write", { path, content })), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxText("tests ready")),
		]);

		let turn = 0;
		ctrl.setResponses(
			Array.from({ length: 12 }, () => (ctx: any) => {
				turn++;
				const res = ctx.messages
					.filter((m: any) => m.role === "toolResult")
					.map((m: any) => ({ name: m.toolName, text: (m.content ?? []).map((b: any) => b.text ?? "").join("") }));
				const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === "user");
				const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((b: any) => b.text ?? "").join("");

				if (task.id === "t3-event-bus") {
					// 模拟总控仅完成 plan + ask + accept 后未调用 integrate_changes 即提前结束，等待 Pre-Flight Gate 注入提示后补齐
					if (!res.some((r: any) => r.name === "plan_tasks")) {
						return fauxAssistantMessage([fauxToolCall("plan_tasks", {
							tasks: [
								{ title: "impl", role: "编码", acceptance: "ok", scope: { allow: ["src/"], forbid: ["test/"] } },
								{ title: "test", role: "测试", acceptance: "ok", scope: { allow: ["test/"], forbid: ["src/"] } },
							],
						})], { stopReason: "toolUse" });
					}
					const cRes = res.find((r: any) => r.name === "ask_coder");
					const tRes = res.find((r: any) => r.name === "ask_tester");
					if (!cRes && !tRes) {
						return fauxAssistantMessage([
							fauxToolCall("ask_coder", { task: "impl", task_id: "T1" }),
							fauxToolCall("ask_tester", { task: "test", task_id: "T2" }),
						], { stopReason: "toolUse" });
					}
					if (!res.some((r: any) => r.name === "review_task")) {
						const rid1 = cRes?.text.match(/result_id:\s*([^\s|\]]+)/)?.[1] ?? "";
						const rid2 = tRes?.text.match(/result_id:\s*([^\s|\]]+)/)?.[1] ?? "";
						return fauxAssistantMessage([
							fauxToolCall("review_task", { id: "T1", action: "accept", result_id: rid1, evidence: "ok" }),
							fauxToolCall("review_task", { id: "T2", action: "accept", result_id: rid2, evidence: "ok" }),
						], { stopReason: "toolUse" });
					}
					if (!lastUserText.includes("Pre-Flight Gate")) {
						return fauxAssistantMessage(fauxText("准备提前结束（尚未集成）。"));
					}
					const c1 = cRes?.text.match(/改动 #([a-f0-9]+)/)?.[1];
					const c2 = tRes?.text.match(/改动 #([a-f0-9]+)/)?.[1];
					if (!res.some((r: any) => r.name === "integrate_changes") && c1 && c2) {
						return fauxAssistantMessage([fauxToolCall("integrate_changes", { changes: [c1, c2], wait: true })], { stopReason: "toolUse" });
					}
					return fauxAssistantMessage(fauxText("Pre-Flight Gate 提醒后已补齐集成。"));
				}
				// 其余 Tier 3 题直接交白卷以验证 PREMATURE_STOP
				return fauxAssistantMessage(fauxText(`noop turn ${turn}`));
			}),
		);
		return { models, ref: { provider: "bench-ctrl", modelId: "fixture" } };
	},
});
const eventBusGateRun = gateRuns.find((r) => r.taskId === "t3-event-bus");
const ledgerPrematureRun = gateRuns.find((r) => r.taskId === "t3-ledger-engine");
check(
	!!eventBusGateRun && eventBusGateRun.status === "PASS" && eventBusGateRun.trajectory.preFlightIntercepts >= 1 && eventBusGateRun.integrationPassed,
	`Pre-Flight Gate 准确拦截提前交卷并驱动补齐联合集成（intercepts=${eventBusGateRun?.trajectory.preFlightIntercepts}）`,
);
check(
	!!ledgerPrematureRun && ledgerPrematureRun.status === "PREMATURE_STOP" && ledgerPrematureRun.trajectory.preFlightIntercepts === 2,
	`未完成核心改动且两次门禁后仍无产出的运行被归类为 PREMATURE_STOP（intercepts=${ledgerPrematureRun?.trajectory.preFlightIntercepts}）`,
);

// 5. 专项验证：Chaos A 仓库既有测试门禁（漏改 test/legacy.test.js 时 Pre-Flight Gate 运行旧测试并打回自愈 + 验证非快路预读取内联）
let chaosCoderSawPreload = false;
const chaosGateRuns = await runTieredCodingBenchmark({
	base,
	simulated: true,
	tiers: [2],
	taskIds: ["t2-chaos-type-heal"],
	arms: ["lemma-adaptive"],
	runtime: (task) => {
		const models = createModels();
		const ctrl = fauxProvider({ provider: "bench-ctrl", models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(ctrl.provider);
		const coder = fauxProvider({ provider: memberProvider("coder"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(coder.provider);
		coder.setResponses([
			(ctx: any) => {
				const text = (ctx.messages ?? []).map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("")).join("\n");
				chaosCoderSawPreload = text.includes("【预读取目标/关联文件") && text.includes("calculateOrderTotal");
				// 首轮刻意只改 src/pricing.js，漏改 test/legacy.test.js
				return fauxAssistantMessage([fauxToolCall("write", { path: "src/pricing.js", content: task.reference.files["src/pricing.js"]! })], { stopReason: "toolUse" });
			},
			() => fauxAssistantMessage(fauxText("仅更新了 src/pricing.js。")),
			() => fauxAssistantMessage([fauxToolCall("write", { path: "test/legacy.test.js", content: task.reference.files["test/legacy.test.js"]! })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxText("已同步修复 test/legacy.test.js。")),
		]);
		const auditor = fauxProvider({ provider: memberProvider("auditor"), models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
		models.setProvider(auditor.provider);
		auditor.setResponses([
			(ctx: any) => {
				const userMsgs = (ctx.messages ?? []).map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("")).join("\n");
				const rid = userMsgs.match(/result_id"\s*:\s*"([^"]+)"/)?.[1] ?? userMsgs.match(/result_id="([^"]+)"/)?.[1] ?? "unknown";
				return fauxAssistantMessage(fauxText(JSON.stringify({ verdict: "accept", result_id: rid, evidence: "pricing 已修改" })));
			},
		]);
		ctrl.setResponses(
			Array.from({ length: 8 }, () => (ctx: any) => {
				const res = (ctx.messages ?? []).filter((m: any) => m.role === "toolResult").map((m: any) => ({ name: m.toolName }));
				const lastUser = [...(ctx.messages ?? [])].reverse().find((m: any) => m.role === "user");
				const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((b: any) => b.text ?? "").join("");
				if (!res.some((r: any) => r.name === "plan_tasks")) {
					return fauxAssistantMessage([fauxToolCall("plan_tasks", {
						tasks: [{ title: task.title, role: "编码", acceptance: "升级 pricing 并同步旧测试", automation: { member: "coder", maxReworks: 1 }, reviewer: { member: "auditor", blind: true } }],
					})], { stopReason: "toolUse" });
				}
				if (lastUserText.includes("Pre-Flight Gate") && !res.some((r: any) => r.name === "ask_coder")) {
					const cid = lastUserText.match(/改动 #([a-f0-9]+)/)?.[1];
					return fauxAssistantMessage([fauxToolCall("ask_coder", { task: "同步更新 test/legacy.test.js 修复旧断言", ...(cid ? { based_on: cid } : {}) })], { stopReason: "toolUse" });
				}
				return fauxAssistantMessage(fauxText("已按门禁要求补齐旧测试自愈。"));
			}),
		);
		return { models, ref: { provider: "bench-ctrl", modelId: "fixture" } };
	},
});
const chaosGateRun = chaosGateRuns.find((r) => r.taskId === "t2-chaos-type-heal");
check(
	!!chaosGateRun && chaosGateRun.status === "PASS" && chaosGateRun.selfHealed && chaosGateRun.trajectory.preFlightIntercepts === 1 && chaosCoderSawPreload,
	`Chaos A 门禁跑通仓库旧测试打回自愈且非快路首次派工预读取生效（intercepts=${chaosGateRun?.trajectory.preFlightIntercepts}）`,
);

// 6. 验证 P2 Markdown 报告格式（独立主表 + Tier-Edge 独立章节 + 新增 3 列 + 状态码列）
const report = renderCodingBenchmarkReport({ revision: "test-p2", dirty: false, simulated: true, model: "scripted-fixture", repeats: 1 }, runs);
check(
	report.includes("# Lemma P2 分层编码基准与消融实验报告") &&
		report.includes("P2 主表对比") &&
		report.includes("Tier-Edge 边缘防御独立评测") &&
		report.includes("路由准确率") &&
		report.includes("自愈/契约拦截") &&
		report.includes("失败归因分布"),
	"P2 Markdown 报告包含独立主表、Tier-Edge 分节与新增 3 项指标列",
);

// 7. 验证多轮重复（repeats=3）Pass@k / Pass^k / 均值±标准差统计与 skipRun 断点跳过机制
const repeatRuns = await runTieredCodingBenchmark({
	base,
	simulated: true,
	tiers: [1],
	taskIds: ["t1-slugify-fix"],
	arms: ["lemma-adaptive"],
	repeats: 3,
	skipRun: (_task, _arm, rep) => rep === 1,
});
check(
	repeatRuns.length === 2 && repeatRuns.map((r) => r.repeat).join(",") === "0,2",
	`skipRun 断点跳过机制正确跳过已完成的 repeat=1（实际执行 repeat=${repeatRuns.map((r) => r.repeat).join(",")}）`,
);
const repeatReport = renderCodingBenchmarkReport(
	{ revision: "test-repeat", dirty: false, simulated: true, model: "scripted-fixture", repeats: 3 },
	[
		...repeatRuns,
		{ ...repeatRuns[0]!, repeat: 1, status: "TIMEOUT", success: false, hiddenPassed: 1, requests: 9, durationMs: 9000 },
	],
);
check(
	repeatReport.includes("多轮稳定性统计") &&
		repeatReport.includes("Pass@3 = **1/1 (100%)**") &&
		repeatReport.includes("Pass^3（全轮稳定通过）= **0/1 (0%)**") &&
		repeatReport.includes("±"),
	"repeats=3 报告正确计算 Pass@k、Pass^k 与均值±标准差统计",
);

console.log("\nP2 分层编码基准与消融评测套件测试全部通过 ✅");
