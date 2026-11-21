// 后台派工（异步）：background: true 立刻返回；wait_jobs 收结果（any / all）；没人等时结果自动发回并触发总调度继续；
// 取消；同一个会话不能同时被两次派工续接；后台结果触发的运行不重置花费。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { Board, type BoardState } from "../src/board.ts";
import { RunBudget } from "../src/dispatch.ts";
import { JOB_REPORT_ENTRY, Jobs, type JobsState } from "../src/jobs.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
config.budget.perRunUsd = 10;
process.env.FAKE_AGENT_DELAY_MS = "1200"; // 成员慢一点，wait_jobs 才真的要等
const orch = fauxOrchestrator();
const { harness, root, jobs: hub } = await openApp(config, orch, context);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join(""));
const jobsDoc = async () => ((await harness.snapshot(Jobs, context)) as JobsState | undefined) ?? { jobs: {}, nextId: 1, byCall: {} };
const live = async () => (await harness.snapshot(LiveDoc, root.id, context)) as any;
async function until(what: string, ok: () => Promise<boolean>, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await ok()) return;
		await sleep(50);
	}
	throw new Error(`等待超时：${what}`);
}

// ---- 1. 两个后台派工 + wait_jobs all ----
let startTexts: string[] = [];
let waitText = "";
let startedAt = 0;
let returnedAt = 0;
orch.faux.setResponses([
	() => {
		startedAt = Date.now();
		return fauxAssistantMessage(
			[
				fauxToolCall("plan_tasks", { tasks: [{ title: "写设计", role: "设计" }, { title: "写实现", role: "编码" }] }, { id: "p1" }),
			],
			{ stopReason: "toolUse" },
		);
	},
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall("ask_claude", { task: "写设计", task_id: "T1", background: true }, { id: "b1" }),
				fauxToolCall("ask_codex", { task: "写实现", task_id: "T2", background: true }, { id: "b2" }),
			],
			{ stopReason: "toolUse" },
		),
	(ctx: any) => {
		returnedAt = Date.now();
		startTexts = toolResults(ctx).slice(-2).map((r) => r.text);
		return fauxAssistantMessage([fauxToolCall("wait_jobs", { mode: "all" }, { id: "w1" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		waitText = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage(fauxText("两项都完成了"));
	},
]);
await (await root.submit({ type: "input", content: "做个项目" }, context)).wait(context);
check(startTexts.every((t) => /已在后台开工 J\d/.test(t)), "后台派工立刻返回后台编号");
check(returnedAt - startedAt < 1000, `开后台派工不用等成员做完（${returnedAt - startedAt}ms）`);
check(waitText.includes("【后台结果 J1 · 完成】") && waitText.includes("【后台结果 J2 · 完成】"), "wait_jobs all 收齐两个结果");
check(waitText.includes("CLAUDE_OK") && waitText.includes("CODEX_OK"), "结果里有成员的回答");
let doc = await jobsDoc();
check(doc.jobs.J1?.status === "done" && doc.jobs.J2?.status === "done", "两个后台派工都标为完成");
check(doc.jobs.J1?.delivered === "wait" && doc.jobs.J2?.delivered === "wait", "结果由 wait_jobs 交付（没有另发消息）");
check(typeof doc.jobs.J1?.sessionId === "string", "记下了 Claude 的会话");
let board = (await harness.snapshot(Board, context)) as BoardState;
check(board.tasks.T1?.status === "review" && board.tasks.T2?.status === "review", "后台派工也会把任务标为待验收");
let entries = (await root.entries({}, 200, undefined, context)).items;
check(!entries.some((e) => e.kind === JOB_REPORT_ENTRY), "有人等时不发后台结果消息");

// ---- 2. 没人等：结果自动发回，触发总调度继续；花费不重置 ----
let reportSeen = "";
let reportRole = "";
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_gemini", { task: "调研风险", background: true }, { id: "b3" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("已在后台调研，结果出来再告诉你")),
	(ctx: any) => {
		const last = ctx.messages.filter((m: any) => m.role !== "system").at(-1);
		reportRole = last?.role;
		reportSeen = textOf(last);
		return fauxAssistantMessage(fauxText("收到 J3 的结果：调研完成"));
	},
]);
const before = (await harness.snapshot(RunBudget, context)) as any;
await (await root.submit({ type: "input", content: "调研一下" }, context)).wait(context);
const runKeyAfterAsk = ((await harness.snapshot(RunBudget, context)) as any).runKey;
check(runKeyAfterAsk !== before?.runKey, "新的用户输入开始新一轮花费计数");
await until("后台结果发回并被处理", async () => reportSeen !== "" && (await live())?.run === undefined);
check(reportRole === "user" && reportSeen.startsWith("【后台结果 J3 · 完成】"), "后台结果作为一条消息发回总调度");
check(reportSeen.includes("GEMINI_OK") && reportSeen.includes("不是用户的新要求"), "消息里有结果和说明");
entries = (await root.entries({}, 300, undefined, context)).items;
const report = entries.find((e) => e.kind === JOB_REPORT_ENTRY) as any;
check(report && report.data?.job === "J3", "对话里记成后台结果条目（不是用户输入）");
doc = await jobsDoc();
check(doc.jobs.J3?.delivered === "report", "J3 标为已自动发回");

