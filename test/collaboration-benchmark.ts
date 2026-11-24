import assert from "node:assert/strict";
import { localBenchmarkRuntime, runCollaborationBenchmark } from "../src/collaboration-benchmark.ts";
import { check, testConfig } from "./helpers.ts";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
const oldKey = process.env.LEMMA_COLLABORATION_BENCH_KEY; process.env.LEMMA_COLLABORATION_BENCH_KEY = "preserve-fixture";
const runs = await runCollaborationBenchmark({ base: testConfig(), runtime: localBenchmarkRuntime, simulated: true, repeats: 1 });
assert.equal(process.env.LEMMA_COLLABORATION_BENCH_KEY, "preserve-fixture");
assert.equal(runs.length, 6); for (const run of runs) { assert(run.success, JSON.stringify(run)); assert.equal(run.tokens, null); assert.equal(run.usage, null); assert.equal(run.costUsd, null); assert.equal(run.costSource, "unavailable"); assert.equal(run.manualInterventions, null); if (run.arm === "team") { assert.equal(run.accepted, 2); assert.equal(run.sourceRequests, 2); assert.equal(run.requests, 10); } }
const failures = await runCollaborationBenchmark({ base: testConfig(), runtime: () => { const runtime = localBenchmarkRuntime(); const wrong = fauxProvider({ provider: runtime.ref.provider, models: [{ id: runtime.ref.modelId }], tokensPerSecond: 100000 }); wrong.setResponses([fauxAssistantMessage(fauxText('{"total":999,"missing":[]}'))]); runtime.models.setProvider(wrong.provider); return runtime; }, simulated: true, repeats: 1 });
assert.equal(failures.length, 6); assert(failures.every((run) => !run.success && run.sourceRequests === 0 && run.tokens === null));
if (oldKey === undefined) delete process.env.LEMMA_COLLABORATION_BENCH_KEY; else process.env.LEMMA_COLLABORATION_BENCH_KEY = oldKey;
check(true, "完整任务对照使用生产派工、结构化交接、数据查询与验收，失败计入样本，模拟不伪造成本或人工介入数据");
