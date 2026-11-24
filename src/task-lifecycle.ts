import { verifyReport } from "./acceptance.ts";
import type { BoardState, BoardTask, TaskStatus } from "./board.ts";
import type { ChangeStore } from "./changes.ts";
import type { AppConfig } from "./config.ts";
import type { MemberResult } from "./results.ts";
import { checkFilesScope } from "./scope.ts";

/** Shared by both review_task and the backwards-compatible update_task entry. */
export function completionRefusal(board: BoardState, task: BoardTask, report: MemberResult | null | undefined, evidence: string, config: AppConfig, changes: ChangeStore): string | undefined {
	if (!evidence.trim()) return "完成任务必须记录验收依据。";
	if (!report || task.latestResult !== report.id || report.status !== "done") return "没有成功的最新交付结果，不能完成任务。";
	if (task.reviewer && !task.checksByMember?.some((check) => check.sourceResultId === report.id && check.member === task.reviewer!.member && check.member !== report.member && check.status === "accepted" && !!check.resultId && !!check.evidence?.trim())) return "该任务要求独立复核，当前交付尚无有效通过结论，不能绕过复核标完成。";
	const independent = task.checksByMember?.findLast((check) => check.sourceResultId === report.id && check.status === "accepted");
	if (independent?.sourceChangeId && changes.get(independent.sourceChangeId)?.head !== independent.sourceHead) return "代码版本已变化，旧独立复核结论不能验收新的代码版本。";
	if (task.activeDispatch || !["review", "done"].includes(task.status)) return "任务仍在执行或未进入待验收状态，不能完成。";
	if (task.recoveries?.some((recovery) => ["prepared", "running"].includes(recovery.status))) return "任务恢复计划尚未收尾，不能验收旧结果。";
	if (task.deps.some((id) => board.tasks[id]?.status !== "done")) return "前置任务尚未验收完成。";
	if (Object.values(board.tasks).some((child) => child.parent === task.id && !["done", "dropped"].includes(child.status))) return "还有未验收的子任务，不能完成上级任务。";
	if (task.checks?.length && !verifyReport(report.id, report.text, task.acceptance, task.checks, report.createdAt).passed) return "机器验收检查尚未通过，不能完成任务。";
	if (task.scope && task.changes.some((id) => { const change = changes.get(id); return change && change.status !== "dropped" && checkFilesScope(change.files, task.scope).length > 0; })) return "代码改动超出任务路径契约（scope），不能完成任务。";
	if (config.autonomy.enabled && task.changes.some((id) => { const change = changes.get(id); return change && change.status !== "dropped" && change.files.length > 0 && config.autonomy.checks.length > 0 && (!change.verification || change.verification.head !== change.head || !change.verification.passed); })) return "代码验收检查尚未通过，不能完成任务。";
}

export function recordReview(task: BoardTask, report: MemberResult, action: "accept" | "rework" | "block", evidence: string, at: number): void {
	if (task.checks?.length) task.verification = verifyReport(report.id, report.text, task.acceptance, task.checks, at);
	task.status = action === "accept" ? "done" : action === "rework" ? "todo" : "blocked";
	task.review = { resultId: report.id, verdict: action === "accept" ? "accepted" : action === "rework" ? "rework" : "blocked", evidence: evidence.trim().slice(0, 6000), at };
	const note = `验收 ${action} · ${report.id}：${evidence.trim().slice(0, 1500)}`;
	if (task.notes.at(-1) !== note) task.notes.push(note);
	task.updatedAt = at;
}

export function manualTransitionRefusal(task: BoardTask, status: TaskStatus | undefined, note?: string): string | undefined {
	if (!status || status === task.status) return;
	if (task.activeDispatch || task.status === "doing") return "任务仍由派工执行；请先取消派工并等待收尾，再调整任务状态。";
	if (["doing", "review"].includes(status)) return "进行中和待验收状态由真实派工产生，不能手动伪造。";
	if (!note?.trim()) return "调整任务状态必须写明验收、返工、受阻或取消原因。";
}
