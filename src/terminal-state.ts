// 终端的状态适配层：只订阅 Durable 原生视图，不调度模型，也不拥有会话。
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, ConversationWatch, EntryRecord, Harness, LiveState, TaskGraph, TaskGraphWatch, TranscriptView } from "@earendil-works/pi-durable";
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
	history?: { hasEarlier: boolean; loading: boolean; loadEarlier(): Promise<void> };
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

const HISTORY_PAGE_SIZE = 250;

/** 两个原生订阅共用一个清理函数；切换后不再向旧视图发送任何更新。 */
export async function watchTerminalState(options: TerminalStateOptions): Promise<() => Promise<void>> {
	const { harness, conversation, context } = options;
	let stopped = false;
	let conversationWatch: ConversationWatch | undefined;
	let graphWatch: TaskGraphWatch | undefined;
	const transcript = new ConversationTranscript((query, limit, ctx) => conversation.entries(query, limit, undefined, ctx), { pageSize: HISTORY_PAGE_SIZE });
	const projected = new WeakMap<EntryRecord, TerminalItem>();
	let latestView: ConversationView | undefined;
	let loading: Promise<void> | undefined;
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
	const renderConversation = (view: ConversationView, merged: TranscriptView = transcript.merge(view)) => {
		if (stopped) return;
		latestView = view;
		// Durable owns paging and entry identity. Keep loaded history, including reset dividers,
		// in the display only; viewing it never adds entries to the model's context.
		const items: TerminalItem[] = [];
		for (const row of merged.items) {
			if (row.kind !== "entry") continue;
			const entry = row.entry;
			let display = projected.get(entry);
			if (!display) {
				const item = toViewItem(entry);
				if (!item) continue;
				display = { ...item, message: entry.model?.[0] as Message | undefined };
				projected.set(entry, display);
			}
			items.push(display);
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
		publish(() => options.onConversation({ items, live, partialMessage, tools, history: {
			hasEarlier: merged.items.some((row) => row.kind !== "entry"), loading: !!loading, loadEarlier,
		} }));
	};
	function loadEarlier(): Promise<void> {
		if (stopped || !latestView) return Promise.resolve();
		if (loading) return loading;
		const current = transcript.merge(latestView);
		const gap = current.items.findLast((row) => row.kind === "gap");
		if (!gap && !current.items.some((row) => row.kind === "earlier")) return Promise.resolve();
		loading = Promise.resolve().then(async () => {
			try {
				if (gap?.kind === "gap") await transcript.fillGap(gap, context);
				else await transcript.loadEarlier(context);
			} finally {
				loading = undefined;
				if (!stopped && latestView) renderConversation(latestView);
			}
		});
		renderConversation(latestView);
		return loading;
	}
	const renderGraph = (graph: TaskGraph) => publish(() => options.onTasks(Object.values(graph.tasks).map((node) => ({
		id: String(node.id), kind: node.kind, status: node.state.status, conversationId: String(node.conversationId),
		...(node.owner === undefined ? {} : { owner: String(node.owner) }),
		label: `${node.kind}${node.background ? " · 后台" : ""}${node.abortRequested ? " · 正在中止" : ""}${node.blocked ? ` · ${node.blocked}` : ""}`,
	}))));
	try {
		conversationWatch = await conversation.watch(context, { min: HISTORY_PAGE_SIZE, max: HISTORY_PAGE_SIZE * 2 });
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
