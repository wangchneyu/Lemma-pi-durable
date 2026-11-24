import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { Resources, resourceSnapshot, admit, releaseClaim } from "../src/resources.ts";
import { Jobs } from "../src/jobs.ts";
import { Results, storeResult } from "../src/results.ts";
import { parseDeliverable, resultExcerpt } from "../src/deliverables.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT, bounded = () => withAbortSignal(AbortSignal.timeout(15000), ctx);
const config = testConfig(); config.isolation.enabled = false; config.execution = { maxConcurrent: 1, perMember: 1, perService: 1 };
process.env.FAKE_AGENT_DELAY_MS = "600";
const orch = fauxOrchestrator(); const app = await openApp(config, orch, ctx);
const run = async (responses: any[]) => { orch.faux.setResponses(responses); return (await app.root.submit({ type: "input", content: "collaboration controls" }, ctx)).wait(bounded()); };
const wait = async (predicate: () => Promise<boolean>) => { const until = Date.now() + 10000; while (!(await predicate()) && Date.now() < until) await new Promise((done) => setTimeout(done, 20)); assert(await predicate()); };
try {
	let replies: any[] = [];
	orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_claude", { task: "ONE" }), fauxToolCall("ask_codex", { task: "TWO" })], { stopReason: "toolUse" }), (request: any) => { replies = toolResults(request); return fauxAssistantMessage(fauxText("DONE")); }]);
	const submission = await app.root.submit({ type: "input", content: "parallel bounded" }, ctx);
	await wait(async () => resourceSnapshot(await app.harness.snapshot(Resources, ctx)).queued.length === 1);
	assert.equal(resourceSnapshot(await app.harness.snapshot(Resources, ctx)).running.length, 1);
	assert.equal((await submission.wait(bounded())).status, "done");
	assert.equal(replies.length, 2); assert(replies.every((reply) => !reply.isError));
	assert.equal(resourceSnapshot(await app.harness.snapshot(Resources, ctx)).running.length, 0);
	check(true, "同轮并行派工使用 Durable 原生挂起排队，名额释放后执行，不占用额外模型轮次");

	config.execution = { maxConcurrent: 8, perMember: 8, perService: 8 }; config.budget = { perRunUsd: 1, reservePerDispatchUsd: 0.75 };
	const before = fakeCalls(config).length;
	await run([fauxAssistantMessage([fauxToolCall("ask_claude", { task: "RESERVED_ONE" }), fauxToolCall("ask_codex", { task: "RESERVED_TWO" })], { stopReason: "toolUse" }), (request: any) => { replies = toolResults(request).slice(-2); return fauxAssistantMessage(fauxText("DONE")); }]);
	assert.equal(fakeCalls(config).length - before, 1); assert.equal(replies.filter((reply) => reply.isError).length, 1); assert(replies.some((reply) => reply.text.includes("预留")));
	assert.equal(resourceSnapshot(await app.harness.snapshot(Resources, ctx)).reservedUsd, 0);
	check(true, "预算按已知花费加并发预留原子准入，防止多个派工同时耗用同一余额，结束后释放预留");

	config.execution = { maxConcurrent: 1, perMember: 1, perService: 1 }; config.budget = { perRunUsd: 3, reservePerDispatchUsd: 0.1 };
	process.env.FAKE_AGENT_DELAY_MS = "4000";
	orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_claude", { task: "CANCEL_ONE" }), fauxToolCall("ask_codex", { task: "CANCEL_TWO" })], { stopReason: "toolUse" })]);
	const cancelled = await app.root.submit({ type: "input", content: "cancel queued" }, ctx);
	await wait(async () => resourceSnapshot(await app.harness.snapshot(Resources, ctx)).queued.length === 1);
	await app.root.abort(bounded()); await cancelled.wait(bounded()); await app.harness.waitForIdle(bounded());
	const clean = resourceSnapshot(await app.harness.snapshot(Resources, ctx)); assert.equal(clean.running.length + clean.queued.length, 0); assert.equal(clean.reservedUsd, 0);
	check(true, "取消会清理运行与原生排队名额，不残留预算预留");

	process.env.FAKE_AGENT_DELAY_MS = "10";
	const delivery = { format: "lemma.delivery.v1", conclusion: "已计算", data: { total: 42, privateDetail: "NOT_HANDED_OVER" }, evidence: [{ source: "fixture:42" }], artifacts: [{ path: "report.json" }], incomplete: [] };
	assert(parseDeliverable(JSON.stringify(delivery))); assert.equal(resultExcerpt({ text: JSON.stringify(delivery) }, { field: "data.total" }).text, "42");
	assert.throws(() => resultExcerpt({ text: JSON.stringify(delivery) }, { field: "__proto__.x" }));
	await app.harness.commit((tx) => storeResult(tx, app.root.id, { id: "structured-fixture", member: "claude", conversationId: "fixture", submissionId: null, taskId: "fixture", status: "done", text: JSON.stringify(delivery), createdAt: Date.now() }), ctx);
	await run([fauxAssistantMessage([fauxToolCall("read_result", { result_id: "structured-fixture", field: "data.total" }), fauxToolCall("ask_claude", { task: "FIELD_ONLY", inputs: [{ result_id: "structured-fixture", field: "data.total" }] })], { stopReason: "toolUse" }), (request: any) => { replies = toolResults(request).slice(-2); return fauxAssistantMessage(fauxText("DONE")); }]);
	assert(replies.every((reply) => !reply.isError)); assert.equal(JSON.parse(replies[0].text).text, "42");
	const prompt = fakeCalls(config).at(-1)!.prompt; assert(prompt.includes("field=data.total")); assert(!prompt.includes("NOT_HANDED_OVER"));
	assert((await app.harness.snapshot(Results, app.root.id, "structured-fixture", ctx))!.result!.deliverable);
	check(true, "结构化成果按字段传递，保留来源并不夹带其他字段，完整原文仍持久保存");
} finally { await app.harness.close(ctx); delete process.env.FAKE_AGENT_DELAY_MS; }

