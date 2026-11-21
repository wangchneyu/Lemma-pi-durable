// 端到端冒烟测试：faux 总调度 → 并行调用 ask_claude + ask_codex（模拟 CLI）→ 汇总 → 续接会话。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openApp } from "../src/app.ts";
import { check, fakeCalls, fauxOrchestrator, lastAnswer, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
const orch = fauxOrchestrator();
const { harness, root, agents } = await openApp(config, orch, context);

check(agents.filter((a) => a.kind !== "deepseek").every((a) => a.available), "三个 agent（模拟 CLI）都被识别为可用");
check(agents.find((a) => a.kind === "deepseek")?.available === false, "没配 DeepSeek 时它不可用（不影响其他成员）");

let claudeSession: string | undefined;
orch.faux.setResponses([
	// 第 1 轮：同时派活给 Claude 和 Codex
	fauxAssistantMessage(
		[
			fauxToolCall("ask_claude", { task: "审查 README" }, { id: "c1" }),
			fauxToolCall("ask_codex", { task: "跑测试" }, { id: "c2" }),
		],
		{ stopReason: "toolUse" },
	),
	// 第 2 轮：读工具结果，汇总
	(ctx) => {
		const results = toolResults(ctx);
		const claude = results.find((r) => r.name === "ask_claude");
		claudeSession = claude?.text.match(/session_id: ([\w-]+)/)?.[1];
		return fauxAssistantMessage(fauxText(`汇总：${results.map((r) => r.text.split("\n")[0]).join(" / ")}`));
	},
]);

const first = await (await root.submit({ type: "input", content: "审查并测试项目" }, context)).wait(context);
check(first.status === "done", "第一轮协作完成");
const answerText = await lastAnswer(root, context);
console.log(`  总调度回答：${answerText}`);
check(answerText.includes("CLAUDE_OK: 审查 README") && answerText.includes("CODEX_OK: 跑测试"), "总调度拿到了两个 agent 的结果");
check(typeof claudeSession === "string", "Claude 结果里带回了 session_id");

const calls1 = fakeCalls(config);
check(calls1.length === 2, "两个 CLI 各被调用一次");
const claudeCall = calls1.find((c) => c.kind === "claude")!;
check(claudeCall.args.includes("--session-id") && claudeCall.args.includes(claudeSession!), "Claude 新会话用了预先分配的 session-id");
check(claudeCall.prompt.trim() === "审查 README", "提示词通过 stdin 完整传入");
const codexCall = calls1.find((c) => c.kind === "codex")!;
check(codexCall.args[0] === "exec" && codexCall.args.at(-1) === "-", "Codex 以 exec 模式运行、从 stdin 读提示词");

// 第二个问题：续接 Claude 的会话
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_claude", { task: "按刚才的意见修改", session_id: claudeSession! }, { id: "c3" })], {
		stopReason: "toolUse",
	}),
	(ctx) => fauxAssistantMessage(fauxText(`完成：${toolResults(ctx).at(-1)?.text.split("\n")[0]}`)),
]);
const second = await (await root.submit({ type: "input", content: "继续改" }, context)).wait(context);
check(second.status === "done", "第二轮完成");
const resumeCall = fakeCalls(config).at(-1)!;
check(resumeCall.args.includes("--resume") && resumeCall.args.includes(claudeSession!), "续接时用 --resume 传入了同一个会话");

// Gemini 在子目录里建会话，续接时不传 cwd → 应自动回到子目录
mkdirSync(join(config.workdir, "sub"), { recursive: true });
let geminiSession: string | undefined;
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_gemini", { task: "通读资料", cwd: "sub" }, { id: "g1" })], { stopReason: "toolUse" }),
	(ctx) => {
		geminiSession = toolResults(ctx).at(-1)?.text.match(/session_id: ([\w-]+)/)?.[1];
		return fauxAssistantMessage(fauxText("读完了"));
	},
]);
await (await root.submit({ type: "input", content: "让 Gemini 读资料" }, context)).wait(context);
check(typeof geminiSession === "string", "Gemini 返回了 session_id");
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_gemini", { task: "再总结一下", session_id: geminiSession! }, { id: "g2" })], { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("好")),
]);
await (await root.submit({ type: "input", content: "继续" }, context)).wait(context);
const geminiResume = fakeCalls(config).at(-1)!;
check(geminiResume.args.includes("--resume") && geminiResume.args.includes(geminiSession!), "Gemini 用 --resume 续接");
check(resolve(geminiResume.cwd) === resolve(join(config.workdir, "sub")), "续接时自动回到会话建立时的目录");

// 把 Claude 的会话交给 Codex → 拒绝
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_codex", { task: "x", session_id: claudeSession! }, { id: "x1" })], { stopReason: "toolUse" }),
	(ctx) => fauxAssistantMessage(fauxText(toolResults(ctx).at(-1)?.isError ? "拒绝" : "接受")),
]);
await (await root.submit({ type: "input", content: "错配会话" }, context)).wait(context);
check((await lastAnswer(root, context)) === "拒绝", "会话 ID 和 agent 不匹配时拒绝执行");

// 第三问：调用不存在的工作目录 → 返回错误，而不是崩溃
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_gemini", { task: "x", cwd: "Z:/definitely/missing" }, { id: "c4" })], { stopReason: "toolUse" }),
	(ctx) => fauxAssistantMessage(fauxText(`结果：${toolResults(ctx).at(-1)?.isError ? "报错" : "成功"}`)),
]);
const third = await (await root.submit({ type: "input", content: "试试错误目录" }, context)).wait(context);
check(third.status === "done" && (await lastAnswer(root, context)) === "结果：报错", "不存在的工作目录作为工具错误返回给总调度");

await harness.close(context);
console.log("\n全部通过 ✅");
