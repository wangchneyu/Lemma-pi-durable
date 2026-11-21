// 对话摘要：让人能在一堆对话里认出自己要找的那个。
// 第一句 / 最近一句输入、最后活动时间、输入次数、任务进度、待合并的改动。
// 打开着的对话直接读内存里的 Harness；没打开的只读打开它的存储（不写、不加锁），按文件修改时间缓存。
import { existsSync, readFileSync, statSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Board, boardTasks, type BoardState } from "./board.ts";

export type ConversationDigest = {
	/** 第一句用户输入（没起名字的对话用它当标题） */
	first?: string;
	/** 最近一句用户输入 */
	last?: string;
	/** 最后一条记录的时间 */
	lastAt?: number;
	/** 用户输入了几次 */
	inputs: number;
	tasks: { done: number; total: number };
	/** 待合并的改动 */
	pending: number;
	/** 所有输入拼起来（截断），给搜索用 */
	text: string;
};

const EMPTY: ConversationDigest = { inputs: 0, tasks: { done: 0, total: 0 }, pending: 0, text: "" };
const cache = new Map<string, { stamp: string; digest: ConversationDigest }>();

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
	let first: string | undefined;
	let last: string | undefined;
	let inputs = 0;
	let text = "";
	let lastAt: number | undefined;
	let cursor: any;
	do {
		const page = await root.entries({ order: "ascending" } as any, 500, cursor, ctx);
		for (const e of page.items) {
			const m = e.model?.[0] as any;
			if (typeof m?.timestamp === "number") lastAt = Math.max(lastAt ?? 0, m.timestamp);
			if (e.kind !== "pi.user") continue;
			const t = textOf(m?.content).trim();
			if (!t) continue;
			inputs++;
			if (text.length < 6000) text += ` ${oneLine(t, 600)}`;
			first ??= oneLine(t, 140);
			last = oneLine(t, 140);
		}
		cursor = page.next;
	} while (cursor);
	const tasks = boardTasks((await harness.snapshot(Board, ctx)) as BoardState | undefined).filter((t) => t.status !== "dropped");
	// 分工表里的任务标题也能搜到
	const allTasks = boardTasks((await harness.snapshot(Board, ctx)) as BoardState | undefined);
	text += ` ${allTasks.map((t) => t.title).join(" ")}`.slice(0, 2000);
	return { first, last, lastAt, inputs, text: text.trim().slice(0, 8000), tasks: { done: tasks.filter((t) => t.status === "done").length, total: tasks.length } };
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
	const hit = cache.get(id);
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
	cache.set(id, { stamp, digest });
	return digest;
}
