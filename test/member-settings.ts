import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.ts";
import { editSettings } from "../src/settings.ts";
import { memberSettingsCommand, type MemberSettingsHost } from "../src/member-settings.ts";
import { readCredential } from "../src/credentials.ts";
import { memberKey } from "../src/api-member.ts";
import { createOrchestratorModel } from "../src/models.ts";
import { openApp } from "../src/app.ts";
import { check, fauxOrchestrator } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "lemma-settings-"));
const file = join(directory, "config.json");
const oldCredentialFile = process.env.LEMMA_CREDENTIALS_FILE;
process.env.LEMMA_CREDENTIALS_FILE = join(directory, "secrets/credentials.json");
writeFileSync(file, JSON.stringify({ workdir: ".", storage: "./session.sqlite", customSetting: { retained: true }, agents: { claude: { enabled: false }, codex: { enabled: false }, gemini: { enabled: false }, deepseek: { enabled: false } } }));
let config = loadConfig(file);
const orchestrator = fauxOrchestrator();
const app = await openApp(config, orchestrator, BACKGROUND_CONTEXT);
const harness = app.harness, rootId = app.root.id;
let answers: string[] = [];
let busy = false;
const logs: string[] = [];
const host: MemberSettingsHost = { path: file, config: () => config,
	question: async (question) => { assert(answers.length, `Unexpected question: ${question.title}`); return answers.shift()!; },
	assertIdle: async () => { if (busy) throw new Error("busy"); },
	commit: async (draft, next, controller) => {
		const apply = app.prepareMembers(next); draft.save(); apply(); config = next;
		if (controller) assert(createOrchestratorModel(next.orchestrator).models.getModel("orchestrator", next.orchestrator.modelId));
	}, log: (message) => logs.push(message),
};
try {
	answers = ["研究员", "分析交付的材料", "保留证据来源", "openai-compatible", "https://provider.invalid/v1", "model-one", "none", "read", "SECRET_FIXTURE_NOT_FOR_CHAT"];
	assert(await memberSettingsCommand("/agent add researcher", host));
	assert.equal(answers.length, 0);
	assert((await app.root.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name === "ask_researcher"));
	assert.equal(app.harness, harness); assert.equal(app.root.id, rootId);
	assert.equal((await app.root.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.length, 0);
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert(saved.customSetting.retained); assert(!JSON.stringify(saved).includes("SECRET_FIXTURE"));
	assert.equal(readCredential(saved.agents.researcher.api.credential), "SECRET_FIXTURE_NOT_FOR_CHAT");
	assert.equal(memberKey(config.agents.researcher.api!).key, "SECRET_FIXTURE_NOT_FOR_CHAT");
	assert.equal(loadConfig(file).agents.researcher.name, "研究员");
	check(true, "终端配置：新增成员即时进入同一个 Harness，原会话不变，配置重载可恢复且无模型请求");
	await memberSettingsCommand("/agent disable researcher", host);
	assert(!(await app.root.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name === "ask_researcher"));
	await memberSettingsCommand("/agent enable researcher", host);
	await memberSettingsCommand("/agent model researcher model-two", host);
	assert.equal(config.agents.researcher.defaultModel, "model-two");
	assert(orchestrator.models.getModel("member-researcher", "model-two"));
	answers = ["替换密钥"]; await memberSettingsCommand("/agent key researcher", host);
	assert.equal(memberKey(config.agents.researcher.api!).key, "替换密钥");
	await memberSettingsCommand("/agent show researcher", host);
	assert(!logs.join("\n").includes("替换密钥")); assert(!logs.join("\n").includes("SECRET_FIXTURE_NOT_FOR_CHAT"));
	check(true, "成员管理：启停、模型和密钥变更生效，凭据不会进入配置展示或聊天记录");
	answers = ["查询资料", "https://business.invalid/records", "GET", JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }), "TOOL_SECRET_FIXTURE"];
	await memberSettingsCommand("/tool add researcher lookup", host);
	assert.equal(answers.length, 0); assert.equal(config.agents.researcher.api!.httpTools![0]!.id, "lookup");
	assert.equal(readCredential(config.agents.researcher.api!.httpTools![0]!.auth!.credential), "TOOL_SECRET_FIXTURE");
	assert(!readFileSync(file, "utf8").includes("TOOL_SECRET_FIXTURE"));
	await memberSettingsCommand("/tool list researcher", host); assert(!logs.join("\n").includes("TOOL_SECRET_FIXTURE"));
	answers = ["TOOL_SECRET_REPLACED"]; await memberSettingsCommand("/tool key researcher lookup", host);
	assert.equal(readCredential(config.agents.researcher.api!.httpTools![0]!.auth!.credential), "TOOL_SECRET_REPLACED");
	assert.equal(loadConfig(file).agents.researcher.api!.httpTools![0]!.id, "lookup");
	await memberSettingsCommand("/tool remove researcher lookup", host); assert.equal(config.agents.researcher.api!.httpTools!.length, 0);
	assert.equal(app.harness, harness); assert.equal(app.root.id, rootId);
	check(true, "业务工具向导：新增、凭据更新、重载与移除不重建运行时，不泄漏密钥");
	let query = "", requests = 0; const server = createServer((req, res) => { requests++; query = new URL(req.url!, "http://fixture").searchParams.get("query") ?? ""; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ value: 42 })); });
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	try {
		const url = `http://127.0.0.1:${(server.address() as any).port}/records`;
		answers = ["字段查询", url, "GET", "fields", "query", "string", "查询词", "yes", "-", ""];
		await memberSettingsCommand("/tool add researcher fields_lookup", host); assert.equal(answers.length, 0);
		assert.deepEqual(config.agents.researcher.api!.httpTools![0]!.parameters, { type: "object", properties: { query: { type: "string", description: "查询词" } }, required: ["query"], additionalProperties: false });
		answers = ['{"query":"forty two"}']; await memberSettingsCommand("/tool test researcher fields_lookup", host); assert.equal(requests, 1); assert.equal(query, "forty two");
		answers = ['{}']; await memberSettingsCommand("/tool test researcher fields_lookup", host); assert.equal(requests, 1);
		answers = ["提交资料", url, "POST", '{"type":"object","properties":{}}', "-", ""]; await memberSettingsCommand("/tool add researcher submit_record", host);
		await assert.rejects(memberSettingsCommand("/tool test researcher submit_record", host), /只运行 GET/); assert.equal(requests, 1);
	} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
	answers = ["3", "2", "1", "2.5", "0.2"]; await memberSettingsCommand("/limits edit", host);
	assert.deepEqual(loadConfig(file).execution, { maxConcurrent: 3, perMember: 2, perService: 1 }); assert.equal(config.budget.reservePerDispatchUsd, 0.2); assert.equal(config.budget.perRunUsd, 2.5);
	await memberSettingsCommand("/limits", host);
	const priorLimits = readFileSync(file, "utf8"); answers = ["0", "2", "1", "2.5", "0.2"]; await assert.rejects(memberSettingsCommand("/limits edit", host)); assert.equal(readFileSync(file, "utf8"), priorLimits);
	check(true, "字段向导与 GET 实测无需模型，参数校验与 POST 保护有效，并发预算配置可重载");
	answers = ["anthropic-compatible", "https://controller.invalid", "controller-model", "CONTROLLER_SECRET"];
	await memberSettingsCommand("/setup", host);
	assert.equal(loadConfig(file).orchestrator.modelId, "controller-model");
	assert.equal(readCredential(config.orchestrator.credential), "CONTROLLER_SECRET");
	check(true, "总控设置：终端向导保存协议、服务、模型与本机凭据引用");
	const before = readFileSync(file, "utf8"); busy = true;
	await assert.rejects(memberSettingsCommand("/agent disable researcher", host), /busy/); busy = false;
	assert.equal(readFileSync(file, "utf8"), before);
	const cancelled = { ...host, question: async () => { throw new Error("cancelled"); } };
	await assert.rejects(memberSettingsCommand("/agent edit researcher", cancelled), /cancelled/);
	assert.equal(readFileSync(file, "utf8"), before);
	const draft = editSettings(file); draft.apply((raw) => { raw.agents!.researcher.enabled = false; });
	writeFileSync(file, before + "\n"); assert.throws(() => draft.save(), /其他操作修改/);
	assert.equal(readFileSync(file, "utf8"), before + "\n");
	assert.equal(await memberSettingsCommand("/unknown", host), false);
	await assert.rejects(memberSettingsCommand("/setup extra", host), /用法/);
	check(true, "配置保护：忙碌时拒绝修改，取消不写入，外部编辑不会被覆盖");
} finally { await app.harness.close(BACKGROUND_CONTEXT); if (oldCredentialFile === undefined) delete process.env.LEMMA_CREDENTIALS_FILE; else process.env.LEMMA_CREDENTIALS_FILE = oldCredentialFile; }