{
	const config = testConfig(); config.isolation.enabled = false; config.execution = { maxConcurrent: 1, perMember: 1, perService: 1 }; config.budget = { perRunUsd: 3, reservePerDispatchUsd: 0.1 };
	let orch = fauxOrchestrator(), app = await openApp(config, orch, ctx);
	const wait = async (predicate: () => Promise<boolean>) => { const until = Date.now() + 15000; while (!(await predicate()) && Date.now() < until) await new Promise((done) => setTimeout(done, 20)); assert(await predicate()); };
	try {
		process.env.FAKE_AGENT_DELAY_MS = "5000";
		orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_claude", { task: "BACKGROUND_ONE", background: true }), fauxToolCall("ask_codex", { task: "BACKGROUND_TWO", background: true })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("queued"))]);
		await (await app.root.submit({ type: "input", content: "background resource recovery" }, ctx)).wait(bounded());
		await wait(async () => resourceSnapshot(await app.harness.snapshot(Resources, ctx)).queued.length === 1 && fakeCalls(config).length === 1);
		app.jobs.closing = true; await app.harness.close(ctx);
		orch = fauxOrchestrator(); orch.faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("background result received"))));
		process.env.FAKE_AGENT_DELAY_MS = "200"; app = await openApp(config, orch, ctx);
		const restored = resourceSnapshot(await app.harness.snapshot(Resources, ctx)); assert.equal(restored.running.length, 1); assert.equal(restored.queued.length, 1); assert.equal(restored.reservedUsd, 0.1);
		app.harness.resume();
		await wait(async () => { const jobs = Object.values((await app.harness.snapshot(Jobs, ctx))?.jobs ?? {}); return jobs.length === 2 && jobs.every((job) => job.status === "done"); });
		assert.equal(resourceSnapshot(await app.harness.snapshot(Resources, ctx)).reservedUsd, 0);
		assert.equal(resourceSnapshot(await app.harness.snapshot(Resources, ctx)).running.length, 0);
		assert.equal(fakeCalls(config).filter((call) => call.prompt.includes("BACKGROUND_TWO")).length, 1);
		check(true, "后台运行、队列和预留随 Durable 重启恢复，队列只执行一次，收尾释放资源");
		process.env.FAKE_AGENT_DELAY_MS = "5000";
		orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_claude", { task: "BG_CANCEL_ONE", background: true }), fauxToolCall("ask_codex", { task: "BG_CANCEL_TWO", background: true })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("queued"))]);
		await (await app.root.submit({ type: "input", content: "cancel background queue" }, ctx)).wait(bounded());
		await wait(async () => resourceSnapshot(await app.harness.snapshot(Resources, ctx)).queued.length === 1);
		const queued = resourceSnapshot(await app.harness.snapshot(Resources, ctx)).queued[0]!;
		const job = Object.values((await app.harness.snapshot(Jobs, ctx))!.jobs).find((job) => job.piTask === queued.id)!;
		await app.jobs.cancel(job.id, "orchestrator", ctx);
		await wait(async () => (await app.harness.snapshot(Jobs, ctx))!.jobs[job.id]!.status === "cancelled");
		const running = Object.values((await app.harness.snapshot(Jobs, ctx))!.jobs).find((job) => job.status === "running")!; await app.jobs.cancel(running.id, "orchestrator", ctx);
		await wait(async () => { const snapshot = resourceSnapshot(await app.harness.snapshot(Resources, ctx)); return snapshot.running.length + snapshot.queued.length === 0; });
		assert(!fakeCalls(config).some((call) => call.prompt.includes("BG_CANCEL_TWO")));
		check(true, "单独取消后台队列走原生任务中止，不启动成员、不残留排队和预算预留");
		config.execution = { maxConcurrent: 8, perMember: 8, perService: 1 };
		const api = config.agents.deepseek!.api!; for (const [id, baseUrl] of [["api_one", "https://service.invalid/v1"], ["api_two", "https://service.invalid/v2"], ["api_other", "https://other.invalid/v1"]]) config.agents[id!] = { ...config.agents.deepseek!, api: { ...api, baseUrl: baseUrl! } };
		const claim = (id: string, member: string) => app.harness.commit((tx) => admit(tx, config, { id, member, runKey: "service-test", spent: 0, at: Date.now() }), ctx);
		assert.equal((await claim("first", "api_one")).state, "ready"); assert.equal((await claim("second", "api_two")).state, "queued"); assert.equal((await claim("other", "api_other")).state, "ready");
		await app.harness.commit((tx) => releaseClaim(tx, "first"), ctx); assert.equal((await claim("second", "api_two")).state, "ready");
		for (const id of ["first", "second", "other"]) await app.harness.commit((tx) => releaseClaim(tx, id), ctx);
		check(true, "同 API origin 的不同成员共享服务并发，其他服务不被队首阻塞");
	} finally { await app.harness.close(ctx); delete process.env.FAKE_AGENT_DELAY_MS; }
}
