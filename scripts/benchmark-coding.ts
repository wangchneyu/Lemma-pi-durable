// P1 分层编码基准与消融实验 CLI 入口：
//   npm run bench:coding                                 # 离线模拟验证全 9 题 × 对照/消融链路（0 费用）
//   npm run bench:coding -- --real --repeats=1           # 使用当前配置模型跑真实定量对照与消融实验
//   npm run bench:coding -- --real --tier=1,2 --arms=single,lemma-adaptive
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createOrchestratorModel } from "../src/models.ts";
import {
	localTieredCodingRuntime,
	renderCodingBenchmarkReport,
	runTieredCodingBenchmark,
	type BenchmarkArm,
	type TieredCodingRun,
} from "../src/coding-benchmark-suite.ts";
import type { BenchmarkTier } from "../src/coding-benchmark-fixtures.ts";

const real = process.argv.includes("--real");
const repeats = Number(process.argv.find((a) => a.startsWith("--repeats="))?.split("=")[1] ?? 1);
const tierArg = process.argv.find((a) => a.startsWith("--tier="))?.split("=")[1];
const tiers = tierArg
	? tierArg.split(",").map((s) => Number(s.trim())).filter((n): n is BenchmarkTier => n === 1 || n === 2 || n === 3)
	: undefined;
const armsArg = process.argv.find((a) => a.startsWith("--arms="))?.split("=")[1];
const arms = armsArg ? (armsArg.split(",").map((s) => s.trim()).filter(Boolean) as BenchmarkArm[]) : undefined;

const base = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const outDir = resolve(
	process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
		join("data", "benchmarks", `coding-p1-${new Date().toISOString().replace(/[:.]/g, "-")}`),
);
mkdirSync(outDir, { recursive: true });

let revision = "unknown";
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}
let dirty = false;
try { dirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}

const runs: TieredCodingRun[] = [];
const meta = { revision, dirty, simulated: !real, model: real ? base.orchestrator.modelId : "scripted-fixture", repeats };
const save = () => {
	writeFileSync(join(outDir, "results.json"), JSON.stringify({ ...meta, runs }, null, 2), "utf8");
	writeFileSync(join(outDir, "report.md"), renderCodingBenchmarkReport(meta, runs), "utf8");
};

console.log(real ? `开始真实模型 P1 分层编码基准（model=${base.orchestrator.modelId}, repeats=${repeats}，可能产生费用）…` : "开始离线模拟 P1 分层编码基准（验证 9 题 + 对照/消融链路，不调用付费 API）…");

try {
	await runTieredCodingBenchmark({
		base,
		runtime: (task, arm) => (real ? createOrchestratorModel(base.orchestrator) : localTieredCodingRuntime(task, arm)),
		simulated: !real,
		tiers,
		arms,
		repeats,
		onRun(run) {
			runs.push(run);
			save();
			console.log(`[T${run.tier}] ${run.taskId} · ${run.arm} => ${run.success ? "PASS" : "FAIL"} (${run.hiddenPassed}/${run.hiddenTotal}, ${run.requests} reqs, ${run.durationMs}ms)`);
		},
	});
} finally {
	save();
	console.log(`\n评测报告已生成：${join(outDir, "report.md")}`);
}
