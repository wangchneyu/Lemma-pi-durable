import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestratorModel } from "../src/models.ts";
import { nativeModelCatalog } from "../src/model-selection.ts";
import { check } from "./helpers.ts";

let requests = 0, fail = false;
const server = createServer((req, res) => {
	requests++; assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, "Bearer test-discovery");
	res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
	res.end(JSON.stringify(fail ? {} : { data: [{ id: "confirmed-fast" }, { id: "confirmed-strong" }, { id: null }, null] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.LEMMA_DISCOVERY_TEST_KEY = "test-discovery";
try {
	const cache = join(mkdtempSync(join(tmpdir(), "lemma-model-catalog-")), "models.json");
	const config = { type: "openai-compatible" as const, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelId: "configured", discoverModels: true, apiKeyEnv: ["LEMMA_DISCOVERY_TEST_KEY"] };
	const runtime = createOrchestratorModel(config, cache);
	const catalog = await nativeModelCatalog(runtime.models, "orchestrator", true);
	assert.equal(requests, 0); await catalog.refresh({ force: true });
	assert.ok(runtime.models.getModel("orchestrator", "confirmed-fast"));
	assert.ok(catalog.getAvailableSnapshot().some((model) => model.id === "confirmed-strong"));
	assert.ok(catalog.getAvailableSnapshot().length > 1);
	assert.ok(!readFileSync(cache, "utf8").includes("test-discovery"));
	const restored = createOrchestratorModel(config, cache);
	assert.ok(restored.models.getModel("orchestrator", "confirmed-fast"));
	const requestsBefore = requests;
	const offline = await nativeModelCatalog(restored.models, "orchestrator"); await offline.refresh(); assert.equal(requests, requestsBefore);
	fail = true; const result = await catalog.refresh({ force: true }); assert.ok(result.errors.size);
	assert.ok(runtime.models.getModel("orchestrator", "configured")); assert.ok(runtime.models.getModel("orchestrator", "confirmed-fast"));
	check(true, "模型目录只读取服务 GET /models，返回真实 ID，重启读缓存且失败保留可用模型，缓存无密钥");
} finally { delete process.env.LEMMA_DISCOVERY_TEST_KEY; await new Promise<void>((resolve) => server.close(() => resolve())); }
