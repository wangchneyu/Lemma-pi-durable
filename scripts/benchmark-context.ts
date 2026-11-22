// Default: fully local fixtures. --real explicitly calls only the configured controller API.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.ts";
import { createOrchestratorModel } from "../src/models.ts";
import { BENCHMARK_TASKS, runContextBenchmark, summarizeBenchmark, type BenchmarkRun } from "../src/context-benchmark.ts";

const args = process.argv.slice(2);
const real = args.includes("--real");
const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const repeats = Number(value("repeats") ?? 2), limit = Number(value("limit") ?? 4000);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isInteger(limit) || limit < 500 || limit > 20000) throw new Error("repeats 须为 1–10，limit 须为 500–20000。");
const config = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const faux = fauxProvider({ provider: "benchmark-local", models: [{ id: "fixture-only" }], tokensPerSecond: 100000 });
const fakeModels = createModels(); fakeModels.setProvider(faux.provider);
const inspect = (request: any) => {
	const tool = request.messages.findLast((message: any) => message.role === "toolResult");
	if (!tool) return fauxAssistantMessage([fauxToolCall("read_report", {})], { stopReason: "toolUse" });
	const report = tool.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
	return fauxAssistantMessage(report.match(/ACCEPTANCE=([A-Z_]+)/)?.[1] ?? "MISSING");
};
faux.setResponses(Array.from({ length: 160 }, () => inspect));
const runtime = real ? createOrchestratorModel(config.orchestrator) : { models: fakeModels, ref: { provider: "benchmark-local", modelId: "fixture-only" } };
const directory = resolve(value("out") ?? join("data", "benchmarks", `${new Date().toISOString().replace(/[:.]/g, "-")}-${real ? "real" : "local"}`));
mkdirSync(directory, { recursive: true });
let revision = "unknown"; try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}
let dirty = false; try { dirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(); } catch {}
const runs: BenchmarkRun[] = [];
const metadata = { schemaVersion: 1, revision, dirty, fixtureHash: createHash("sha256").update(JSON.stringify(BENCHMARK_TASKS)).digest("hex"), startedAt: new Date().toISOString(), mode: real ? "provider-measured" : "local-simulation",
	model: runtime.ref, repeats, limit, outputTokenCap: 128, requestRetry: false, maxToolRounds: 2, fixture: "fixed-member-report-v1",
	scope: "Production clipping-policy ablation only; excludes member generation, CLI startup, coding, and repair. Not total multi-agent savings.",
	pricingConfigured: real && (config.orchestrator.type === "builtin" || !!config.orchestrator.price) };
const save = () => writeFileSync(join(directory, "results.json"), JSON.stringify({ ...metadata, summary: summarizeBenchmark(runs), runs }, null, 2));
console.log(`${real ? "真实 API" : "本地模拟（不是 token 证据）"}：${repeats} 次 × 2 任务 × 2 策略；最多 ${repeats * 8} 次短请求。`);
save();
try {
	await runContextBenchmark({ models: runtime.models, ref: runtime.ref, repeats, limit, simulated: !real, priced: metadata.pricingConfigured,
		signal: AbortSignal.timeout(real ? 240000 : 30000), onRun(run) { runs.push(run); save(); console.log(`${run.task} ${run.arm} ${run.success ? "PASS" : "FAIL"} ${run.usage?.totalTokens ?? "unmeasured"} tokens ${run.durationMs}ms`); } });
} finally {
	const summary = summarizeBenchmark(runs);
	const lines = ["# Lemma 上下文裁剪对照评测", "", `模式：${metadata.mode}；模型：${runtime.ref.provider}/${runtime.ref.modelId}；重复 ${repeats} 次。`, "",
		"固定同一成员报告、问题和验收答案，只改变是否使用生产裁剪函数。独立 Durable 内存会话；顺序交替；失败计入分母。", "",
		"| 策略 | 样本 | 通过 | 总 token | 美元成本 | 平均毫秒 |", "|---|---:|---:|---:|---:|---:|",
		...summary.arms.map((arm) => `| ${arm.arm} | ${arm.runs} | ${arm.successes} | ${arm.totalTokens ?? "未测量"} | ${arm.costUsd ?? "无定价/未测量"} | ${arm.meanDurationMs?.toFixed(0) ?? "—"} |`), "",
		`token 变化：${summary.tokenReduction === null ? "未测量" : `${(summary.tokenReduction * 100).toFixed(1)}% 减少`}；通过率变化：${summary.successRateDelta === null ? "未测量" : `${(summary.successRateDelta * 100).toFixed(1)} 个百分点`}。`, "",
		"边界：本地模拟不报告真实 token 或费用。真实 API 取服务 usage，缺失则记未测量；无单价不按零费用算。包含会丢失中段关键信息的反例；此评测不证明整体编码成功率、续接收益或多 Agent 总成本降低。缓存明细与各次样本见 results.json。",
		"", "失败样本：", ...runs.filter((run) => !run.success).map((run) => `- ${run.task}/${run.arm}: ${run.error ?? run.answer ?? "未完成"}`)];
	writeFileSync(join(directory, "report.md"), lines.join("\n")); save();
	console.log(`报告：${directory}`);
}
