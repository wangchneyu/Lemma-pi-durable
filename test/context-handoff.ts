import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { Results, storeResult } from "../src/results.ts";
import { Board } from "../src/board.ts";
import { check, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT, config = testConfig(); config.isolation.enabled = false; config.autonomy.enabled = false;
config.agents.deepseek = { ...config.agents.deepseek!, enabled: true, workspace: "none", defaultModel: "fixture", models: [{ id: "fixture", tier: "standard" }], api: { ...config.agents.deepseek!.api!, apiKeyEnv: ["LEMMA_CONTEXT_HANDOFF_KEY"], tools: [], bash: "off" } };
process.env.LEMMA_CONTEXT_HANDOFF_KEY = "fixture";
mkdirSync(join(config.workdir, ".pi-agent"), { recursive: true });
const initialGoal = "CONTEXT_GOAL_V1 " + "Keep supplied sources, dates and factual limits. ".repeat(80);
writeFileSync(join(config.workdir, ".pi-agent/GOAL.md"), initialGoal);
const orch = fauxOrchestrator(), app = await openApp(config, orch, ctx);
const member = fauxProvider({ provider: "member-deepseek", models: [{ id: "fixture" }], tokensPerSecond: 100000 }); orch.models.setProvider(member.provider);
let prompts: string[] = [], sessionId = "";
const run = async (args: any) => { let reply: any; member.setResponses([(request: any) => { const user = request.messages.findLast((message: any) => message.role === "user"); prompts.push(typeof user.content === "string" ? user.content : user.content.map((block: any) => block.text ?? "").join("")); return fauxAssistantMessage(fauxText("MEMBER_DONE")); }]); orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_deepseek", args)], { stopReason: "toolUse" }), (request: any) => { reply = toolResults(request).at(-1); return fauxAssistantMessage(fauxText("OK")); }]); await (await app.root.submit({ type: "input", content: "context handoff" }, ctx)).wait(withAbortSignal(AbortSignal.timeout(10000), ctx)); assert(reply && !reply.isError, reply?.text); sessionId = reply.text.match(/session_id: ([^\s|\]]+)/)![1]!; };
try {
	const delivery = { format: "lemma.delivery.v1", conclusion: "source", data: { selected: "SOURCE_DATA_V1 " + "source line ".repeat(50), other: "DO_NOT_SHARE_PRIVATE_FIELD" }, evidence: [{ source: "fixture" }], artifacts: [], incomplete: [] };
	await app.harness.commit((tx) => storeResult(tx, app.root.id, { id: "source", member: "claude", conversationId: "fixture", submissionId: null, taskId: "fixture", status: "done", text: JSON.stringify(delivery), createdAt: Date.now() }), ctx);
	const inputs = [{ result_id: "source", field: "data.selected" }];
	await run({ task: "FIRST_TASK", inputs }); const first = prompts.at(-1)!; assert(first.includes("CONTEXT_GOAL_V1") && first.includes("SOURCE_DATA_V1") && !first.includes("DO_NOT_SHARE_PRIVATE_FIELD"));
	await run({ task: "ONLY_NEW_QUESTION", inputs, session_id: sessionId }); const reused = prompts.at(-1)!; assert(reused.includes("续接上下文") && reused.includes("已交接资料未变化")); assert(!reused.includes("CONTEXT_GOAL_V1") && !reused.includes("SOURCE_DATA_V1")); assert(reused.length < first.length / 2);
	await run({ task: "FORCE_FULL", inputs, session_id: sessionId, context_mode: "full" }); assert(prompts.at(-1)!.includes("CONTEXT_GOAL_V1") && prompts.at(-1)!.includes("SOURCE_DATA_V1"));
	writeFileSync(join(config.workdir, ".pi-agent/GOAL.md"), "CONTEXT_GOAL_V2 change constraint");
	await run({ task: "CHANGED_GOAL", inputs, session_id: sessionId }); assert(prompts.at(-1)!.includes("CONTEXT_GOAL_V2"));
	delivery.data.selected = "SOURCE_DATA_V2 corrected value"; await app.harness.commit((tx) => storeResult(tx, app.root.id, { id: "source", member: "claude", conversationId: "fixture", submissionId: null, taskId: "fixture", status: "done", text: JSON.stringify(delivery), createdAt: Date.now() }), ctx);
	await run({ task: "CHANGED_EVIDENCE", inputs, session_id: sessionId }); assert(prompts.at(-1)!.includes("SOURCE_DATA_V2"));
	const child = await app.harness.conversation(Number(sessionId) as any, ctx); await child!.reset(undefined, ctx);
	await run({ task: "AFTER_NATIVE_RESET", inputs, session_id: sessionId }); assert(prompts.at(-1)!.includes("CONTEXT_GOAL_V2") && prompts.at(-1)!.includes("SOURCE_DATA_V2"));
	check(true, "原生成员续接省略重复项目与字段片段，内容变更、full 和原生 reset 均重新交付，其他字段不泄漏");
	const isolated = await app.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx); await isolated.configure({ model: orch.ref }, ctx); let prompt = "";
	orch.faux.setResponses([(request: any) => { prompt = JSON.stringify(request.messages); return fauxAssistantMessage(fauxText("直接回答，无派工")); }]); await (await isolated.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
	assert(prompt.includes("不要为形式分工") && prompt.includes("已验收结果") && prompt.includes("资料过期")); assert.equal((await app.harness.snapshot(Board, ctx))?.order.length ?? 0, 0);
	check(true, "总控派工规则明确简单任务直答、按需分工与独立复核边界，无任务不强建分工表");
} finally { await app.harness.close(ctx); delete process.env.LEMMA_CONTEXT_HANDOFF_KEY; }
