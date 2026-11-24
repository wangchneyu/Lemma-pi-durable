// 改动记录：每次隔离派工在哪个 worktree / 分支、改了哪些文件、是否已经合并回主目录。
// 存成会话存储旁边的一个 JSON 文件（同一个存储只有一个进程，进程锁保护）。
// 终端的 /apply /drop 和后台网页都读它；工具执行时写它。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { FileStat } from "./git.ts";

export type ChangeStatus = "running" | "pending" | "empty" | "applied" | "dropped" | "conflict";

export type ChangeRecord = {
	/** Joint verification belongs to a frozen main-workspace snapshot and exact member heads. */
	integration?: {
		id: string;
		controllerId: string;
		taskId: string;
		sources: { id: string; base: string; head: string }[];
		baselineTree: string;
		checks: { name: string; command: string; args: string[]; timeoutSeconds?: number }[];
		status: "preparing" | "merging" | "repairing" | "testing" | "passed" | "failed" | "conflict" | "cancelled";
		reports: { name: string; passed: boolean; exitCode: number | null; output: string; at: number }[];
		conflicts?: string[];
		replacesId?: string;
		supersededBy?: string;
		repair?: { fromId: string; member: string; model?: string; note?: string; callId: string; jobId?: string; changeId?: string; previousFailure?: string };
	};
	verification?: { head: string; passed: boolean; at: number; checks: string[] };
	id: string;
	agent: string;
	callId: string;
	task: string;
	model?: string;
	/** 主仓库根目录 */
	root: string;
	/** 派工 cwd 相对仓库根的子目录 */
	subdir: string;
	/** worktree 路径 */
	path: string;
	branch: string;
	/** 开工时的快照提交（包含当时未提交的改动） */
	base: string;
	/** 基于哪次改动开工（based_on） */
	basedOn?: string;
	/** 最新提交；还没有改动时等于 base */
	head: string;
	/** 已经合并到主目录的那个提交；之后的新改动从这里算差异 */
	appliedHead?: string;
	files: FileStat[];
	add: number;
	del: number;
	status: ChangeStatus;
	message?: string;
	sessionId?: string;
	linked?: string[];
	/** 从主目录带进 worktree、但不属于这次改动的文件（未提交的规范文件），提交时排除 */
	copied?: string[];
	createdAt: number;
	updatedAt: number;
}

export class ChangeStore extends EventEmitter {
	private records = new Map<string, ChangeRecord>();
	private readonly file: string;
	constructor(file: string) {
		super();
		this.file = file;
		if (existsSync(file)) {
			try {
				for (const r of JSON.parse(readFileSync(file, "utf8")) as ChangeRecord[]) this.records.set(r.id, r);
			} catch {
				/* 文件损坏时从空开始，不影响派工 */
			}
		}
	}

	list(): ChangeRecord[] {
		return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): ChangeRecord | undefined {
		return this.records.get(id) ?? [...this.records.values()].find((r) => r.id.startsWith(id) || r.branch === id);
	}

	/** worktree 里的某个目录属于哪次改动（续接会话时用） */
	byPath(dir: string): ChangeRecord | undefined {
		const norm = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
		return this.list().find((r) => norm(dir).startsWith(norm(r.path)));
	}

	upsert(record: ChangeRecord): ChangeRecord {
		record.updatedAt = Date.now();
		this.records.set(record.id, record);
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.list(), null, 1));
		renameSync(tmp, this.file);
		this.emit("change", record);
		return record;
	}

	/** 改动的差异区间：已合并过的从合并点算起 */
	range(r: ChangeRecord): [string, string] {
		return [r.appliedHead ?? r.base, r.head];
	}
}
