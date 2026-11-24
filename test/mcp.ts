import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { createMemberTools } from "../src/api-member.ts";
import { discoverMcp, validateMcpGrants, type McpGrant } from "../src/mcp-tools.ts";
import { memberSettingsCommand, type MemberSettingsHost } from "../src/member-settings.ts";
import { loadConfig } from "../src/config.ts";
import { fauxOrchestrator, testConfig, toolResults, check } from "./helpers.ts";

let executed = 0, changed = false, reordered = false;
const connections: Server[] = [];
const server = createServer(async (req, res) => {
	const instance = new Server({ name: "fixture-mcp", version: "1" }, { capabilities: { tools: {} } }); connections.push(instance);
	instance.setRequestHandler(ListToolsRequestSchema, async (request) => request.params?.cursor === "second" ? { tools: [
		{ name: "lookup", description: "lookup fixture", inputSchema: reordered ? { additionalProperties: false, required: ["query"], properties: { query: { type: changed ? "number" : "string" } }, type: "object" as const } : { type: "object" as const, properties: { query: { type: changed ? "number" : "string" } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true } },
	] } : { tools: [{ name: "change_data", description: "write fixture", inputSchema: { type: "object" as const, properties: {} }, annotations: { readOnlyHint: false } }], nextCursor: "second" });
	instance.setRequestHandler(CallToolRequestSchema, async (request) => { executed++; return { content: [{ type: "text" as const, text: String(request.params.arguments?.query) }], structuredContent: { value: 42, source: "mcp-fixture" } }; });
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await instance.connect(transport); await transport.handleRequest(req, res); res.on("close", () => { void instance.close(); });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
const config = testConfig(), orch = fauxOrchestrator(); let app: Awaited<ReturnType<typeof openApp>> | undefined;
try {
	const catalog = await discoverMcp({ url }); assert.equal(catalog.length, 2); assert(!catalog[0]!.readOnly); assert(catalog[1]!.readOnly);
	const { readOnly, ...definition } = catalog[1]!; const grant: McpGrant = { id: "records", url, tools: [definition] }; validateMcpGrants([grant]);
	config.agents.deepseek = { ...config.agents.deepseek!, enabled: true, defaultModel: "fixture", models: [{ id: "fixture", tier: "standard" }], workspace: "none", api: { ...config.agents.deepseek!.api!, apiKeyEnv: ["LEMMA_MCP_FIXTURE"], mcpServers: [grant], tools: [], bash: "off" } };
	process.env.LEMMA_MCP_FIXTURE = "fixture"; app = await openApp(config, orch, BACKGROUND_CONTEXT);
	const member = await app.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	await member.configure({ model: orch.ref, extensions: [createMemberTools("deepseek", config.agents.deepseek.api!)] }, BACKGROUND_CONTEXT);
	assert(!(await app.root.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name.startsWith("mcp_")));
	const run = async (error: boolean) => { let result: any; orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp_records_lookup", { query: "42" })], { stopReason: "toolUse" }), (request: any) => { result = toolResults(request).at(-1); return fauxAssistantMessage(fauxText("OK")); }]);
		await (await member.submit({ type: "input", content: "lookup" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT); assert.equal(result.isError, error, result.text); return result.text; };
	assert((await run(false)).includes("mcp-fixture")); assert.equal(executed, 1);
	reordered = true; await run(false); assert.equal(executed, 2);
	changed = true; await run(true); assert.equal(executed, 2);
	check(true, "官方 MCP SDK：跨页授权核验，Schema 键顺序变化不误报，成员隔离与真实定义变更拦截");
	const file = join(config.workdir, "mcp-settings.json"); writeFileSync(file, JSON.stringify(config));
	let current = config, answers: string[] = [], logs: string[] = [];
	const host: MemberSettingsHost = { path: file, config: () => current, assertIdle: async () => {}, question: async (question) => { assert(answers.length, question.title); return answers.shift()!; }, commit: async (draft, next) => { const apply = app!.prepareMembers(next); draft.save(); apply(); current = next; }, log: (message) => logs.push(message) };
	const rootId = app.root.id;
	answers = [url, "", "lookup"]; await memberSettingsCommand("/mcp add deepseek extra", host); assert.equal(answers.length, 0);
	assert.equal(loadConfig(file).agents.deepseek!.api!.mcpServers!.length, 2); assert.equal(app.root.id, rootId);
	await memberSettingsCommand("/mcp list deepseek", host); assert(logs.join("\n").includes("lookup"));
	changed = false; answers = ["", "lookup"]; await memberSettingsCommand("/mcp refresh deepseek extra", host);
	const before = readFileSync(file, "utf8"); answers = [url, "", "change_data"];
	await assert.rejects(memberSettingsCommand("/mcp add deepseek invalid", host), /只读/); assert.equal(readFileSync(file, "utf8"), before);
	await memberSettingsCommand("/mcp remove deepseek extra", host); assert.equal(current.agents.deepseek!.api!.mcpServers!.length, 1);
	check(true, "MCP 终端向导新增、刷新、移除即时生效，拒绝写工具授权且不改变旧会话");
} finally { await app?.harness.close(BACKGROUND_CONTEXT); for (const connection of connections) await connection.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); delete process.env.LEMMA_MCP_FIXTURE; }
