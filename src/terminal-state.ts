// 终端的状态适配层：只订阅 Durable 原生视图，不调度模型，也不拥有会话。
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, ConversationWatch, EntryRecord, Harness, LiveState, TaskGraph, TaskGraphWatch } from "@earendil-works/pi-durable";
import { ConversationTranscript } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { toViewItem, toViewLive, type ViewItem, type ViewLive } from "./view.ts";
import { transcriptSummary } from "./digest.ts";
import { MemberIdentity } from "./api-member.ts";

export type TerminalItem = ViewItem & { message?: Message };
export type TerminalTool = ViewLive["tools"][number] & { args?: Record<string, unknown>; argsComplete?: boolean; isError?: boolean };

export interface TerminalConversationView {
	items: TerminalItem[];
	partialMessage?: AssistantMessage;
	tools?: TerminalTool[];
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
	parentId?: string;
	workdir?: string;
	createdAt?: number;
	lastAt?: number;
	messageCount?: number;
	searchText?: string;
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
	const createTranscript = () => new ConversationTranscript((query, limit, ctx) => conversation.entries(query, limit, undefined, ctx));
	let transcript = createTranscript();
	const projected = new WeakMap<EntryRecord, { item: TerminalItem; size: number }>();
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
		// Upstream owns sliding-window merging and entry identity; IDs need not be contiguous.
		let merged = transcript.merge(view);
		// Bound only the presentation cache. Original history remains in SQLite.
		if (merged.items.length > MAX_ITEMS * 4) { transcript = createTranscript(); merged = transcript.merge(view); }
		const retained: { item: TerminalItem; size: number }[] = [];
		let retainedCharacters = 0;
		for (const row of merged.items) {
			if (row.kind !== "entry") continue;
			const entry = row.entry;
			if (entry.kind === "pi.reset") { retained.length = 0; retainedCharacters = 0; }
			let display = projected.get(entry);
			if (!display) {
				const item = toViewItem(entry);
				if (!item) continue;
				const native = { ...item, message: entry.model?.[0] as Message | undefined };
				display = { item: native, size: JSON.stringify(native).length };
				projected.set(entry, display);
			}
			retained.push(display);
			retainedCharacters += display.size;
			while (retained.length > MAX_ITEMS || (retainedCharacters > MAX_CHARACTERS && retained.length > 1)) retainedCharacters -= retained.shift()!.size;
		}
		const live = toViewLive(view.docs["pi.live"], view.docs["pi.inbox"]);
		if (view.entries.at(-1)?.kind === "pi.reset") live.runFailure = undefined;
		const raw = view.docs["pi.live"] as LiveState | undefined;
		const partialMessage = raw?.generation?.message as AssistantMessage | undefined;
		const tools: TerminalTool[] = [...live.tools, ...(raw?.nestedTools ?? []).map((slot) => ({
			callId: slot.callId, name: slot.name, status: slot.status, output: slot.output ?? slot.summary?.error ?? "",
			details: slot.details, args: slot.arguments, isError: slot.summary?.isError,
		}))];
		for (const block of partialMessage?.content ?? []) if (block.type === "toolCall" && block.name && !tools.some((tool) => tool.callId === block.id)) tools.push({
			callId: block.id, name: block.name, args: block.arguments, argsComplete: false, status: "pending", output: "",
		});
		publish(() => options.onConversation({ items: retained.map(({ item }) => item), live, partialMessage, tools }));
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
		const [agent, stats, identity] = await Promise.all([child.agent(context), transcriptSummary(harness, child), harness.snapshot(MemberIdentity, child.id, context)]);
		const summary = stats.first?.slice(0, 100) ?? "尚无消息";
		const isRoot = String(record.id) === String(root.id);
		return {
			id: String(record.id), title: isRoot ? "总调度" : identity?.name ? `${identity.name} · ${summary}` : summary,
			parentId: isRoot ? undefined : String(record.owner?.conversationId ?? record.parent?.conversationId ?? root.id),
			workdir: agent.cwd,
			createdAt: stats.firstAt, lastAt: stats.lastAt, messageCount: stats.messageCount, searchText: stats.text,
			detail: `${isRoot ? "主对话" : `所属对话 ${record.owner?.conversationId ?? record.parent?.conversationId ?? "独立"}`} · CID:${record.id}${agent.model ? ` · ${agent.model.modelId}` : ""}${agent.cwd ? ` · ${agent.cwd}` : ""}`,
		};
	}));
	return summaries.filter((item): item is NativeConversationSummary => item !== undefined).sort((a, b) => Number(b.id === String(root.id)) - Number(a.id === String(root.id)));
}
