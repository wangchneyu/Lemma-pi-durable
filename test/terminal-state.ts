// 原生视图与任务图测试：只写内存存储，不调用模型或 CLI。
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage, type Conversation, type ConversationWatch, type EntryDraft } from "@earendil-works/pi-durable";
import { listNativeConversations, watchTerminalState, type NativeTerminalTask, type TerminalConversationView } from "../src/terminal-state.ts";
import { check, fauxOrchestrator } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const registry = createRegistry();
const sleeper = defineTask<null, { phase: "sleep" }, null>({
	name: "terminal-test.sleeper", version: 1, initial: () => ({ phase: "sleep" }),
	phases: { sleep: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "sleeping", checkpoint: { phase: "sleep" }, until: Date.now() + 60_000 }), ctx); } },
	abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
});
registry.install(defineExtension({ name: "terminal-test", tasks: [sleeper] }));
const model = fauxOrchestrator();
let modelCalls = 0;
model.faux.setResponses([() => { modelCalls++; throw new Error("状态读取不应调用模型"); }]);
const harness = await Harness.open(new MemoryStorage(), { models: model.models, registry }, context);
const root = await harness.root(context, { agent: { model: model.ref } });
const userEntry = (text: string): EntryDraft => ({ kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean): Promise<void> {
	const end = Date.now() + 2500;
	while (!test() && Date.now() < end) await sleep(10);
	assert.ok(test(), "原生订阅未及时更新");
}
let current!: TerminalConversationView;
let tasks: NativeTerminalTask[] = [];
let calls = 0;
let stop = async () => {};
try {
	stop = await watchTerminalState({ harness, conversation: root, context, onConversation: (value) => { current = value; calls++; }, onTasks: (value) => { tasks = value; calls++; } });
	assert.equal(current.items.length, 0); assert.equal(tasks.length, 0);
	await root.commit(async (tx) => { for (let i = 0; i < 200; i++) await tx.appendEntry(root.id, userEntry(`第一批 ${i}`)); }, context);
	await until(() => current.items.length === 200);
	await root.commit(async (tx) => { for (let i = 0; i < 340; i++) await tx.appendEntry(root.id, userEntry(`第二批 ${i}`)); }, context);
	await until(() => current.items.at(-1)?.type === "user" && (current.items.at(-1) as { text: string }).text === "第二批 339");
	assert.equal(current.items.length, 250);
	assert.ok(current.items.every((item) => item.type !== "user" || item.text.startsWith("第二批")));
	check(true, "终端订阅增量接收原生视图，并限制历史长度，不被滑动窗口覆盖");
	await root.commit(async (tx) => { await tx.appendEntry(root.id, { kind: "pi.reset", head: "self" }); await tx.appendEntry(root.id, userEntry("重置后的独立内容")); }, context);
	await until(() => current.items.length === 2);
	assert.equal(current.items[0]?.type, "divider");
	assert.equal((current.items[1] as { text: string }).text, "重置后的独立内容");
	assert.equal((await root.entries({}, 1000, undefined, context)).items.filter((entry) => entry.kind === "pi.user").length, 541);
	check(true, "重置后只展示新上下文，原始记录仍在原生存储中");
	const owner = await root.commit((tx) => tx.createTask(sleeper, null, { ownership: { kind: "conversation" }, background: true }), context);
	const child = await harness.createConversation({ ownership: { kind: "task", taskId: owner } }, context);
	await child.commit((tx) => tx.appendEntry(child.id, userEntry("子负责人验证任务")), context);
	const nested = await child.commit((tx) => tx.createTask(sleeper, null, { ownership: { kind: "conversation" }, background: true }), context);
	await until(() => tasks.length === 2);
	assert.ok(tasks.every((task) => task.status === "pending"));
	assert.equal(tasks.find((task) => task.id === String(nested))?.conversationId, String(child.id));
	harness.resume();
	await until(() => tasks.length === 2 && tasks.every((task) => task.status === "sleeping"));
	check(true, "主对话和子对话任务使用 Durable 原生 pending 与 sleeping 状态");
	const summaries = await listNativeConversations(harness, root, context);
	assert.equal(summaries[0]?.id, String(root.id));
	assert.equal(summaries.find((item) => item.id === String(child.id))?.title, "子负责人验证任务");
	check(true, "会话选择列表读取总控和子对话，不启动模型或复制历史");
	await stop(); await stop();
	const callsAtStop = calls;
	await child.commit((tx) => tx.appendEntry(child.id, userEntry("停止后的消息")), context);
	await harness.abortTask(owner, context);
	await sleep(40); assert.equal(calls, callsAtStop);
	check(true, "切换清理同时关闭消息与任务订阅，旧绑定不再更新");
	let acquired!: ConversationWatch; let released = false;
	const wrapping = { ...root, watch: async (...args: Parameters<Conversation["watch"]>) => {
		acquired = await root.watch(...args);
		return { ...acquired, stop: async () => { released = true; return acquired.stop(); } };
	} } as Conversation;
	await assert.rejects(watchTerminalState({ harness: { watchTaskGraph: async () => { throw new Error("graph unavailable"); } } as unknown as Harness, conversation: wrapping, context, onConversation() {}, onTasks() {} }), /graph unavailable/);
	assert.ok(released);
	check(true, "任务图获取失败时，已打开的对话订阅也会释放");
	const newest = await harness.commit(async (tx) => {
		let id = root.id;
		for (let i = 0; i < 105; i++) id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
		return id;
	}, context);
	const recent = await listNativeConversations(harness, root, context);
	assert.equal(recent[0]?.id, String(root.id));
	assert.ok(recent.length <= 100 && recent.some((item) => item.id === String(newest)));
	check(true, "大量历史子对话时仍可选择最近创建的对话，并始终保留总控入口");
	assert.equal(modelCalls, 0);
	check(true, "订阅、切换列表和原生任务观察不产生模型请求");
} finally { await stop(); await harness.close(context); }
