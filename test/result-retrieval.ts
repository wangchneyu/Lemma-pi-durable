import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { memberProvider } from "../src/api-member.ts";
import { Results } from "../src/results.ts";
import { check, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;
const config = testConfig();
config.agents.deepseek.models = [{ id: "result-fixture", tier: "economy", note: "test fixture" }];
config.agents.deepseek.defaultModel = "result-fixture";
config.agents.deepseek.maxOutputChars = 120;
config.agents.deepseek.api!.apiKeyEnv = ["LEMMA_TEST_RESULT_KEY"];
process.env.LEMMA_TEST_RESULT_KEY = "fixture-only";
const orch = fauxOrchestrator();
const app = await openApp(config, orch, ctx);
const member = fauxProvider({ provider: memberProvider("deepseek"), models: [{ id: "result-fixture" }] });
orch.models.setProvider(member.provider);
const full = "REPORT_HEAD " + "supplied evidence ".repeat(100) + "KEY_MIDDLE_EVIDENCE " + "source references ".repeat(100) + " REPORT_TAIL";
let resultId = "";
try {
	member.setResponses([() => fauxAssistantMessage(fauxText(full))]);
	orch.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "Return the supplied report" }, { id: "persist-full" })], { stopReason: "toolUse" }),
		(request: any) => {
			const preview = toolResults(request).at(-1)!.text;
			assert(!preview.includes("KEY_MIDDLE_EVIDENCE")); assert(preview.includes("read_result"));
			resultId = preview.match(/result_id: ([^；\s|\]]+)/)![1]!;
			return fauxAssistantMessage([fauxToolCall("read_result", { result_id: resultId, offset: 0, limit: 8000 }, { id: "retrieve-full" })], { stopReason: "toolUse" });
		},
		(request: any) => { assert.equal(JSON.parse(toolResults(request).at(-1)!.text).text, full); return fauxAssistantMessage(fauxText("VERIFIED")); },
	]);
	assert.equal((await (await app.root.submit({ type: "input", content: "Read the full evidence" }, ctx)).wait(ctx)).status, "done");
	assert.equal((await app.harness.snapshot(Results, app.root.id, resultId, ctx))?.result?.text, full);
	const isolated = await app.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	orch.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("read_result", { result_id: resultId }, { id: "deny-cross-controller" })], { stopReason: "toolUse" }),
		(request: any) => { assert.equal(toolResults(request).at(-1)!.isError, true); return fauxAssistantMessage(fauxText("ISOLATED")); },
	]);
	await (await isolated.submit({ type: "input", content: "Try reading another result" }, ctx)).wait(ctx);
	check(true, "编码宿主：截断前保存全文，read_result 找回中间证据并限制总控访问范围");
	config.agents.deepseek.maxOutputChars = 8000;
	member.setResponses([() => fauxAssistantMessage(fauxText("BACKGROUND_REPORT_FULL"))]);
	let backgroundId = "";
	orch.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "Return a background report", background: true }, { id: "background-full" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("wait_jobs", { mode: "all" }, { id: "wait-full" })], { stopReason: "toolUse" }),
		(request: any) => {
			const text = toolResults(request).at(-1)!.text;
			assert(text.includes("BACKGROUND_REPORT_FULL"));
			backgroundId = text.match(/result_id: ([^；\s|\]]+)/)![1]!;
			return fauxAssistantMessage(fauxText("BACKGROUND_VERIFIED"));
		},
	]);
	assert.equal((await (await app.root.submit({ type: "input", content: "Read the background report" }, ctx)).wait(ctx)).status, "done");
	assert.equal((await app.harness.snapshot(Results, app.root.id, backgroundId, ctx))?.result?.text, "BACKGROUND_REPORT_FULL");
	check(true, "编码宿主：后台短报告同样携带 result_id，等待结果后可读原文");

	// 默认交接片段上限已提高到 8000：3500 字符中等需求应完整一次透传；超 8000 时标出未传完警告
	const spec3500 = "SPEC_HEAD " + "requirement section ".repeat(180) + " SPEC_TAIL_END";
	assert(spec3500.length > 3300 && spec3500.length < 8000);
	const { storeResult } = await import("../src/results.ts");
	await app.harness.commit((tx) => storeResult(tx, app.root.id, { id: "spec-3500", member: "claude", conversationId: "fixture", submissionId: null, taskId: "fixture", status: "done", text: spec3500, createdAt: Date.now() }), ctx);
	let handoffPrompt = "";
	member.setResponses([(request: any) => { handoffPrompt = JSON.stringify(request.messages); return fauxAssistantMessage(fauxText("SPEC_RECEIVED")); }]);
	orch.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "Implement spec", inputs: [{ result_id: "spec-3500" }] }, { id: "handoff-3500" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("DONE")),
	]);
	await (await app.root.submit({ type: "input", content: "Handoff medium spec" }, ctx)).wait(ctx);
	assert(handoffPrompt.includes("SPEC_HEAD") && handoffPrompt.includes("SPEC_TAIL_END") && !handoffPrompt.includes("未传完"), "3500 字中等需求默认完整交接，不再 2000 字截断");
	check(true, "交接默认单段上限提升至 8000 字符，中等需求完整透传不截断");
} finally { await app.harness.close(ctx); delete process.env.LEMMA_TEST_RESULT_KEY; }
