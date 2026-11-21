// 共同目标 + 分工表：拆任务 → 带上下文派工 → 验收，ASSIGN.md 的生成和手改保护，GOAL.md 以用户为准。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
const dir = join(config.workdir, ".pi-agent");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "GOAL.md"), "# 目标\n\n做一个支持优惠券的购物车。验收：npm test 全部通过。\n");

const orch = fauxOrchestrator();
const { harness, root } = await openApp(config, orch, context);
let promptSeen = "";
let results: ReturnType<typeof toolResults> = [];
orch.faux.setResponses([
	fauxAssistantMessage(
		[
			fauxToolCall(
				"plan_tasks",
				{
					tasks: [
						{ title: "设计优惠券接口", role: "设计", acceptance: "接口文档写清楚参数和返回值" },
						{ title: "实现优惠券", role: "编码", deps: ["+1"], acceptance: "npm test 通过" },
					],
				},
				{ id: "p1" },
			),
		],
		{ stopReason: "toolUse" },
	),
	(ctx: any) => {
		promptSeen = JSON.stringify(ctx.systemPrompt ?? ctx);
		return fauxAssistantMessage([fauxToolCall("ask_claude", { task: "写接口设计", task_id: "T1" }, { id: "a1" })], { stopReason: "toolUse" });
	},
	fauxAssistantMessage([fauxToolCall("update_task", { id: "T1", status: "done", note: "接口文档已核对" }, { id: "u1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxToolCall("set_goal", { content: "# 另一个目标" }, { id: "g1" })], { stopReason: "toolUse" }),
	(ctx: any) => {
		results = toolResults(ctx);
		return fauxAssistantMessage(fauxText("汇报：T1 完成，T2 待办"));
	},
]);
const done = await (await root.submit({ type: "input", content: "做优惠券功能" }, context)).wait(context);
check(done.status === "done", "整轮完成");

check(promptSeen.includes("做一个支持优惠券的购物车") && promptSeen.includes("T1") && promptSeen.includes("设计优惠券接口"), "总调度的系统提示里有目标和最新的分工表");
const call = fakeCalls(config).find((c) => c.kind === "claude")!;
check(call.prompt.includes("【项目最终目标") && call.prompt.includes("做一个支持优惠券的购物车"), "成员拿到了项目最终目标");
check(call.prompt.includes("【你负责的任务】T1") && call.prompt.includes("验收标准：接口文档写清楚"), "成员拿到了自己的任务和验收标准");
check(call.prompt.includes("T2") && call.prompt.includes("← 你"), "成员拿到了分工全貌，知道自己的位置");
check(call.prompt.trimEnd().endsWith("写接口设计"), "原来的任务说明放在最后");

const dispatch = results.find((r) => r.name === "ask_claude")!;
check(dispatch.text.includes("任务 T1 标为待验收"), "派工完成后提示总调度验收");
const goalWrite = results.find((r) => r.name === "set_goal")!;
check(goalWrite.isError && readFileSync(join(dir, "GOAL.md"), "utf8").includes("做一个支持优惠券的购物车"), "已有 GOAL.md 时不会被总调度覆盖");

const assign = readFileSync(join(dir, "ASSIGN.md"), "utf8");
check(/^<!-- pi-agent:hash=[0-9a-f]+ -->/.test(assign), "ASSIGN.md 带内容哈希");
check(/\| T1 \| \[x\] 完成 \| 设计优惠券接口 \| 设计 \| claude \|/.test(assign), "ASSIGN.md 里 T1 已完成、负责人是 claude");
check(/\| T2 \| \[ \] 待办 \| 实现优惠券 \| 编码 \| — \| T1 \|/.test(assign), "ASSIGN.md 里 T2 待办、依赖 T1");
check(assign.includes("接口文档已核对"), "ASSIGN.md 里有验收记录");

// 手动改 ASSIGN.md：下次更新时不覆盖，先另存
writeFileSync(join(dir, "ASSIGN.md"), `${assign}\n手动加的一行\n`);
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("update_task", { id: "T2", note: "等接口确认后开工" }, { id: "u2" })], { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("ok")),
]);
await (await root.submit({ type: "input", content: "更新一下" }, context)).wait(context);
const saved = readdirSync(dir).filter((f) => f.startsWith("ASSIGN.edited-"));
check(saved.length === 1 && readFileSync(join(dir, saved[0]!), "utf8").includes("手动加的一行"), "手动改过的 ASSIGN.md 被另存，没有丢");
check(readFileSync(join(dir, "ASSIGN.md"), "utf8").includes("等接口确认后开工") && existsSync(join(dir, "ASSIGN.md")), "随后按分工表重新写出");

await harness.close(context);
console.log("\n分工表测试通过 ✅");
