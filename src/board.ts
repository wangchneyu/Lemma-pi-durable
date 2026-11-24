// 项目的共同目标 + 分工表。
// - GOAL.md：最终目标、验收标准、约束。以文件为准（人写，AI 读；没有时总调度可以起草，标明待确认）。
// - 分工表：以 Pi Durable 里的数据为准（总调度通过工具维护，和派工在同一个事务里），
//   每次变化后写出 .pi-agent/ASSIGN.md 给人和任何 AI 看。ASSIGN.md 由 AI 写；有人手动改过时不覆盖，先另存。
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import type { AcceptanceCheck, TaskVerification } from "./acceptance.ts";

export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked" | "dropped";

export type BoardTask = {
	lastAttempt?: { callId: string; controllerId: string; dispatchTaskId: string; member: string; task: string; cwd?: string; model?: string; sessionId?: string; changeId?: string; structured?: boolean; inputs?: { result_id: string; field?: string; offset?: number; limit?: number }[] };
	recoveries?: { id: string; controllerId: string; action: "resume" | "reassign" | "supply"; member: string; note: string; fromResult: string | null; reviewEvidence?: string; sessionId?: string; basedOn?: string; cwd?: string; model?: string; status: "prepared" | "running" | "finished" | "cancelled"; at: number; callId?: string; cancelledByCall?: string; resultId?: string; previousStatus: TaskStatus; originalTask: string; originalInputs?: { result_id: string; field?: string; offset?: number; limit?: number }[]; structured?: boolean }[];
	id: string;
	title: string;
	detail?: string;
	/** 角色：架构 / 设计 / 编码 / 审查……（配置里的 roles） */
	role?: string;
	/** 负责的成员 ID（自定义 API 角色或 CLI 成员） */
	owner?: string;
	status: TaskStatus;
	deps: string[];
	/** 属于哪项上级任务（子调度拆出的子任务） */
	parent?: string;
	/** 验收标准：做到什么程度算完成 */
	acceptance?: string;
	checks?: AcceptanceCheck[];
	latestResult?: string;
	/** Durable dispatch ownership; only that dispatch may settle this attempt. */
	activeDispatch?: string;
	verification?: TaskVerification;
	review?: { resultId: string; verdict: "accepted" | "rework" | "blocked"; evidence: string; at: number };
	notes: string[];
	/** 关联的派工（callId）和改动编号 */
	dispatches: string[];
	changes: string[];
	createdAt: number;
	updatedAt: number;
};

export type BoardState = {
	tasks: Record<string, BoardTask>;
	order: string[];
	nextId: number;
	updatedAt: number;
};

export const Board = defineDoc<BoardState>({
	kind: "pi-agent.board",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: {}, order: [], nextId: 1, updatedAt: 0 }),
	checkpointWhen: () => false,
});

export const STATUS_LABEL: Record<TaskStatus, string> = {
	todo: "待办",
	doing: "进行中",
	review: "待验收",
	done: "完成",
	blocked: "受阻",
	dropped: "取消",
};
const STATUS_MARK: Record<TaskStatus, string> = { todo: "[ ]", doing: "[~]", review: "[?]", done: "[x]", blocked: "[!]", dropped: "[-]" };

export function boardTasks(board: BoardState | undefined): BoardTask[] {
	if (!board) return [];
	return board.order.map((id) => board.tasks[id]).filter((t): t is BoardTask => !!t);
}

const GOAL_LIMIT = 6000;

export class ProjectFiles extends EventEmitter {
	readonly dir: string;
	readonly goalPath: string;
	readonly assignPath: string;
	constructor(workdir: string, stateDir?: string) {
		super();
		this.dir = join(workdir, ".pi-agent");
		this.goalPath = join(this.dir, "GOAL.md");
		this.assignPath = join(stateDir ?? this.dir, "ASSIGN.md");
	}

	/** GOAL.md 的内容（太长截断）；没有返回 undefined */
	goal(): string | undefined {
		if (!existsSync(this.goalPath)) return undefined;
		const text = readFileSync(this.goalPath, "utf8").trim();
		if (!text) return undefined;
		return text.length > GOAL_LIMIT ? `${text.slice(0, GOAL_LIMIT)}\n…（GOAL.md 太长，后面省略）` : text;
	}

