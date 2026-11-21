// 子调度：总调度把子目标交给子负责人（Pi Durable 子对话），它自己拆任务、并行派成员、收齐后台派工后汇报。
// 检查：只有一层（子调度没有 delegate_to_lead）、花费算在用户那一轮、子任务挂在上级任务下、后台网页的拓扑能看到层级。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startAdmin } from "../src/admin.ts";
import { openApp } from "../src/app.ts";
import { Board, type BoardState } from "../src/board.ts";
import { RunBudget } from "../src/dispatch.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
process.env.FAKE_AGENT_DELAY_MS = "1500"; // 后台派工要比子调度的「提前汇报」慢
const orch = fauxOrchestrator();
const app = await openApp(config, orch, context);
const { harness, root } = app;
const toolNames = (ctx: any): string[] => ctx.messages.filter((m: any) => m.role === "system").flatMap((m: any) => (m.toolsAdded ?? []).map((t: any) => t.name));
const lastUser = (ctx: any) => {
	const m = ctx.messages.filter((x: any) => x.role === "user").at(-1);
	return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b: any) => b.text ?? "").join("");
};

let rootTools: string[] = [];
let leadTools: string[] = [];
let leadSystem = "";
let leadInput = "";
let leadResult = "";
let reminded = false;
let budgetInLead: string | null = null;
orch.faux.setResponses([
	// 总调度：建一个上级任务，交给子调度
	(ctx: any) => {
		rootTools = toolNames(ctx);
		return fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [{ title: "后端：订单接口", acceptance: "接口和测试都有" }] }, { id: "p1" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage([fauxToolCall("delegate_to_lead", { goal: "实现订单接口和它的测试", name: "后端", scope: "只改 server/", task_id: "T1" }, { id: "L1" })], { stopReason: "toolUse" }),
	// —— 以下是子调度的子对话 ——
	(ctx: any) => {
		leadTools = toolNames(ctx);
		leadSystem = JSON.stringify(ctx.messages.filter((m: any) => m.role === "system"));
		leadInput = lastUser(ctx);
		return fauxAssistantMessage(
			[fauxToolCall("plan_tasks", { tasks: [{ title: "写接口", parent: "T1" }, { title: "写测试", parent: "T1" }] }, { id: "lp" })],
			{ stopReason: "toolUse" },
		);
	},
	async () => {
		budgetInLead = ((await harness.snapshot(RunBudget, context)) as any)?.runKey ?? null;
		return fauxAssistantMessage([fauxToolCall("ask_codex", { task: "写订单接口", task_id: "T2" }, { id: "la" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage([fauxToolCall("ask_claude", { task: "写订单测试", task_id: "T3", background: true }, { id: "lb" })], { stopReason: "toolUse" }),
	// 子调度忘了收后台派工就汇报 → 系统提醒它收齐
	() => fauxAssistantMessage(fauxText("后端做完了（其实还有后台派工没收）")),
	(ctx: any) => {
		reminded = /还有后台派工 J\d+ 没有结束/.test(lastUser(ctx));
		return fauxAssistantMessage([fauxToolCall("wait_jobs", { mode: "all" }, { id: "lw" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage(fauxText("后端汇报：T2 codex 写了接口，T3 claude 写了测试，都完成。")),
	// —— 回到总调度 ——
	(ctx: any) => {
		leadResult = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage(fauxText("好，后端完成"));
	},
]);

await (await root.submit({ type: "input", content: "做订单功能" }, context)).wait(context);
const runKey = ((await harness.snapshot(RunBudget, context)) as any).runKey;

check(rootTools.includes("delegate_to_lead"), "总调度有 delegate_to_lead");
check(leadTools.includes("ask_codex") && leadTools.includes("plan_tasks") && leadTools.includes("wait_jobs"), "子调度有派工、分工表和后台派工工具");
check(!leadTools.includes("delegate_to_lead"), "子调度不能再开子调度（只有一层）");
check(leadSystem.includes("子调度「后端」") && leadSystem.includes("只改 server/"), "子调度拿到了名字、子目标和范围");
check(leadInput.includes("实现订单接口"), "子目标作为子调度的输入");
check(reminded, "子调度留着后台派工就汇报时，系统提醒它先收齐");
check(leadResult.includes("后端汇报") && /派工: 2 次/.test(leadResult) && leadResult.includes("子调度: 后端"), `总调度收到子调度的汇报和摘要（${leadResult.match(/\[子调度[^\]]*\]/)?.[0]}）`);
const calls = fakeCalls(config);
check(calls.some((c) => c.kind === "codex") && calls.some((c) => c.kind === "claude"), "子调度把活派给了成员");
check(budgetInLead === runKey, "子调度里的派工算在用户那一轮的花费里");
const board = (await harness.snapshot(Board, context)) as BoardState;
check(board.tasks.T2?.parent === "T1" && board.tasks.T3?.parent === "T1", "子调度拆出的子任务挂在上级任务下");
check(board.tasks.T1?.status === "review" && board.tasks.T1?.owner === "子调度·后端", "上级任务由子调度负责，完成后待验收");

// ---- 后台网页：拓扑里能看到子调度和它派的工 ----
const admin = await startAdmin({ app, config, configPath: "test", orchestrator: { models: orch.models, ref: orch.ref, describe: "faux" }, demo: false, port: 8796, context });
const topo: any = await (await fetch(`${admin.url}/api/topology`)).json();
const leadBar = topo.bars.find((b: any) => b.mode === "lead");
const sub = topo.bars.filter((b: any) => b.lead && b.lead === leadBar?.key);
check(!!leadBar && leadBar.agent === "lead" && leadBar.task.includes("订单接口"), "拓扑里有子调度的时间条");
check(sub.length === 2 && sub.some((b: any) => b.agent === "codex") && sub.some((b: any) => b.agent === "claude" && b.mode === "async"), "子调度派的工出现在拓扑里，并标明来自哪个子调度");
check(topo.links.filter((l: any) => l.type === "spawn" && l.from === leadBar.key).length === 2, "子调度到它派的工有连线");
const { dispatches } = (await (await fetch(`${admin.url}/api/dispatches`)).json()) as any;
check(dispatches.filter((d: any) => d.lead).length === 2, "派工明细里包含子调度派的工");
await admin.close();

await harness.close(context);
console.log("\n子调度测试通过 ✅");