// 后台结果触发的运行里再派工：仍算原来那一轮
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_gemini", { task: "再查一项", background: true }, { id: "b4" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("派出 J4")),
	() => fauxAssistantMessage([fauxToolCall("ask_claude", { task: "根据结果补充" }, { id: "s5" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("补充完成")),
]);
await (await root.submit({ type: "input", content: "再查一项" }, context)).wait(context);
const keyBefore = ((await harness.snapshot(RunBudget, context)) as any).runKey;
await until("J4 的结果触发的运行结束", async () => (await jobsDoc()).jobs.J4?.delivered === "report" && (await live())?.run === undefined && fakeCalls(config).some((c) => c.prompt.includes("根据结果补充")));
const keyAfter = ((await harness.snapshot(RunBudget, context)) as any).runKey;
check(keyAfter === keyBefore, "后台结果触发的运行不重置花费计数");

// ---- 3. 取消 + wait_jobs any ----
process.env.FAKE_AGENT_DELAY_MS = "6000";
let cancelText = "";
let anyText = "";
orch.faux.setResponses([
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall("plan_tasks", { tasks: [{ title: "慢任务" }] }, { id: "p3" }),
				fauxToolCall("ask_codex", { task: "很慢的实现", background: true }, { id: "b6" }),
			],
			{ stopReason: "toolUse" },
		),
	() => fauxAssistantMessage([fauxToolCall("ask_claude", { task: "也很慢", task_id: "T3", background: true }, { id: "b7" })], { stopReason: "toolUse" }),
	async () => {
		await sleep(400);
		return fauxAssistantMessage([fauxToolCall("cancel_job", { id: "J6" }, { id: "c1" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		cancelText = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage([fauxToolCall("wait_jobs", { ids: ["J5", "J6"], mode: "any" }, { id: "w2" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		anyText = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage([fauxToolCall("cancel_job", { id: "J5" }, { id: "c2" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage(fauxText("都取消了")),
]);
await (await root.submit({ type: "input", content: "试试取消" }, context)).wait(context);
check(cancelText.includes("已取消 J6"), "cancel_job 取消后台派工");
check(anyText.includes("【后台结果 J6 · 已取消】") && anyText.includes("还在进行：J5"), "wait_jobs any 有一个结束就返回，并列出还在进行的");
await until("J5 取消完成", async () => (await jobsDoc()).jobs.J5?.status === "cancelled");
doc = await jobsDoc();
check(doc.jobs.J6?.status === "cancelled" && doc.jobs.J6?.cancelledBy === "orchestrator", "J6 记为总调度取消");
board = (await harness.snapshot(Board, context)) as BoardState;
check(board.tasks.T3?.status === "todo", "被取消的任务退回待办");
await sleep(300);
entries = (await root.entries({}, 400, undefined, context)).items;
check(!entries.some((e) => e.kind === JOB_REPORT_ENTRY && (e as any).data?.job === "J5"), "总调度自己取消的不再发消息");

// ---- 4. 同一个会话不能同时被两次派工续接 ----
process.env.FAKE_AGENT_DELAY_MS = "2000";
const sid = doc.jobs.J1!.sessionId!;
let busyText = "";
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_claude", { task: "接着写设计", session_id: sid, background: true }, { id: "b8" })], { stopReason: "toolUse" }),
	async () => {
		await until("J7 开始执行", async () => hub.busySessions.has(sid), 5000);
		return fauxAssistantMessage([fauxToolCall("ask_claude", { task: "同时也改一下", session_id: sid }, { id: "s9" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		busyText = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage([fauxToolCall("wait_jobs", {}, { id: "w3" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage(fauxText("好")),
]);
await (await root.submit({ type: "input", content: "续接" }, context)).wait(context);
check(busyText.includes("正在被") && busyText.includes("J7"), "会话正被后台派工使用时拒绝同时续接");
const resumed = fakeCalls(config).filter((c) => c.kind === "claude" && c.args.includes("--resume") && c.args.includes(sid));
check(resumed.length === 1, "后台续接用 --resume 回到同一个会话");

await harness.close(context);
console.log("\n全部通过 ✅");
