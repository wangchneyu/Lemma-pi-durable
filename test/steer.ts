// 插话（steer）、排队（follow-up）、续跑（continue）、手动压缩（compact）：用 faux 总调度 + 慢一点的模拟 CLI。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { check, fauxOrchestrator, testConfig } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
process.env.FAKE_AGENT_DELAY_MS = "1500"; // 让成员慢一点，好在它干活时插话
const orch = fauxOrchestrator();
const { harness, root } = await openApp(config, orch, context);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join(""));
const live = async () => (await harness.snapshot(LiveDoc, root.id, context)) as any;
async function untilToolRunning() {
	for (let i = 0; i < 100; i++) {
		if ((await live())?.tools?.some((t: any) => t.status === "running")) return;
		await sleep(50);
	}
	throw new Error("成员一直没有开始执行");
}

// ---- 1. 插话 + 排队 ----
let sawSteer = false;
let runs = 0;
orch.faux.setResponses([
	() => {
		runs++;
		return fauxAssistantMessage([fauxToolCall("ask_claude", { task: "写设计" }, { id: "s1" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		const msgs = ctx.messages;
		const last = msgs.at(-1);
		// 插话应当紧跟在这一轮的工具结果之后，在同一次运行里被看到
		sawSteer = last?.role === "user" && textOf(last).includes("用 pnpm") && msgs.at(-2)?.role === "toolResult";
		return fauxAssistantMessage(fauxText(sawSteer ? "已按插话调整：用 pnpm" : "没看到插话"));
	},
	() => {
		runs++;
		return fauxAssistantMessage(fauxText("排队的任务完成"));
	},
]);
const main = await root.submit({ type: "input", content: "设计方案" }, context);
await untilToolRunning();
const steer = await root.submit({ type: "input", content: "用 pnpm，不要用 npm", whenBusy: "steer" }, context);
const queued = await root.submit({ type: "input", content: "然后整理 README", whenBusy: "followUp" }, context);
check(((await harness.snapshot(InboxDoc, root.id, context)) as any)?.items?.length === 2, "插话和排队都先进了收件箱");
const [mainDone, steerDone] = await Promise.all([main.wait(context), steer.wait(context)]);
check(mainDone.status === "done" && steerDone.status === "done", "插话和原来的任务在同一次运行里一起完成");
check(sawSteer, "总调度在这一轮工具结果之后看到了插话");
const queuedDone = await queued.wait(context);
check(queuedDone.status === "done" && runs === 2, "排队的任务在这一轮结束后作为新的一轮处理");

// ---- 2. 续跑：中止后用 continue 接着跑 ----
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_codex", { task: "跑测试" }, { id: "c1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("续跑完成")),
]);
const interrupted = await root.submit({ type: "input", content: "跑一遍测试" }, context);
await untilToolRunning();
await root.abort(context);
const stopped = await interrupted.wait(context);
check(stopped.status !== "done" && (await live())?.runFailure?.reason === "aborted", "中止后这一轮没有完成，记录了原因");
const resumed = await (await root.submit({ type: "continue" }, context)).wait(context);
check(resumed.status === "done", "continue 在原来的上下文里续跑完成，不用重新输入");

// ---- 3. 手动压缩 ----
orch.faux.setResponses([fauxAssistantMessage(fauxText("摘要：设计用 pnpm；测试已续跑完成。"))]);
const taskId = await root.compact("保留用了什么包管理器", context);
const outcome = ((await harness.waitForTask(taskId, context)) as any).state?.outcome;
check(outcome?.status === "completed", "手动压缩完成");

await harness.close(context);
console.log("\n插话 / 续跑 / 压缩测试通过 ✅");
