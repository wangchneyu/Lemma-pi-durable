// P1 分层编码基准与消融评测套件测试：验证 9 题隐藏测试有效性、快慢路径请求数对比、盲审拦截返工与路径契约/联合集成闭环。
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { CODING_BENCHMARK_TASKS } from "../src/coding-benchmark-fixtures.ts";
import {
	initTaskRepo,
	renderCodingBenchmarkReport,
	runHiddenTests,
	runTieredCodingBenchmark,
} from "../src/coding-benchmark-suite.ts";
import { check, testConfig } from "./helpers.ts";

// 1. 验证全部 9 题的初始代码都无法通过隐藏测试（防空壳题）
for (const task of CODING_BENCHMARK_TASKS) {
	const repo = initTaskRepo(task);
	try {
		const initial = runHiddenTests(repo, task.hiddenTest);
		assert.ok(initial.total >= 1 && !initial.ok, `题目 ${task.id} 初始代码不应通过隐藏测试`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}
check(CODING_BENCHMARK_TASKS.length === 9, "全部 9 道分层编码题初始代码按预期未通过隐藏测试");

// 2. 运行完整离线对照 + 消融评测（9 题 × 3 臂 = 27 次运行）
const base = testConfig();
const runs = await runTieredCodingBenchmark({
	base,
	simulated: true,
	repeats: 1,
});
check(runs.length === 27, `完整离线对照与消融运行完成（共 ${runs.length} 次）`);

// Tier 1：Fast Path 与 single 请求数持平且显著低于无快路消融组
const t1Single = runs.filter((r) => r.tier === 1 && r.arm === "single");
const t1Fast = runs.filter((r) => r.tier === 1 && r.arm === "lemma-adaptive");
const t1NoFast = runs.filter((r) => r.tier === 1 && r.arm === "ablation-no-fastpath");
check(t1Fast.every((r) => r.success && r.usedFastPath), "Tier 1 lemma-adaptive 全部走单跳快路并通过隐藏测试");
const avgReq = (list: typeof runs) => list.reduce((s, r) => s + r.requests, 0) / list.length;
check(avgReq(t1Fast) <= avgReq(t1Single) && avgReq(t1Fast) < avgReq(t1NoFast), `Tier 1 快路平均请求数（${avgReq(t1Fast)}）与单 Agent（${avgReq(t1Single)}）持平且低于无快路消融组（${avgReq(t1NoFast)}）`);

// Tier 2：异构盲审抓出隐藏缺陷并返工通过；无盲审对照组暴露隐藏边界失败
const t2Team = runs.filter((r) => r.tier === 2 && r.arm === "lemma-adaptive");
const t2NoBlind = runs.filter((r) => r.tier === 2 && r.arm === "ablation-no-blind");
check(t2Team.every((r) => r.success && r.blindReviewCaught >= 1), "Tier 2 lemma-adaptive 异构盲审在全部 3 题中拦截隐藏缺陷并返工通过");
check(t2NoBlind.every((r) => !r.success), "Tier 2 无盲审消融组按预期暴露隐藏边界缺陷");

// Tier 3：路径契约拦截越界写入 + 多分支联合集成通过 + 隐藏测试全过
const t3Team = runs.filter((r) => r.tier === 3 && r.arm === "lemma-adaptive");
const t3NoScope = runs.filter((r) => r.tier === 3 && r.arm === "ablation-no-scope");
check(t3Team.every((r) => r.success && r.integrationPassed && r.scopeViolationsCaught >= 1), "Tier 3 lemma-adaptive 触发路径契约越界拦截并通过多分支联合集成与隐藏测试");
check(t3NoScope.every((r) => r.scopeViolationsCaught === 0), "Tier 3 无路径契约消融组未触发越界拦截");

// 3. 验证 Markdown 报告生成
const report = renderCodingBenchmarkReport({ revision: "test-rev", dirty: false, simulated: true, model: "scripted-fixture", repeats: 1 }, runs);
check(
	report.includes("Tier 1 · 单文件小改") && report.includes("Tier 2 · 核心算法隐藏边界") && report.includes("Tier 3 · 多模块并行开发") && report.includes("ablation-no-fastpath"),
	"Markdown 报告包含完整总览、三层对照与消融实验表格",
);

console.log("\nP1 分层编码基准与消融评测套件测试全部通过 ✅");
