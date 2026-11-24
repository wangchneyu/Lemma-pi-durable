import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { createOrchestratorModel } from "../src/models.ts";
import { localBenchmarkRuntime, runCollaborationBenchmark, type CollaborationBenchmarkRun } from "../src/collaboration-benchmark.ts";
const real = process.argv.includes("--real"), repeats = Number(process.argv.find((arg) => arg.startsWith("--repeats="))?.split("=")[1] ?? 1);
const base = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const directory = resolve(process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? join("data", "benchmarks", `collaboration-${new Date().toISOString().replace(/[:.]/g, "-")}`)); mkdirSync(directory, { recursive: true });
let revision = "unknown"; try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}
let dirty = true; try { dirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}
const runs: CollaborationBenchmarkRun[] = [];
const save = () => writeFileSync(join(directory, "results.json"), JSON.stringify({ revision, dirty, simulated: !real, repeats, model: real ? base.orchestrator.modelId : "scripted-fixture", protocol: real ? base.orchestrator.type : "faux", limits: { requestsPerSample: 32, outputTokensPerRequest: 1024, sampleTimeoutMs: 90000, retries: 0 }, scope: "Complete local data-query task through production host; includes controller, members, handoff and acceptance. Not industry quality evaluation. Manual rescue not measured.", runs }, null, 2));
console.log(real ? "真实模型全流程对照：最多每样本 32 次请求，可能计费。" : "本机固定响应全流程对照：验证功能，token/费用不作为真实证据。");
try { await runCollaborationBenchmark({ base, runtime: () => real ? createOrchestratorModel(base.orchestrator) : localBenchmarkRuntime(), simulated: !real, repeats, onRun(run) { runs.push(run); save(); console.log(`${run.fixture} ${run.arm} ${run.success ? "PASS" : "FAIL"} ${run.durationMs}ms ${run.requests} requests ${run.tokens ?? "unmeasured"} tokens`); } }); } finally {
	save(); const rows = (["single", "team"] as const).map((arm) => { const items = runs.filter((run) => run.arm === arm); return `| ${arm} | ${items.filter((run) => run.success).length}/${items.length} | ${items.length && items.every((run) => run.tokens !== null) ? items.reduce((sum, run) => sum + run.tokens!, 0) : "未测量"} | ${items.length && items.every((run) => run.costUsd !== null) ? items.reduce((sum, run) => sum + run.costUsd!, 0) : "未知"} | ${items.length ? Math.round(items.reduce((sum, run) => sum + run.durationMs, 0) / items.length) : "—"} |`; });
	writeFileSync(join(directory, "report.md"), ["# Lemma 全流程协作对照", "", `代码：${revision}${dirty ? "（工作区有未提交变更）" : ""}`, "", "相同输入与本机数据源；单 Agent 直接调用工具，团队执行拆解、派工、结构化字段交接、复核及验收。失败计入分母。", "", "| 方式 | 成功/样本 | 总 token | 美元费用 | 平均毫秒 |", "|---|---:|---:|---:|---:|", ...rows, "", `人工介入需求未测量；固定数据小任务不代表行业质量。${real ? "本次使用配置的模型 API；费用来源见 results.json，缺失用量或价格时留空。" : "本次为固定响应模拟，不报告真实 token/费用，也未运行付费模型。"}`].join("\n")); console.log(`报告：${directory}`);
}
if (runs.some((run) => !run.success)) process.exitCode = 1;
