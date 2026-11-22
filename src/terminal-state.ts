// 终端的状态适配层：只订阅 Durable 原生视图，不调度模型，也不拥有会话。
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, ConversationWatch, Harness, TaskGraph, TaskGraphWatch } from "@earendil-works/pi-durable";
import { toViewItem, toViewLive, type ViewItem, type ViewLive } from "./view.ts";

export interface TerminalConversationView {
	items: ViewItem[];
	live: ViewLive;
}

export interface NativeTerminalTask {
	id: string;
	kind: string;
	status: string;
	conversationId: string;
	owner?: string;
	label?: string;
}

export interface NativeConversationSummary {
	id: string;
	title: string;
	detail: string;
}

export interface TerminalStateOptions {
	harness: Harness;
	conversation: Conversation;
	context: Context;
	onConversation(view: TerminalConversationView): void;
	onTasks(tasks: NativeTerminalTask[]): void;
	onError?(error: unknown): void;
}

const MAX_ITEMS = 250;
const MAX_CHARACTERS = 150_000;

/** 两个原生订阅共用一个清理函数；切换后不再向旧视图发送任何更新。 */
export async function watchTerminalState(options: TerminalStateOptions): Promise<() => Promise<void>> {
	const { harness, conversation, context } = options;
	let stopped = false;
	let conversationWatch: ConversationWatch | undefined;
	let graphWatch: TaskGraphWatch | undefined;
	let newest = -1;
	let resetAt = -1;
	let retained: { item: ViewItem; size: number }[] = [];
	let retainedCharacters = 0;
	const report = (error: unknown) => {
		if (stopped) return;
		try { options.onError?.(error); } catch { /* 错误提示不能中断 Durable 的订阅。 */ }
	};
	const publish = (callback: () => void) => { if (!stopped) { try { callback(); } catch (error) { report(error); } } };
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await Promise.allSettled([conversationWatch?.stop(), graphWatch?.stop()]);
	};
	const renderConversation = (view: ConversationView) => {
		if (stopped) return;
		for (const entry of view.entries) {
			const id = Number(entry.id);
			if (id <= newest) continue;
			newest = id;
			if (entry.kind === "pi.reset") { resetAt = id; retained = []; retainedCharacters = 0; }
			if (id < resetAt) continue;
			let item = toViewItem(entry);
			if (!item) continue;
			// 只限制显示副本；完整原始条目仍在 SQLite 中。
			if ("text" in item && item.text.length > 20_000) item = { ...item, text: `${item.text.slice(0, 20_000)}\n…（完整内容保存在历史记录中）` };
			const size = JSON.stringify(item).length;
			retained.push({ item, size });
			retainedCharacters += size;
			while (retained.length > MAX_ITEMS || (retainedCharacters > MAX_CHARACTERS && retained.length > 1)) retainedCharacters -= retained.shift()!.size;
		}
		const live = toViewLive(view.docs["pi.live"], view.docs["pi.inbox"]);
		if (retained.at(-1)?.item.type === "divider" && retained.at(-1)?.item.id === resetAt) live.runFailure = undefined;
		publish(() => options.onConversation({ items: retained.map(({ item }) => item), live }));
	};
	const renderGraph = (graph: TaskGraph) => publish(() => options.onTasks(Object.values(graph.tasks).map((node) => ({
		id: String(node.id), kind: node.kind, status: node.state.status, conversationId: String(node.conversationId),
		...(node.owner === undefined ? {} : { owner: String(node.owner) }),
		label: `${node.kind}${node.background ? " · 后台" : ""}${node.abortRequested ? " · 正在中止" : ""}${node.blocked ? ` · ${node.blocked}` : ""}`,
	}))));
	try {
		conversationWatch = await conversation.watch(context, { min: MAX_ITEMS, max: MAX_ITEMS * 2 });
		graphWatch = await harness.watchTaskGraph(context);
		renderConversation(conversationWatch.value);
		renderGraph(graphWatch.value);
		conversationWatch.start(async (call) => { if (call.kind === "value") renderConversation(call.value); });
		graphWatch.start(async (call) => { if (call.kind === "value") renderGraph(call.value); });
		return stop;
	} catch (error) {
		await stop();
		throw error;
	}
}

/** 同一存储内的总控、子负责人和 API 成员；读取不会启动任务或复制上下文。 */
export async function listNativeConversations(harness: Harness, root: Conversation, context: Context): Promise<NativeConversationSummary[]> {
	const records = await harness.commit(async (tx) => {
		const [main, recent] = await Promise.all([tx.conversation(root.id), tx.scanConversations({ order: "descending" }, 99)]);
		return [...(main ? [main] : []), ...recent.items.filter((record) => String(record.id) !== String(root.id))];
	}, context);
	const summaries = await Promise.all(records.map(async (record): Promise<NativeConversationSummary | undefined> => {
		const child = await harness.conversation(record.id, context);
		if (!child) return undefined;
		const [agent, first] = await Promise.all([child.agent(context), child.entries({ order: "ascending" }, 12, undefined, context)]);
		const user = first.items.map(toViewItem).find((item) => item?.type === "user");
		const summary = user?.type === "user" ? user.text.replace(/\s+/g, " " ).trim().slice(0, 100) : "尚无消息";
		const isRoot = String(record.id) === String(root.id);
		return {
			id: String(record.id), title: isRoot ? "总调度" : summary,
			detail: `${isRoot ? "主对话" : `所属对话 ${record.owner?.conversationId ?? record.parent?.conversationId ?? "独立"}`} · CID:${record.id}${agent.model ? ` · ${agent.model.modelId}` : ""}${agent.cwd ? ` · ${agent.cwd}` : ""}`,
		};
	}));
	return summaries.filter((item): item is NativeConversationSummary => item !== undefined).sort((a, b) => Number(b.id === String(root.id)) - Number(a.id === String(root.id)));
}
