import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { acceptanceContract, verifyReport } from "./acceptance.ts";
import { Board, type BoardState, type ProjectFiles } from "./board.ts";
import { commitBoard } from "./dispatch.ts";
import { Results } from "./results.ts";
import type { ChangeStore } from "./changes.ts";
import { autonomyChecksForRoot, type AppConfig } from "./config.ts";
import { completionRefusal, recordReview } from "./task-lifecycle.ts";
import { pendingRecovery } from "./task-recovery.ts";
import { readyTasks } from "./task-readiness.ts";

export function createTaskReviewTool(project: ProjectFiles, config: AppConfig, changes: ChangeStore) {
	return defineTool({
		name: "review_task", description: "对最新成员结果进行验收并持久记录证据。check 运行预设机器规则；accept 需要依据并标完成；rework 打回待办并说明缺口；block 记录受阻。规则只能验证格式与显式字段，不能证明业务事实；必须独立核对依据。验收标准在首次派工后不能修改。",
		parameters: obj({ id: str(), action: oneOf(["check", "accept", "rework", "block"]), result_id: str({ description: "任务最新 result_id，防止验收旧结果" }), evidence: opt(str({ description: "逐项核对依据，或返工/受阻原因；accept/rework/block 必填" })) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const snapshot = (await api.snapshot(Board, context)) as BoardState | undefined;
			const task = snapshot?.tasks[args.id];
			const report = (await api.snapshot(Results, api.conversationId, args.result_id, context))?.result;
			const fail = (message: string) => ({ output: [{ type: "text" as const, text: message }], isError: true });
			if (!task || !report || task.latestResult !== args.result_id) return fail("任务或最新结果不匹配，不能验收其他任务、会话或旧结果。");
			if (task.controllerId && task.controllerId !== String(api.conversationId)) return fail("不能跨总控验收其他任务。");
			if (task.checksByMember?.some((check) => check.status === "running") && ["accept", "rework"].includes(args.action)) return fail("独立复核正在进行，等待其结论；需要人工停止时可 block。");
			if (pendingRecovery(task)) return fail("任务已有恢复计划，等待派工收尾后再验收。");
			const verdict = args.action === "accept" ? "accepted" : args.action === "rework" ? "rework" : args.action === "block" ? "blocked" : undefined;
			if (verdict && task.review?.resultId === report.id && task.review.verdict === verdict && task.review.evidence === args.evidence?.trim().slice(0, 6000) && task.status === (args.action === "accept" ? "done" : args.action === "rework" ? "todo" : "blocked")) return { output: [{ type: "text" as const, text: JSON.stringify({ task: args.id, action: args.action, resultId: report.id, alreadyRecorded: true }) }] };
			if (task.status === "doing" || task.status === "dropped") return fail("任务仍在执行或已取消，不能验收。");
			if (args.action !== "check" && !args.evidence?.trim()) return fail("请提供验收依据或明确的返工/受阻原因。");
			if (args.action === "accept" && config.autonomy.enabled && task.changes.some((id) => {
				const change = changes.get(id);
				return change && change.files.length > 0 && autonomyChecksForRoot(change.root, config).length > 0 && (!change.verification || change.verification.head !== change.head || !change.verification.passed);
			})) return fail("代码验收尚未通过，不能通过业务验收绕过代码检查。");
			const contract = acceptanceContract(task.acceptance, task.checks);
			const verification = task.checks?.length ? verifyReport(report.id, report.text, task.acceptance, task.checks, api.now()) : undefined;
			const { result, board } = await commitBoard(project, { now: () => api.now(), output: (chunk) => api.output(chunk), commit: (change) => api.commit(change, context) }, async (board, tx) => {
				const current = board.tasks[args.id];
				if (!current || current.latestResult !== args.result_id || current.status !== task.status || acceptanceContract(current.acceptance, current.checks) !== contract) return "任务已变化，请重新读取后验收。";
				if (current.checksByMember?.some((check) => check.status === "running") && ["accept", "rework"].includes(args.action)) return "独立复核已开始，等待其结论或明确标为受阻。";
				if (current.activeDispatch) return "任务仍在执行，请等待收尾。";
				if (args.action === "accept") {
					const latest = (await tx.doc(Results, api.conversationId, args.result_id, null)).result;
					const refusal = completionRefusal(board, current, latest, args.evidence ?? "", config, changes); if (refusal) return refusal;
				}
				if (verification) current.verification = verification;
				if (args.action !== "check") {
					recordReview(current, report, args.action, args.evidence!, api.now());
				}
				current.updatedAt = api.now();
				return null;
			});
			if (result) return fail(result);
			return { output: [{ type: "text" as const, text: JSON.stringify({ task: args.id, action: args.action, resultId: report.id, verification: verification ?? null, evidence: args.evidence ?? null, ready: readyTasks(board, String(api.conversationId)).filter((task) => task.ready) }) }], isError: args.action === "check" && !!verification && !verification.passed };
		},
	});
}