	/** 总调度起草目标：只在还没有 GOAL.md、或者明确要求覆盖时写 */
	writeGoal(content: string, overwrite: boolean): { ok: boolean; message: string } {
		if (existsSync(this.goalPath) && !overwrite) return { ok: false, message: "GOAL.md 已经存在，以用户写的为准；要改请先征得用户同意（overwrite: true）。" };
		mkdirSync(this.dir, { recursive: true });
		const body = `<!-- 由 Lemma 总调度起草，待你确认：确认后删掉这一行，之后以你写的为准 -->\n${content.trim()}\n`;
		writeFileSync(this.goalPath, body);
		this.emit("change");
		return { ok: true, message: `已写入 ${this.goalPath}（标明待用户确认）` };
	}

	/**
	 * 把分工表写成 ASSIGN.md。文件开头记下内容的哈希：下次写之前如果发现内容和哈希对不上，
	 * 说明有人手动改过，先另存为 ASSIGN.edited-<时间>.md，再写新的，返回另存的路径。
	 */
	writeAssign(board: BoardState): { savedManualEdit?: string } {
		const tasks = boardTasks(board);
		if (!tasks.length && !existsSync(this.assignPath)) return {};
		mkdirSync(dirname(this.assignPath), { recursive: true });
		let savedManualEdit: string | undefined;
		if (existsSync(this.assignPath)) {
			const current = readFileSync(this.assignPath, "utf8");
			const m = current.match(/^<!-- pi-agent:hash=([0-9a-f]+) -->\n([\s\S]*)$/);
			if (!m || hash(m[2]!) !== m[1]) {
				savedManualEdit = join(dirname(this.assignPath), `ASSIGN.edited-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
				copyFileSync(this.assignPath, savedManualEdit);
			}
		}
		const body = renderAssign(tasks, board.updatedAt);
		const tmp = `${this.assignPath}.tmp`;
		writeFileSync(tmp, `<!-- pi-agent:hash=${hash(body)} -->\n${body}`);
		renameSync(tmp, this.assignPath);
		this.emit("change");
		return { savedManualEdit };
	}
}

function hash(text: string): string {
	return createHash("sha1").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
}

/** ASSIGN.md：给人和任何 AI 读的分工表 */
export function renderAssign(tasks: BoardTask[], updatedAt: number): string {
	const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
	const active = tasks.filter((t) => t.status !== "dropped");
	const lines = [
		"# 分工表（ASSIGN.md）",
		"",
		"> 由 Lemma 总调度维护，**不要手动编辑**（手动改动会被另存为 ASSIGN.edited-*.md）。最终目标见同目录的 GOAL.md。",
		`> 更新于 ${updatedAt ? new Date(updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—"} · 共 ${active.length} 项：完成 ${count("done")}、进行中 ${count("doing")}、待验收 ${count("review")}、待办 ${count("todo")}、受阻 ${count("blocked")}`,
		"",
		"| 编号 | 状态 | 任务 | 角色 | 负责 | 依赖 |",
		"|---|---|---|---|---|---|",
		...tasks.map(
			(t) =>
				`| ${t.id} | ${STATUS_MARK[t.status]} ${STATUS_LABEL[t.status]} | ${cell(t.title)} | ${cell(t.role ?? "—")} | ${cell(t.owner ?? "—")} | ${t.deps.length ? t.deps.join(", ") : "—"} |`,
		),
		"",
		"## 任务详情",
		"",
	];
	for (const t of tasks) {
		lines.push(`### ${t.id} · ${t.title}`, "");
		lines.push(`- 状态：${STATUS_LABEL[t.status]}${t.role ? ` · 角色：${t.role}` : ""}${t.owner ? ` · 负责：${t.owner}` : ""}`);
		if (t.deps.length) lines.push(`- 依赖：${t.deps.join("、")}`);
		if (t.acceptance) lines.push(`- 验收标准：${t.acceptance}`);
		if (t.latestResult) lines.push(`- 最新结果：${t.latestResult}（终端 /result ${t.latestResult} 查看）`);
		if (t.activeDispatch) lines.push(`- 当前派工：${t.activeDispatch}（执行与收尾由 Durable 管理）`);
		if (t.verification) lines.push(`- 机器检查：${t.verification.passed ? "通过，仍需复核依据" : "未通过"}；${t.verification.checks.map((check) => `${check.name}：${check.passed ? "通过" : "失败"}（${check.evidence}）`).join("；")}`);
		if (t.review) lines.push(`- 复核：${t.review.verdict} · ${t.review.evidence.replace(/\n+/g, " ")}`);
		for (const recovery of t.recoveries?.slice(-3) ?? []) lines.push(`- 恢复：${recovery.action} → ${recovery.member} · ${recovery.status} · 原结果 ${recovery.fromResult ?? "无"} · ${recovery.note.replace(/\n+/g, " ")}`);
		if (t.detail) lines.push(`- 说明：${t.detail.replace(/\n+/g, " ")}`);
		if (t.changes.length) lines.push(`- 改动：${t.changes.map((c) => `#${c}`).join("、")}（终端 /changes 查看）`);
		for (const n of t.notes.slice(-5)) lines.push(`- 记录：${n}`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 80);
}

/** 放进总调度系统提示的分工摘要（每次请求都按最新状态渲染） */
export function boardSummary(board: BoardState | undefined): string {
	const tasks = boardTasks(board).filter((t) => t.status !== "dropped");
	if (!tasks.length) return "（当前没有项目任务；普通对话无需创建分工表。）";
	const selected = tasks.length > 25 ? [...tasks.filter((t) => t.status !== "done").slice(-20), ...tasks.filter((t) => t.status === "done").slice(-5)] : tasks;
	return (tasks.length > selected.length ? `共 ${tasks.length} 项，完成 ${tasks.filter((t) => t.status === "done").length} 项；显示最近活动与完成项。\n` : "") + selected
		.map(
			(t) =>
				`- ${t.id} [${STATUS_LABEL[t.status]}] ${t.title.slice(0, 160)}${t.role ? ` ·${t.role}` : ""}${t.owner ? ` ·${t.owner}` : ""}${t.parent ? ` ·属于 ${t.parent}` : ""}${t.deps.length ? ` ·依赖 ${t.deps.join(",")}` : ""}${t.latestResult ? ` ·结果 ${t.latestResult}` : ""}${t.recoveries?.length ? ` ·恢复 ${t.recoveries.at(-1)!.status}` : ""}${t.changes.length ? ` ·改动 ${t.changes.slice(-3).map((c) => `#${c}`).join(",")}` : ""}`,
		)
		.join("\n");
}

/** 派工时放在成员任务前面的上下文：共同目标 + 这项任务 + 分工全貌（成员据此理解自己在全局里的位置） */
export function taskBrief(goal: string | undefined, board: BoardState | undefined, taskId: string | undefined, mode: "relevant" | "full" = "relevant"): string {
	const parts: string[] = [];
	if (goal) parts.push(`【项目最终目标（GOAL.md）】\n${goal}`);
	const tasks = boardTasks(board).filter((t) => t.status !== "dropped");
	const task = taskId ? board?.tasks[taskId] : undefined;
	if (task) {
		const deps = task.deps.map((d) => board?.tasks[d]).filter(Boolean) as BoardTask[];
		parts.push(
			[
				`【你负责的任务】${task.id} · ${task.title}${task.role ? `（角色：${task.role}）` : ""}`,
				task.acceptance ? `验收标准：${task.acceptance}` : "",
				task.detail ? `任务说明：${task.detail}` : "",
				task.checks?.length ? `机器验收规则（首次派工后锁定）：${JSON.stringify(task.checks)}` : "",
				deps.length ? `前置任务：${deps.map((d) => `${d.id} ${d.title}（${STATUS_LABEL[d.status]}）`).join("；")}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	if (tasks.length > 1) {
		const selected = mode === "full" || !task ? tasks : tasks.filter((candidate) => candidate.id === task.id || task.deps.includes(candidate.id) || candidate.id === task.parent || candidate.deps.includes(task.id));
		parts.push(
			`【相关团队分工】（只读；共 ${tasks.length} 项，显示 ${Math.min(selected.length, 20)} 项；不要修改分工表）\n${selected.slice(0, 20)
				.map((t) => `- ${t.id} [${STATUS_LABEL[t.status]}] ${t.title.slice(0, 120)}${t.owner ? ` — ${t.owner}` : ""}${t.id === taskId ? "  ← 你" : ""}`)
				.join("\n")}`,
		);
	}
	if (!parts.length) return "";
	return `${parts.join("\n\n")}\n\n【本次要做的事】\n`;
}
