import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runContextBenchmark, summarizeBenchmark } from "../src/context-benchmark.ts";
import { check } from "./helpers.ts";

const faux = fauxProvider({ provider: "test-benchmark", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
const models = createModels(); models.setProvider(faux.provider);
const reply = (context: any) => {
	const result = context.messages.findLast((message: any) => message.role === "toolResult");
	if (!result) return fauxAssistantMessage([fauxToolCall("read_report", {})], { stopReason: "toolUse" });
	const text = result.content.map((block: any) => block.text ?? "").join("");
	return fauxAssistantMessage(text.match(/ACCEPTANCE=([A-Z_]+)/)?.[1] ?? "MISSING");
};
faux.setResponses(Array.from({ length: 32 }, () => reply));
const runs = await runContextBenchmark({ models, ref: { provider: "test-benchmark", modelId: "fixture" }, repeats: 2, limit: 4000, simulated: true, priced: false });
assert.equal(runs.length, 8); assert.ok(runs.every((run) => run.usage === null && run.costUsd === null));
assert.equal(runs.filter((run) => run.arm === "full" && run.success).length, 4);
assert.equal(runs.filter((run) => run.arm === "bounded" && run.success).length, 2);
assert.deepEqual(runs.slice(2, 4).map((run) => run.arm), ["bounded", "full"]);
const summary = summarizeBenchmark(runs); assert.equal(summary.tokenReduction, null); assert.equal(summary.successRateDelta, -0.5);
assert.equal(summarizeBenchmark(runs.slice(0, 1)).tokenReduction, null);
check(true, "固定报告 A/B 评测复用生产裁剪策略，计入中段信息丢失失败，本地模拟不伪造 token 或零成本");
