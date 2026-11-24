// 后台派工（异步）：总调度把任务交给成员后不必干等，可以继续派别的活、回复用户；
// 成员做完后结果自动发回总调度（【后台结果 Jn】），或者由 wait_jobs 一次收齐。
// 每个后台派工是一个 Pi Durable 后台任务：进程崩溃 / 重启后会续接成员的会话接着做。
import { EventEmitter } from "node:events";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineSignal, type Harness } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { AgentKind } from "./config.ts";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export type JobRecord = {
	id: string;
	agent: AgentKind;
	/** 发起这次后台派工的 ask_* 调用 */
	callId: string;
	/** Pi Durable 任务编号（取消、查看拓扑用） */
	piTask: string;
	task: string;
	/** 分工表任务 */
	taskId?: string;
	model?: string;
	/** 续接的会话 */
	resume?: string;
	basedOn?: string;
	sessionId?: string;
	changeId?: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	costUsd?: number;
	costEstimated?: boolean;
	/** 结果全文（已按成员的 maxOutputChars 截断） */
	result?: string;
	isError?: boolean;
	/** 结果怎么交给总调度的：自动发回（report）或 wait_jobs 收走（wait） */
	delivered?: "report" | "wait" | "workflow";
	/** Coordinator consumes intermediate results without another controller model call. */
	workflow?: true;
	/** 正在等它的 wait_jobs 调用：做完时给它发信号，而不是另发一条消息 */
	waiter?: { task: string; key: string };
	/** 谁取消的 */
	cancelledBy?: "user" | "orchestrator";
	/** 开这个后台派工的对话：总调度，或某个子调度 */
	conversation?: string;
};

export type JobsState = { jobs: Record<string, JobRecord>; nextId: number; byCall: Record<string, string> };

export const Jobs = defineDoc<JobsState>({
	kind: "pi-agent.jobs",
	version: 1,
	scope: "session",
	initial: () => ({ jobs: {}, nextId: 1, byCall: {} }),
	checkpointWhen: () => false,
});

/** 后台派工结束时发给正在等它的 wait_jobs */
export const JobDone = defineSignal({ name: "pi-agent.job-done", version: 1, schema: obj({ id: str() }) });

/** 后台结果消息的 requestId 前缀：由它开始的运行不重置花费（仍算用户那一轮的） */
export const JOB_REQUEST_PREFIX = "pi-agent:job:";
/** 后台结果在对话里的条目类型（网页和终端据此显示成「后台结果」而不是「你」） */
export const JOB_REPORT_ENTRY = "pi-agent.job-report";

const STATUS_WORD: Record<JobStatus, string> = { running: "进行中", done: "完成", failed: "失败", cancelled: "已取消" };

export function jobLabel(job: JobRecord): string {
	return [job.agent, job.model ? `模型 ${job.model}` : undefined, job.taskId ? `任务 ${job.taskId}` : undefined].filter(Boolean).join(" · ");
}

/** 一次后台派工的结果：自动发回和 wait_jobs 用同一个格式 */
export function jobReport(job: JobRecord): string {
	const head = `【后台结果 ${job.id} · ${STATUS_WORD[job.status]}】${jobLabel(job)}`;
	const meta = [
		job.durationMs !== undefined ? `耗时 ${Math.round(job.durationMs / 1000)}s` : undefined,
		job.costUsd !== undefined ? `花费 $${job.costUsd.toFixed(4)}${job.costEstimated ? "（估算）" : ""}` : undefined,
		job.sessionId ? `session_id: ${job.sessionId}` : undefined,
	].filter(Boolean);
	const body = job.status === "cancelled" ? `已被${job.cancelledBy === "user" ? "用户" : "你"}取消。${job.result ? `\n${job.result}` : ""}` : (job.result ?? "（没有输出）");
	return `${head}${meta.length ? `（${meta.join("，")}）` : ""}\n任务：${clip(job.task, 120)}\n\n${body}`;
}

export function clip(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 本进程里后台派工的运行时状态（不持久化）：取消开关、成员的实时输出、正在使用的会话。
 * 终端、网页、工具共用一个实例。
 */
export class JobHub extends EventEmitter {
	private controllers = new Map<string, { controller: AbortController; by?: "user" | "orchestrator" }>();
	private lines = new Map<string, string[]>();
	/** 正在执行的会话：同一个会话不能同时被两次派工续接 */
	readonly busySessions = new Map<string, string>();
	/** 进程正在关闭：被打断的派工不收尾，重启后续接 */
	closing = false;
	harness?: Harness;

	register(id: string): AbortSignal {
		const controller = new AbortController();
		this.controllers.set(id, { controller });
		return controller.signal;
	}

	release(id: string): "user" | "orchestrator" | undefined {
		const entry = this.controllers.get(id);
		this.controllers.delete(id);
		return entry?.by;
	}

	running(id: string): boolean {
		return this.controllers.has(id);
	}

	cancelledBy(id: string): "user" | "orchestrator" | undefined {
		return this.controllers.get(id)?.by;
	}

	/** 取消一次后台派工：本进程里在跑的直接停掉（由任务自己收尾）；否则走 Pi Durable 的中止 */
	async cancel(id: string, by: "user" | "orchestrator", context: Context): Promise<"cancelled" | "not_running" | "not_found"> {
		const entry = this.controllers.get(id);
		if (entry) {
			entry.by = by;
			entry.controller.abort();
			return "cancelled";
		}
		const doc = this.harness ? ((await this.harness.snapshot(Jobs, context)) as JobsState | undefined) : undefined;
		const job = doc?.jobs[id];
		if (!job) return "not_found";
		if (job.status !== "running") return "not_running";
		await this.harness!.abortTask(Number(job.piTask) as any, context);
		return "cancelled";
	}

	output(id: string, chunk: string): void {
		const list = this.lines.get(id) ?? [];
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			list.push(line);
			this.emit("output", id, line);
		}
		this.lines.set(id, list.slice(-80));
	}

	recent(id: string): string[] {
		return this.lines.get(id) ?? [];
	}

	changed(): void {
		this.emit("change");
	}
}
