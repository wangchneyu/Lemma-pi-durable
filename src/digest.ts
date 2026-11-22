// 对话摘要：让人能在一堆对话里认出自己要找的那个。
// 第一句 / 最近一句输入、最后活动时间、输入次数、任务进度、待合并的改动。
// 打开着的对话直接读内存里的 Harness；没打开的只读打开它的存储（不写、不加锁），按文件修改时间缓存。
import { existsSync, readFileSync, statSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Conversation, type Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Board, boardTasks, type BoardState } from "./board.ts";

export type ConversationDigest = {
	/** 第一句用户输入（没起名字的对话用它当标题） */
	first?: string;
	/** 最近一句用户输入 */
	last?: string;
	/** 最后一条记录的时间 */
	lastAt?: number;
	firstAt?: number;
	/** 原始记录中的用户、助手和工具结果消息数，包含已重置的历史。 */
	messageCount: number;
	/** 用户输入了几次 */
	inputs: number;
	tasks: { done: number; total: number };
	/** 待合并的改动 */
	pending: number;
	/** 所有输入拼起来（截断），给搜索用 */
	text: string;
};

const EMPTY: ConversationDigest = { inputs: 0, messageCount: 0, tasks: { done: 0, total: 0 }, pending: 0, text: "" };
const cache = new Map<string, { stamp: string; digest: ConversationDigest }>();
export type TranscriptSummary = Pick<ConversationDigest, "first" | "last" | "firstAt" | "lastAt" | "inputs" | "messageCount" | "text">;
const transcriptCache = new WeakMap<Harness, Map<string, { tail: string; value: TranscriptSummary }>>();

/** Read the complete fork-aware transcript only when its durable tail changes. No model calls. */
export async function transcriptSummary(harness: Harness, conversation: Conversation): Promise<TranscriptSummary> {
	const latest = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
	const tail = String(latest.items[0]?.id ?? "empty");
	let summaries = transcriptCache.get(harness);
	if (!summaries) { summaries = new Map(); transcriptCache.set(harness, summaries); }
	const hit = summaries.get(String(conversation.id));
	if (hit?.tail === tail) return hit.value;
	const value: TranscriptSummary = { inputs: 0, messageCount: 0, text: "" };
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
		for (const entry of page.items) for (const message of entry.model ?? []) {
			if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
			value.messageCount++;
			if (Number.isFinite(message.timestamp) && message.timestamp > 0) {
				value.firstAt = Math.min(value.firstAt ?? message.timestamp, message.timestamp);
				value.lastAt = Math.max(value.lastAt ?? message.timestamp, message.timestamp);
			}
			if (entry.kind !== "pi.user" || message.role !== "user") continue;
			const text = textOf(message.content).trim();
			if (!text) continue;
			value.inputs++;
			value.first ??= oneLine(text, 140); value.last = oneLine(text, 140);
			value.text = `${value.text} ${oneLine(text, 600)}`.slice(-6000);
		}
		cursor = page.next;
	} while (cursor);
	value.text = `${value.first ?? ""} ${value.text.trim()}`.slice(-6200);
	// A concurrent append during pagination must invalidate rather than cache a mixed revision.
	const after = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
	if (String(after.items[0]?.id ?? "empty") === tail) summaries.set(String(conversation.id), { tail, value });
	return value;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text ?? ""))
		.join("");
}

const oneLine = (s: string, max: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** 改动登记里待合并（或有冲突）的数量 */
function pendingChanges(storage: string): number {
	const file = `${storage}.changes.json`;
	if (!existsSync(file)) return 0;
	try {
		return (JSON.parse(readFileSync(file, "utf8")) as { status: string }[]).filter((c) => c.status === "pending" || c.status === "conflict").length;
	} catch {
		return 0;
	}
}

/** 从一个 Harness 读：用户输入（第一句、最近一句、次数）、最后活动、分工表进度 */
async function readDigest(harness: Harness, root: Conversation): Promise<Omit<ConversationDigest, "pending">> {
	const ctx = BACKGROUND_CONTEXT;
	const summary = await transcriptSummary(harness, root);
	const tasks = boardTasks((await harness.snapshot(Board, ctx)) as BoardState | undefined).filter((t) => t.status !== "dropped");
	// 分工表里的任务标题也能搜到
	const allTasks = boardTasks((await harness.snapshot(Board, ctx)) as BoardState | undefined);
	const text = summary.text + ` ${allTasks.map((t) => t.title).join(" ")}`.slice(0, 2000);
	return { ...summary, text: text.trim().slice(0, 8000), tasks: { done: tasks.filter((t) => t.status === "done").length, total: tasks.length } };
}

/** 打开着的对话：直接读 */
export async function liveDigest(harness: Harness, root: Conversation, storage: string): Promise<ConversationDigest> {
	try {
		return { ...(await readDigest(harness, root)), pending: pendingChanges(storage) };
	} catch {
		return { ...EMPTY, pending: pendingChanges(storage) };
	}
}

/** 没打开的对话：只读打开它的存储，按存储文件的修改时间缓存 */
export async function storedDigest(id: string, storage: string): Promise<ConversationDigest> {
	if (!existsSync(storage)) return { ...EMPTY, pending: pendingChanges(storage) };
	const files = [storage, `${storage}-wal`, `${storage}.changes.json`].filter(existsSync);
	const stamp = files.map((f) => statSync(f).mtimeMs).join("|");
	const key = `${id}:${storage}`;
	const hit = cache.get(key);
	if (hit && hit.stamp === stamp) return hit.digest;
	let digest: ConversationDigest = { ...EMPTY, pending: pendingChanges(storage) };
	let harness: Harness | undefined;
	try {
		const ctx = BACKGROUND_CONTEXT;
		const store = await openNodeSqliteStorage(storage); // Harness 只读；SQLite 按普通方式打开（文件锁保证和写入方并存是安全的）
		harness = await Harness.open(store, { models: createModels(), registry: createRegistry(), readOnly: true }, ctx);
		const root = await harness.root(ctx);
		digest = { ...(await readDigest(harness, root)), pending: pendingChanges(storage) };
	} catch {
		/* 空存储或还没有总控对话：当成空对话 */
	} finally {
		await harness?.close(BACKGROUND_CONTEXT).catch(() => {});
	}
	cache.set(key, { stamp, digest });
	return digest;
}
