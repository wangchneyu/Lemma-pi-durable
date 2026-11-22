import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { transcriptSummary } from "../src/digest.ts";
import { listNativeConversations } from "../src/terminal-state.ts";
import { nativeSessions } from "../src/native-selectors.ts";
import { check, fauxOrchestrator } from "./helpers.ts";

const context = BACKGROUND_CONTEXT, model = fauxOrchestrator();
const harness = await Harness.open(new MemoryStorage(), { models: model.models, registry: createRegistry() }, context);
try {
	const root = await harness.root(context);
	const first = Date.now() - 300000, last = Date.now() - 60000;
	await root.commit(async (tx) => {
		for (let i = 0; i < 620; i++) await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: `历史记录${i}`, timestamp: first + i }] });
		await tx.appendEntry(root.id, { kind: "pi.reset", head: "self" });
		await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "重置后搜索唯一标记", timestamp: last }] });
	}, context);
	const stats = await transcriptSummary(harness, root);
	assert.equal(stats.messageCount, 621); assert.equal(stats.inputs, 621);
	assert.equal(stats.firstAt, first); assert.equal(stats.lastAt, last);
	assert.ok(stats.text.includes("重置后搜索唯一标记"));
	assert.equal(await transcriptSummary(harness, root), stats);
	const list = await listNativeConversations(harness, root, context);
	assert.equal(list[0]?.messageCount, 621); assert.equal(list[0]?.lastAt, last);
	await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "追加内容", timestamp: last + 1000 }] }), context);
	assert.equal((await transcriptSummary(harness, root)).messageCount, 622);
	check(true, "选择器统计读取超过一页的历史、包含 reset 前记录，活动时间和尾部缓存随追加更新");
	let selected = "";
	const selector = nativeSessions([{ id: "old", title: "old", createdAt: first, lastAt: last, messageCount: 621 }, { id: "new", title: "new", createdAt: first, lastAt: Date.now(), messageCount: 8 }], (id) => { selected = id; }, () => {}, () => {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = selector.render(100).join("\n");
	assert.ok(rendered.includes("621") && rendered.includes("8"));
	selector.handleInput("new"); selector.handleInput("\r"); assert.equal(selected, "new");
	selector.getSessionList().onCancel?.();
	assert.equal(model.faux.state.callCount, 0);
	check(true, "原生选择器显示真实消息数与活动时间，读取统计不触发模型");
} finally { await harness.close(context); }
