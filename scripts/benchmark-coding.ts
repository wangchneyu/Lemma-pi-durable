// P2 分层编码基准与消融实验 CLI 入口：
//   npm run bench:coding                                 # 离线模拟验证全 13 题 × 对照/消融链路（0 费用）
//   npm run bench:coding -- --real --repeats=1           # 使用当前配置模型跑真实定量对照与消融实验
//   npm run bench:coding -- --real --tier=2,3,edge --arms=lemma-adaptive --orchestrator-agent=deepseek --orchestrator-model=deepseek-v4-pro --coder-agent=deepseek
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
	? tierArg
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.map((s): BenchmarkTier | undefined => (s === "edge" ? "edge" : s === "1" || s === "2" || s === "3" ? (Number(s) as 1 | 2 | 3) : undefined))
		.filter((n): n is BenchmarkTier => n !== undefined)
	: undefined;
const armsArg = process.argv.find((a) => a.startsWith("--arms="))?.split("=")[1];
const arms = armsArg ? (armsArg.split(",").map((s) => s.trim()).filter(Boolean) as BenchmarkArm[]) : undefined;
const coderAgent = process.argv.find((a) => a.startsWith("--coder-agent="))?.split("=")[1]?.trim() || undefined;
const orchAgent = process.argv.find((a) => a.startsWith("--orchestrator-agent="))?.split("=")[1]?.trim() || undefined;
const orchModel = process.argv.find((a) => a.startsWith("--orchestrator-model="))?.split("=")[1]?.trim() || undefined;

const base = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
if (real && orchAgent) {
	const src = base.agents[orchAgent];
	if (!src?.api) throw new Error(`--orchestrator-agent=${orchAgent} 必须是已配置的 API 成员。`);
	const modelId = orchModel ?? src.defaultModel ?? src.models[0]?.id;
	if (!modelId) throw new Error(`--orchestrator-agent=${orchAgent} 未配置可用模型。`);
	const price = src.models.find((m) => m.id === modelId)?.price;
	base.orchestrator = {
		...base.orchestrator,
		type: src.api.type,
		baseUrl: src.api.baseUrl,
		apiKeyEnv: src.api.apiKeyEnv,
		apiKeyFromClaudeSettings: false,
		credential: src.api.credential,
		modelId,
		...(price ? { price } : {}),
	};
}
const outDir = resolve(
	process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
		join("data", "benchmarks", `coding-p2-${new Date().toISOString().replace(/[:.]/g, "-")}`),
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

console.log(real ? `开始真实模型 P2 分层编码基准（model=${base.orchestrator.modelId}, repeats=${repeats}，可能产生费用）…` : "开始离线模拟 P2 分层编码基准（验证 13 题 + 对照/消融/自愈/边缘防御链路，不调用付费 API）…");

try {
	await runTieredCodingBenchmark({
		base,
		runtime: (task, arm) => (real ? createOrchestratorModel(base.orchestrator) : localTieredCodingRuntime(task, arm)),
		simulated: !real,
		tiers,
		arms,
		coderAgent,
		repeats,
		onRun(run) {
			runs.push(run);
			save();
			const tag = run.tier === "edge" ? "EDGE" : `T${run.tier}`;
			const routeTag = run.trajectory.routingMatched ? "route:OK" : "route:MISS";
			const healTag = run.selfHealed ? " · selfHealed" : "";
			console.log(`[${tag}] ${run.taskId} · ${run.arm} => ${run.status} (${run.hiddenPassed}/${run.hiddenTotal}, ${run.requests} reqs, ${run.durationMs}ms, ${routeTag}${healTag})`);
		},
	});
} finally {
	save();
	console.log(`\n评测报告已生成：${join(outDir, "report.md")}`);
}
