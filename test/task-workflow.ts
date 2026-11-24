import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { Jobs } from "../src/jobs.ts";
import { taskReadiness } from "../src/task-readiness.ts";
import { checkerVerdict, Workflow } from "../src/task-workflow.ts";
import { completionRefusal } from "../src/task-lifecycle.ts";
import { Results } from "../src/results.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";
const ctx = BACKGROUND_CONTEXT, config = testConfig(); config.isolation.enabled = false;
for (const kind of ["claude", "codex", "gemini"]) config.agents[kind]!.command = [process.execPath, fileURLToPath(new URL("./workflow-member.mjs", import.meta.url)), kind];
const orch = fauxOrchestrator(); let app = await openApp(config, orch, ctx);
const board = () => app.harness.snapshot(Board, ctx);
const wait = async (predicate: () => Promise<boolean>) => { const end = Date.now() + 20000; while (!(await predicate()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); assert(await predicate(), JSON.stringify(await board())); };
async function run(name: string, args: unknown, expectedError = false) {
	let reply: { text: string; isError: boolean } | undefined;
	orch.faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args as any)], { stopReason: "toolUse" }), (request: any) => { reply = toolResults(request).at(-1); return fauxAssistantMessage(fauxText("OK")); }, ...Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("状态已记录")))]);
	await (await app.root.submit({ type: "input", content: name }, ctx)).wait(withAbortSignal(AbortSignal.timeout(10000), ctx));
	assert(reply, name); assert.equal(reply.isError, expectedError, reply.text); return reply.text;
}
try {
	orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [
		{ title: "REWORK_CASE 基础资料", acceptance: "有来源", automation: { member: "claude", maxReworks: 1 }, reviewer: { member: "gemini" } },
		{ title: "独立并行计算", automation: { member: "codex" }, reviewer: { member: "gemini" } },
		{ title: "汇总依赖结果", deps: ["+1", "+2"], automation: { member: "claude" }, reviewer: { member: "gemini" } },
		{ title: "保留人工决定", deps: ["+3"] },
	] })], { stopReason: "toolUse" }), ...Array.from({ length: 60 }, () => fauxAssistantMessage(fauxText("收到协作状态")))]);
	await (await app.root.submit({ type: "input", content: "执行已明确授权的任务链" }, ctx)).wait(withAbortSignal(AbortSignal.timeout(10000), ctx));
	await wait(async () => (await board())?.tasks.T3?.status === "done");
	const state = (await board())!;
	assert.equal(state.tasks.T1!.checksByMember?.length, 2); assert.equal(state.tasks.T1!.checksByMember?.[0]?.status, "rework");
	assert.equal(state.tasks.T1!.checksByMember?.[1]?.status, "accepted"); assert.equal(state.tasks.T1!.recoveries?.length, 1);
	assert.equal(state.tasks.T2!.dispatches.length, 1); assert.equal(state.tasks.T3!.dispatches.length, 1);
	assert.equal(state.tasks.T4!.status, "todo"); assert(taskReadiness(state, state.tasks.T4!).ready);
	const calls = fakeCalls(config);
	assert(calls.filter((call) => call.kind === "claude").some((call) => call.args.includes("--resume") && call.prompt.includes("MISSING_SOURCE_EVIDENCE")));
	assert(calls.some((call) => call.prompt.includes("汇总依赖结果") && call.prompt.includes("显式交接资料")));
	const jobs = Object.values((await app.harness.snapshot(Jobs, ctx))!.jobs);
	assert.equal(jobs.length, 8); assert(jobs.every((job) => job.status === "done"));
	const firstJob = jobs.find((job) => job.taskId === "T1")!, secondJob = jobs.find((job) => job.taskId === "T2")!;
	assert(secondJob.startedAt < firstJob.endedAt!, "独立任务必须重叠执行，不能等首项结束才派第二项");
	assert(jobs.every((job) => job.delivered === "workflow"));
	assert(orch.faux.state.callCount <= 3, "中间派工与复核不应逐次唤醒总控");
	check(true, "两项并行交付独立复核，一项有限返工后重新复核，下游自动交接执行且不重复前置");
	await app.harness.close(ctx); app = await openApp(config, orch, ctx); app.harness.resume();
	await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal(fakeCalls(config).length, calls.length);
	assert.equal((await board())!.tasks.T1!.checksByMember?.length, 2);
	check(true, "重启保留任务链、独立复核和返工证据，不重复已完成派工；未授权任务仅进入就绪队列");
	assert.equal(checkerVerdict('{"verdict":"accept","result_id":"old","evidence":"ok"}', "new"), undefined);
	assert.equal(checkerVerdict("自称通过，没有 JSON", "new"), undefined);
	check(true, "复核结论必须为结构化证据且绑定具体交付版本");
	await app.workflow("pause", ctx);
	await run("plan_tasks", { tasks: [{ title: "暂停期间授权", automation: { member: "claude" }, reviewer: { member: "gemini" } }] });
	const pausedCalls = fakeCalls(config).length; await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal(fakeCalls(config).length, pausedCalls);
	await app.harness.close(ctx); app = await openApp(config, orch, ctx); app.harness.resume();
	assert((await app.workflow("status", ctx)).paused); assert.equal((await board())!.tasks.T5!.status, "todo");
	await app.workflow("resume", ctx); await wait(async () => (await board())!.tasks.T5!.status === "done");
	check(true, "暂停授权跨重启保留，显式恢复后接续待办任务且只执行一次");
	await app.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), ctx));
	await run("plan_tasks", { tasks: [
		{ title: "INVALID_CHECKER", automation: { member: "claude" }, reviewer: { member: "gemini" } },
		{ title: "STALE_CHECKER", automation: { member: "claude" }, reviewer: { member: "gemini" } },
		{ title: "ALWAYS_REWORK", automation: { member: "claude", maxReworks: 1 }, reviewer: { member: "gemini" } },
	] });
	await wait(async () => { const state = (await board())!; return ["T6", "T7", "T8"].every((id) => state.tasks[id]!.status === "blocked"); });
	assert.equal((await board())!.tasks.T8!.dispatches.length, 2);
	assert.equal((await board())!.tasks.T8!.checksByMember?.length, 2);
	await app.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), ctx));
	await run("review_task", { id: "T6", action: "accept", result_id: (await board())!.tasks.T6!.latestResult, evidence: "try bypass failed checker" }, true);
	await run("update_task", { id: "T6", status: "done", note: "try bypass independent review" }, true);
	await run("plan_tasks", { tasks: [{ title: "invalid self review", automation: { member: "claude" }, reviewer: { member: "claude" } }] }, true);
	check(true, "无效与过期复核均受阻，返工按上限停止，总控和旧 done 入口不能绕过独立复核");
	await app.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), ctx));
	process.env.FAKE_AGENT_DELAY_MS = "400";
	await run("plan_tasks", { tasks: [{ title: "重启中保留复核作业", automation: { member: "claude" }, reviewer: { member: "gemini" } }] });
	await wait(async () => (await board())!.tasks.T9!.checksByMember?.at(-1)?.status === "running");
	const interruptedCheck = (await board())!.tasks.T9!.checksByMember!.at(-1)!;
	await app.harness.close(ctx); app = await openApp(config, orch, ctx); app.harness.resume();
	await wait(async () => (await board())!.tasks.T9!.status === "done");
	assert.equal((await board())!.tasks.T9!.checksByMember?.length, 1);
	assert.equal((await board())!.tasks.T9!.checksByMember?.[0]?.jobId, interruptedCheck.jobId);
	assert.equal((await board())!.tasks.T9!.dispatches.length, 1);
	delete process.env.FAKE_AGENT_DELAY_MS;
	check(true, "复核进行中重启恢复原 Durable 作业，不新建复核版本或重跑执行者");
	await app.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), ctx));
	const completed = (await board())!, source = (await app.harness.snapshot(Results, app.root.id, completed.tasks.T9!.latestResult!, ctx))!.result!;
	const copy = structuredClone(completed); copy.tasks.T9!.checksByMember![0]!.sourceChangeId = "missing-change"; copy.tasks.T9!.checksByMember![0]!.sourceHead = "old-head";
	assert.match(completionRefusal(copy, copy.tasks.T9!, source, "evidence", config, app.changes)!, /代码版本/);
	check(true, "代码提交版本变化会使旧的独立复核通过结论失效");
	config.budget.perRunUsd = 0; const budgetCalls = fakeCalls(config).length;
	await run("plan_tasks", { tasks: [{ title: "预算不足未执行", automation: { member: "claude" } }] });
	await wait(async () => (await board())!.tasks.T10!.status === "blocked");
	assert.equal(fakeCalls(config).length, budgetCalls); assert(!(await board())!.tasks.T10!.activeDispatch);
	check(true, "自动执行沿用预算准入，预算不足不启动成员并释放任务占用");
	await app.harness.waitForIdle(withAbortSignal(AbortSignal.timeout(10000), ctx));
	await app.workflow("pause", ctx);
	await run("plan_tasks", { tasks: [{ title: "中止自动协作", automation: { member: "claude" } }] });
	await app.workflow("resume", ctx);
	const workflow = (await app.harness.snapshot(Workflow, ctx))!.controllers[String(app.root.id)]!;
	await app.harness.abortTask(Number(workflow.taskId) as any, ctx);
	await wait(async () => (await app.workflow("status", ctx)).paused);
	check(true, "中止 Durable 协调任务会持久暂停自动推进，避免自动重新拉起");
} finally { await app.harness.close(ctx); delete process.env.FAKE_AGENT_DELAY_MS; }
