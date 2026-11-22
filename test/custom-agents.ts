import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.ts";
import { openApp } from "../src/app.ts";
import { startAdmin } from "../src/admin.ts";
import { AgentSessions, RunBudget } from "../src/dispatch.ts";
import { Results } from "../src/results.ts";
import { Board } from "../src/board.ts";
import { Learning } from "../src/learning.ts";
import { listNativeConversations } from "../src/terminal-state.ts";
import { createMemberTools } from "../src/api-member.ts";
import { terminalText } from "../src/terminal.ts";
import { check, fauxOrchestrator, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const bounded = () => withAbortSignal(AbortSignal.timeout(15000), context);
const directory = mkdtempSync(join(tmpdir(), "lemma-custom-api-"));
const configPath = join(directory, "pi-agent.config.json");
type Call = { member: string; body: any; key?: string };
const calls: Call[] = [];
let parallel = false;
let pending: (() => void)[] = [];
let paused = false;
let running: (() => void) | undefined;
let aborted = 0;
const server = createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const member = req.url!.split("/")[1]!;
	const body = JSON.parse(Buffer.concat(chunks).toString());
	calls.push({ member, body, key: req.headers.authorization ?? req.headers["x-api-key"] as string | undefined });
	if (paused) {
		running?.();
		res.on("close", () => { aborted++; });
		return;
	}
	if (parallel) {
		await new Promise<void>((resolve) => { pending.push(resolve); if (pending.length === 2) { parallel = false; for (const done of pending.splice(0)) done(); } });
	}
	const text = member === "analyst" ? "ANALYSIS_EVIDENCE_42" : "REVIEW_EVIDENCE_84";
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (member === "reviewer") {
		for (const event of [
			{ type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", content: [], model: "shared-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
			{ type: "message_stop" },
		]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		res.end(); return;
	}
	const hasResult = body.messages.some((message: any) => message.role === "tool");
	const controllerDelta = hasResult ? { role: "assistant", content: "TERMINAL_REPORT_COMPLETE" } : { role: "assistant", tool_calls: [{ index: 0, id: "terminal-role-call", type: "function", function: { name: "ask_analyst", arguments: JSON.stringify({ task: "TERMINAL_DOMAIN_INPUT" }) } }] };
	for (const chunk of [
		{ id: `response-${calls.length}`, object: "chat.completion.chunk", created: 1, model: "shared-model", choices: [{ index: 0, delta: member === "controller" ? controllerDelta : { role: "assistant", content: text }, finish_reason: null }] },
		{ id: `response-${calls.length}`, object: "chat.completion.chunk", created: 1, model: "shared-model", choices: [{ index: 0, delta: {}, finish_reason: member === "controller" && !hasResult ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
	]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const api = (member: string) => ({ type: member === "reviewer" ? "anthropic-compatible" : "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/${member}/v1`, apiKeyEnv: ["LEMMA_TEST_CUSTOM_KEY"] });
const input = {
	collaboration: { instructions: "COMPANY_REPORT_DOMAIN: use supplied evidence only." },
	workdir: ".", storage: "./data/session.sqlite", isolation: { enabled: true },
	// Deliberately enable coding checks: domain agents must never run them.
	autonomy: { enabled: true, maxRepairAttempts: 2, resultMaxChars: 500, checks: [{ name: "must not run", command: process.execPath, args: ["-e", "require('fs').writeFileSync('BAD_CODE_CHECK','bad');process.exit(1)"] }] },
	agents: { claude: { enabled: false }, codex: { enabled: false }, gemini: { enabled: false }, deepseek: { enabled: false },
		analyst: { name: "数据分析员", description: "分析输入数据", instructions: "ANALYST_ONLY: preserve units.", defaultModel: "shared-model", models: [{ id: "shared-model", tier: "standard", price: { input: 1, output: 2 } }], api: api("analyst") },
		reviewer: { name: "证据审查员", description: "核对材料依据", instructions: "REVIEWER_ONLY: check evidence.", models: [{ id: "shared-model", tier: "standard" }], api: api("reviewer") },
	},
};
writeFileSync(configPath, JSON.stringify(input));
process.env.LEMMA_TEST_CUSTOM_KEY = "fixture-custom-key";
const config = loadConfig(configPath);
const orchestrator = fauxOrchestrator();
let app = await openApp(config, orchestrator, context);
let admin: Awaited<ReturnType<typeof startAdmin>> | undefined;
let reportA: any;
let sessionA = "";
try {
	assert.equal(config.agents.analyst.workspace, "none");
	assert.deepEqual(config.agents.analyst.api!.tools, []);
	assert.equal(config.agents.reviewer.defaultModel, "shared-model");
	assert.equal(app.agents.filter((a) => a.available).length, 2);
	assert.deepEqual(config.roles, []);
	check(true, "自定义角色：两个同模型 API 成员无需 CLI，默认无文件或命令权限");
	parallel = true;
	orchestrator.faux.setResponses([
		(request: any) => {
			const text = JSON.stringify(request.messages); assert(text.includes("COMPANY_REPORT_DOMAIN"));
			return fauxAssistantMessage([fauxToolCall("ask_analyst", { task: "ANALYST_INPUT_ONLY" }, { id: "analyst-one" }), fauxToolCall("ask_reviewer", { task: "REVIEWER_INPUT_ONLY" }, { id: "reviewer-one" })], { stopReason: "toolUse" });
		},
		(request: any) => {
			const results = toolResults(request); assert(results.slice(-2).every((r) => !r.isError));
			reportA = results.find((r) => r.name === "ask_analyst")!.text;
			sessionA = reportA.match(/session_id: ([0-9]+)/)![1]!;
			return fauxAssistantMessage(fauxText("REPORT_READY"));
		},
	]);
	assert.equal((await (await app.root.submit({ type: "input", content: "CONTROLLER_PRIVATE_INPUT" }, context)).wait(bounded())).status, "done");
	assert.equal(calls.length, 2);
	for (const call of calls) {
		const text = JSON.stringify(call.body);
		assert(!text.includes("CONTROLLER_PRIVATE_INPUT"));
		assert(text.includes(call.member === "analyst" ? "ANALYST_ONLY" : "REVIEWER_ONLY"));
		assert(!text.includes(call.member === "analyst" ? "REVIEWER_INPUT_ONLY" : "ANALYST_INPUT_ONLY"));
		assert.equal(call.key, call.member === "reviewer" ? "fixture-custom-key" : "Bearer fixture-custom-key");
		assert(!call.body.tools?.length);
	}
	assert.equal(app.changes.list().length, 0); assert(!existsSync(join(directory, "data/worktrees"))); assert(!existsSync(join(directory, "BAD_CODE_CHECK")));
	assert.equal(await app.harness.snapshot(Learning, context), undefined);
	assert((await app.harness.snapshot(RunBudget, context))!.spent > 0);
	check(true, "通用派工：真实 HTTP 模型适配器并行执行、上下文隔离、计费入账且不运行 Git 或代码检查");

	const children = await listNativeConversations(app.harness, app.root, context);
	assert.equal(children.length, 3);
	assert(children.some((c) => c.id === sessionA && c.title.startsWith("数据分析员")));
	admin = await startAdmin({ app, config, configPath, orchestrator: { ...orchestrator, describe: "faux" }, demo: false, port: 0, context });
	const state = await (await fetch(`${admin.url}/api/state`)).json() as any;
	const member = state.agents.find((m: any) => m.kind === "analyst");
	assert.equal(member.label, "数据分析员"); assert.equal(member.transport, "api"); assert.equal(member.workspace, "none"); assert.deepEqual(member.api.tools, []);
	assert(!JSON.stringify(state).includes("fixture-custom-key"));
	const topology = await fetch(`${admin.url}/api/topology`); assert.equal(topology.status, 200);
	assert((await topology.text()).includes("数据分析员"));
	check(true, "既有界面：原生会话选择器可浏览自定义成员，网页显示真实角色、接入方式和权限");
	await admin.close(); admin = undefined;
	await app.harness.close(context);
	app = await openApp(config, orchestrator, context);
	const sessions = (await app.harness.snapshot(AgentSessions, context))!.sessions;
	assert.equal(sessions[sessionA]!.agent, "analyst");
	orchestrator.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_analyst", { task: "CHANGE_ONLY_FOLLOWUP", session_id: sessionA }, { id: "followup" })], { stopReason: "toolUse" }),
		(request: any) => { assert(toolResults(request).at(-1)!.text.includes(`session_id: ${sessionA}`)); return fauxAssistantMessage(fauxText("FOLLOWUP_READY")); },
	]);
	assert.equal((await (await app.root.submit({ type: "input", content: "Continue with changes" }, context)).wait(bounded())).status, "done");
	const resumed = JSON.stringify(calls.at(-1)!.body); assert(resumed.includes("ANALYST_INPUT_ONLY") && resumed.includes("CHANGE_ONLY_FOLLOWUP"));
	assert.equal((await listNativeConversations(app.harness, app.root, context)).length, 3);
	const resultId = reportA.match(/result_id: ([^\s|\]]+)/)![1]!;
	assert.equal((await app.harness.snapshot(Results, app.root.id, resultId, context))?.result?.text, "ANALYSIS_EVIDENCE_42");
	check(true, "持久化：重开后沿用原成员会话和历史，旧结果全文仍可读取");

	const before = calls.length;
	orchestrator.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_reviewer", { task: "Wrong member", session_id: sessionA }, { id: "wrong-member" }), fauxToolCall("ask_analyst", { task: "No code branch", based_on: "any" }, { id: "wrong-workspace" })], { stopReason: "toolUse" }),
		(request: any) => { assert(toolResults(request).slice(-2).every((r) => r.isError)); return fauxAssistantMessage(fauxText("REFUSED")); },
	]);
	await (await app.root.submit({ type: "input", content: "Check boundaries" }, context)).wait(bounded());
	assert.equal(calls.length, before);
	check(true, "边界：拒绝跨成员续接及领域 Agent 的 based_on，不发送额外模型请求");

	orchestrator.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [{ title: "核对报告数据", role: "分析", acceptance: "提供数字依据并列出缺失材料" }] }, { id: "domain-plan" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("ask_analyst", { task: "BACKGROUND_DOMAIN_TASK", task_id: "T1", background: true }, { id: "domain-background" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("wait_jobs", { mode: "all" }, { id: "domain-wait" })], { stopReason: "toolUse" }),
		(request: any) => {
			assert(toolResults(request).at(-1)!.text.includes("ANALYSIS_EVIDENCE_42"));
			return fauxAssistantMessage([fauxToolCall("update_task", { id: "T1", status: "done", note: "根据已收到的固定测试证据验收" }, { id: "domain-accept" })], { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage(fauxText("BACKGROUND_ACCEPTED")),
	]);
	assert.equal((await (await app.root.submit({ type: "input", content: "Run domain background task" }, context)).wait(bounded())).status, "done");
	assert.equal((await app.harness.snapshot(Board, context))?.tasks.T1?.status, "done");
	assert(!existsSync(join(directory, "BAD_CODE_CHECK")));
	check(true, "业务任务：自定义成员支持任务看板、后台派工、等待与验收，不套用代码检查");

	config.budget.perRunUsd = 0;
	const budgetCalls = calls.length;
	orchestrator.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_analyst", { task: "BUDGET_REFUSAL" }, { id: "budget-refusal" })], { stopReason: "toolUse" }),
		(request: any) => { assert(toolResults(request).at(-1)!.isError); return fauxAssistantMessage(fauxText("BUDGET_STOPPED")); },
	]);
	await (await app.root.submit({ type: "input", content: "Check budget" }, context)).wait(bounded());
	assert.equal(calls.length, budgetCalls); config.budget.perRunUsd = 3;
	const reader = createMemberTools("reader", { ...config.agents.analyst.api!, tools: ["read"] });
	assert.deepEqual(reader.tools?.map((tool) => tool.name), ["read"]);
	check(true, "权限与预算：显式 read 授权不附带写入或 shell，预算耗尽时拒绝 API 请求");

	paused = true;
	const active = new Promise<void>((resolve) => { running = resolve; });
	orchestrator.faux.setResponses([() => fauxAssistantMessage([fauxToolCall("ask_analyst", { task: "WAIT_FOR_CANCELLATION", session_id: sessionA }, { id: "cancel-resume" })], { stopReason: "toolUse" })]);
	const submission = await app.root.submit({ type: "input", content: "Start cancellable followup" }, context);
	await Promise.race([active, new Promise((_, reject) => setTimeout(() => reject(new Error("member did not start")), 10000).unref())]);
	await app.root.abort(bounded());
	assert.equal((await submission.wait(bounded())).status, "unanswered");
	await app.harness.waitForIdle(bounded());
	assert.equal((await app.harness.inspect(context)).tasks.length, 0);
	check(true, "取消：续接中的 API 成员随总控停止，没有遗留运行任务");

	await app.harness.close(context);
	const crashStarted = new Promise<void>((resolve) => { running = resolve; });
	const processChild = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./custom-agent-crash-child.ts", import.meta.url)), configPath], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
	let errors = ""; processChild.stderr.on("data", (chunk) => { errors += chunk; });
	const closed = new Promise<void>((resolve) => processChild.once("close", () => resolve()));
	try { await Promise.race([crashStarted, new Promise((_, reject) => setTimeout(() => reject(new Error(`Crash child did not start: ${errors}`)), 10000).unref())]); }
	finally { processChild.kill("SIGKILL"); await closed; }
	paused = false;
	orchestrator.faux.setResponses([(request: any) => { assert(toolResults(request).at(-1)!.text.includes("ANALYSIS_EVIDENCE_42")); return fauxAssistantMessage(fauxText("RECOVERED")); }]);
	app = await openApp(config, orchestrator, context);
	const submissionId = Number(readFileSync(join(directory, "crash-submission.txt"), "utf8"));
	const restored = await app.harness.submission(submissionId as any, context); assert(restored);
	assert.equal((await restored.wait(bounded())).status, "done");
	let crashConversations = 0;
	for (const item of await listNativeConversations(app.harness, app.root, context)) {
		if (item.id === String(app.root.id)) continue;
		const child = await app.harness.conversation(Number(item.id) as any, context);
		const entries = (await child!.entries({}, 100, undefined, context)).items;
		const matching = entries.filter((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("CRASH_RECOVERY_TASK"));
		if (matching.length) { crashConversations++; assert.equal(matching.length, 1); }
	}
	assert.equal(crashConversations, 1);
	check(true, "进程恢复：强制结束后找回原提交，复用同一个 API 子会话且不重复任务输入");

	const terminalConfig = join(directory, "terminal.json");
	writeFileSync(terminalConfig, JSON.stringify({ ...input, storage: "./data/terminal.sqlite",
		orchestrator: { ...api("controller"), modelId: "shared-model", apiKeyFromClaudeSettings: false },
		web: { enabled: true, port: 0 },
	}));
	const terminal = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./terminal-cli-child.ts", import.meta.url)), "--real", "--tui"], { env: { ...process.env, PI_AGENT_CONFIG: terminalConfig, PI_AGENT_DEMO: "0", LEMMA_CREDENTIALS_FILE: join(directory, "terminal-credentials.json"), TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
	let output = "", errorsOutput = "", exited = false;
	terminal.stdout.on("data", (chunk) => { output += chunk; }); terminal.stderr.on("data", (chunk) => { errorsOutput += chunk; });
	const terminalClosed = new Promise<number | null>((resolve) => terminal.once("close", (code) => { exited = true; resolve(code); }));
	const until = async (predicate: () => boolean) => {
		const deadline = Date.now() + 20000;
		while (!predicate() && !exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		assert(predicate(), `${errorsOutput}\n${terminalText(output).slice(-4000)}`);
	};
	const send = (value: string) => terminal.stdin.write(`\x1b[200~${value}\x1b[201~\x1b[13u`);
	try {
		await until(() => terminalText(output).includes("数据分析员") && output.includes("Enter"));
		terminal.stdin.write("\x1b[?1;2c");
		const configureMember = async () => {
			const beginning = output.length; send("/agent add helper");
			const steps = [
				["成员名称", "终端助手"], ["成员职责", "处理交付材料"], ["专属指令", "保留证据"],
				["API 协议", "openai-compatible"], ["API 服务地址", api("analyst").baseUrl], ["默认模型 ID", "shared-model"],
				["工作区", "none"], ["工具权限", "none"], ["API 密钥", "HIDDEN_TERMINAL_SETTING_KEY"],
			];
			for (const [title, answer] of steps) { await until(() => terminalText(output.slice(beginning)).includes(title!)); send(answer!); }
			await until(() => terminalText(output.slice(beginning)).includes("配置已保存并生效"));
		};
		await configureMember();
		assert(!output.includes("HIDDEN_TERMINAL_SETTING_KEY"));
		const savedConfig = JSON.parse(readFileSync(terminalConfig, "utf8"));
		assert.equal(savedConfig.agents.helper.name, "终端助手");
		assert(!JSON.stringify(savedConfig).includes("HIDDEN_TERMINAL_SETTING_KEY"));
		let operationStart = output.length; send("/agent disable helper");
		await until(() => terminalText(output.slice(operationStart)).includes("配置已保存并生效"));
		assert.equal(JSON.parse(readFileSync(terminalConfig, "utf8")).agents.helper.enabled, false);
		operationStart = output.length; send("/agent model helper second-model");
		await until(() => terminalText(output.slice(operationStart)).includes("配置已保存并生效"));
		assert.equal(JSON.parse(readFileSync(terminalConfig, "utf8")).agents.helper.defaultModel, "second-model");
		operationStart = output.length; send("/agent enable helper");
		await until(() => terminalText(output.slice(operationStart)).includes("配置已保存并生效"));
		check(true, "真实终端配置：斜杠向导新增、启停与选模型当场生效，密钥隐藏且不进入配置文件");
		operationStart = output.length; send("/tool add helper business_lookup");
		for (const [title, answer] of [["工具用途", "查询业务记录"], ["固定 HTTP(S)", api("analyst").baseUrl + "/records"], ["方法", "GET"], ["参数 JSON Schema", JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false })], ["Bearer 密钥", "HIDDEN_BUSINESS_TOOL_KEY"]]) {
			await until(() => terminalText(output.slice(operationStart)).includes(title!)); send(answer!);
		}
		await until(() => terminalText(output.slice(operationStart)).includes("业务工具 business_lookup 已保存"));
		assert(!output.includes("HIDDEN_BUSINESS_TOOL_KEY"));
		assert(!readFileSync(terminalConfig, "utf8").includes("HIDDEN_BUSINESS_TOOL_KEY"));
		assert.equal(JSON.parse(readFileSync(terminalConfig, "utf8")).agents.helper.api.httpTools[0].id, "business_lookup");
		check(true, "真实终端业务工具：/tool 向导保存参数和隐藏凭据，即时更新成员授权");
		const urlBefore = terminalText(output).match(/http:\/\/127[.]0[.]0[.]1:[0-9]+/)![0];
		const stateBefore = await (await fetch(`${urlBefore}/api/state`)).json() as any;
		operationStart = output.length; send("/setup");
		for (const [title, answer] of [["API 协议", "openai-compatible"], ["API 服务地址", api("controller").baseUrl], ["总控模型 ID", "controller-reconfigured"], ["API 密钥", "HIDDEN_CONTROLLER_SETTING_KEY"]]) {
			await until(() => terminalText(output.slice(operationStart)).includes(title!)); send(answer!);
		}
		await until(() => terminalText(output.slice(operationStart)).includes("总控配置已保存并生效"));
		assert(!output.includes("HIDDEN_CONTROLLER_SETTING_KEY"));
		const stateConfigured = await (await fetch(`${urlBefore}/api/state`)).json() as any;
		assert.equal(stateConfigured.startedAt, stateBefore.startedAt);
		assert.equal(stateConfigured.conversation.controllerId, stateBefore.conversation.controllerId);
		assert.equal(stateConfigured.orchestrator.modelId, "controller-reconfigured");
		send("请让数据分析员分析明确提供的资料");
		await until(() => terminalText(output).includes("TERMINAL_REPORT_COMPLETE"));
		assert(terminalText(output).includes("后台网页"));
		const url = terminalText(output).match(/http:\/\/127[.]0[.]0[.]1:[0-9]+/)![0];
		const terminalState = await (await fetch(`${url}/api/state`)).json() as any;
		assert(terminalState.sessions.some((session: any) => session.agent === "analyst"));
		assert(terminalState.agents.some((member: any) => member.kind === "helper" && member.available));
		assert(terminalState.agents.find((member: any) => member.kind === "helper").api.tools.includes("business_lookup"));
		assert(!JSON.stringify(terminalState).includes("HIDDEN_BUSINESS_TOOL_KEY"));
		const resultId = terminalText(output).match(/result_id: (dispatch:[^\s|\]]+)/)![1]!;
		operationStart = output.length; send(`/result ${resultId}`);
		await until(() => terminalText(output.slice(operationStart)).includes("ANALYSIS_EVIDENCE_42"));
		assert(!JSON.stringify(terminalState).includes("HIDDEN_TERMINAL_SETTING_KEY"));
		const history = await (await fetch(`${url}/api/history`)).text();
		assert(!history.includes("HIDDEN_TERMINAL_SETTING_KEY") && !history.includes("/agent add helper"));
		assert(!history.includes("HIDDEN_BUSINESS_TOOL_KEY") && !history.includes("/tool add") && !history.includes(`/result ${resultId}`));
		operationStart = output.length; send("/session new configured_session");
		await until(() => terminalText(output.slice(operationStart)).includes("已切换到 configured_session"));
		const switchedState = await (await fetch(`${url}/api/state`)).json() as any;
		assert.equal(switchedState.orchestrator.modelId, "controller-reconfigured");
		assert(switchedState.agents.some((member: any) => member.kind === "helper" && member.available));
		operationStart = output.length; send("/session use default");
		await until(() => terminalText(output.slice(operationStart)).includes("已切换到 default"));
		assert((await (await fetch(`${url}/api/history`)).text()).includes("TERMINAL_REPORT_COMPLETE"));
		check(true, "总控配置：/setup 立即更新同一运行时与网页，新会话沿用成员配置，切回旧会话保留历史");
		send("/exit"); await until(() => exited); assert.equal(await terminalClosed, 0);
		check(true, "真实终端入口：纯 API 团队完成派工与汇报，同步网页和成员会话并正常退出");
	} finally { if (!exited) { terminal.kill(); await terminalClosed; } }
} finally {
	await admin?.close();
	await app.harness.close(context); server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	delete process.env.LEMMA_TEST_CUSTOM_KEY;
}
