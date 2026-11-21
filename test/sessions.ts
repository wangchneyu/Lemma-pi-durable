import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { SessionCatalog } from "../src/sessions.ts";
import { Learning } from "../src/learning.ts";
import { AgentSessions } from "../src/dispatch.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const base = testConfig();
const catalog = new SessionCatalog(base);
catalog.create("frontend");
catalog.create("backend");
catalog.rename("frontend", "前端工作");
catalog.rename("default", "原来的对话");
catalog.select("backend");
assert.equal(new SessionCatalog(base).selected(), "backend");
assert.equal(new SessionCatalog(base).get("default").title, "原来的对话");
assert.equal(new SessionCatalog(base).get("frontend").title, "前端工作");
assert.throws(() => catalog.create("../escape"));
assert.throws(() => catalog.create("con"));
assert.throws(() => catalog.create("frontend"));
assert.notEqual(catalog.config("frontend").storage, catalog.config("backend").storage);
check(true, "命名会话持久化、独立存储、拒绝重复编号和越界路径");
const context = BACKGROUND_CONTEXT;
const oa = fauxOrchestrator();
const ob = fauxOrchestrator();
const a = await openApp(catalog.config("frontend"), oa, context);
const b = await openApp(catalog.config("backend"), ob, context);
try {
	oa.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [{ title: "前端独有任务" }] }, { id: "p-a" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("前端独立完成")),
	]);
	ob.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [{ title: "后端独有任务" }] }, { id: "p-b" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("后端独立完成")),
	]);
	const outcomes = await Promise.all([a.root, b.root].map(async (root, index) => (await root.submit({ type: "input", content: index ? "后端私有需求" : "前端私有需求" }, context)).wait(context)));
	assert.ok(outcomes.every((r) => r.status === "done"));
	assert.equal((await a.harness.snapshot(Board, context))?.tasks.T1?.title, "前端独有任务");
	assert.equal((await b.harness.snapshot(Board, context))?.tasks.T1?.title, "后端独有任务");
	assert.notEqual(a.project.assignPath, b.project.assignPath);
	assert.ok(readFileSync(a.project.assignPath, "utf8").includes("前端独有任务"));
	assert.ok(!readFileSync(a.project.assignPath, "utf8").includes("后端独有任务"));
	assert.ok(!existsSync(join(base.workdir, ".pi-agent", "ASSIGN.md")));
	assert.ok(!JSON.stringify(await b.root.entries({}, 100, undefined, context)).includes("前端私有需求"));
	assert.equal(await b.harness.snapshot(Learning, context), undefined);
	check(true, "两个会话并行运行，对话、任务编号、分工文件和学习记录互不混入");
	oa.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "成员甲私有片段" }, { id: "member-a" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("成员甲完成")),
	]);
	await (await a.root.submit({ type: "input", content: "总控私有历史，禁止自动转给成员" }, context)).wait(context);
	const memberRegistry = (await a.harness.snapshot(AgentSessions, context))!.sessions;
	const memberId = Object.keys(memberRegistry)[0]!;
	assert.equal(memberRegistry[memberId]!.controllerId, String(a.root.id));
	const firstMember = fakeCalls(base).find((call) => call.kind === "claude")!;
	assert.ok(!firstMember.prompt.includes("总控私有历史") && !firstMember.prompt.includes("前端私有需求"));
	oa.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_codex", { task: "独立成员乙的任务" }, { id: "member-b" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("成员乙完成")),
	]);
	await (await a.root.submit({ type: "input", content: "请独立派工" }, context)).wait(context);
	assert.ok(!fakeCalls(base).find((call) => call.kind === "codex")!.prompt.includes("成员甲私有片段"));
	check(true, "成员有独立上下文并登记总控 ID，不自动继承总控私聊或其他成员聊天");
	const before = fakeCalls(base).length;
	let crossResult = "";
	ob.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "越界续接", session_id: memberId }, { id: "cross-member" })], { stopReason: "toolUse" }),
		(ctx: any) => { crossResult = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("已拦截")); },
	]);
	await (await b.root.submit({ type: "input", content: "测试其他会话 ID" }, context)).wait(context);
	assert.ok(crossResult.includes("不能跨会话续接"));
	assert.equal(fakeCalls(base).length, before);
	check(true, "成员 ID 来自其他会话时拒绝派工，不调用 CLI");
	const od = fauxOrchestrator();
	const defaultApp = await openApp(base, od, context);
	try {
		od.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_claude", { task: "默认会话越界续接", session_id: memberId }, { id: "default-cross" })], { stopReason: "toolUse" }),
			(ctx: any) => { crossResult = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("已拦截")); },
		]);
		await (await defaultApp.root.submit({ type: "input", content: "默认会话也要隔离" }, context)).wait(context);
		assert.ok(crossResult.includes("不能跨会话续接"));
		assert.equal(fakeCalls(base).length, before);
		check(true, "default 同样拒绝未登记的成员 ID，不留跨会话续接例外");
	} finally { await defaultApp.harness.close(context); }
} finally { await Promise.all([a.harness.close(context), b.harness.close(context)]); }
const reopened = await openApp(catalog.config("frontend"), fauxOrchestrator(), context);
try {
	assert.equal((await reopened.harness.snapshot(Board, context))?.tasks.T1?.title, "前端独有任务");
	check(true, "重启后按会话编号恢复对应历史和分工");
} finally { await reopened.harness.close(context); }
