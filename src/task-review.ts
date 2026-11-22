import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { acceptanceContract, verifyReport } from "./acceptance.ts";
import { Board, type BoardState, type ProjectFiles } from "./board.ts";
import { commitBoard } from "./dispatch.ts";
import { Results } from "./results.ts";
import type { ChangeStore } from "./changes.ts";
import type { AppConfig } from "./config.ts";

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
			const verdict = args.action === "accept" ? "accepted" : args.action === "rework" ? "rework" : args.action === "block" ? "blocked" : undefined;
			if (verdict && task.review?.resultId === report.id && task.review.verdict === verdict && task.review.evidence === args.evidence?.trim().slice(0, 6000) && task.status === (args.action === "accept" ? "done" : args.action === "rework" ? "todo" : "blocked")) return { output: [{ type: "text" as const, text: JSON.stringify({ task: args.id, action: args.action, resultId: report.id, alreadyRecorded: true }) }] };
			if (task.status === "doing" || task.status === "dropped") return fail("任务仍在执行或已取消，不能验收。");
			if (args.action !== "check" && !args.evidence?.trim()) return fail("请提供验收依据或明确的返工/受阻原因。");
			if (args.action === "accept" && config.autonomy.enabled && task.changes.some((id) => {
				const change = changes.get(id);
				return change && change.files.length > 0 && config.autonomy.checks.length > 0 && (!change.verification || change.verification.head !== change.head || !change.verification.passed);
			})) return fail("代码验收尚未通过，不能通过业务验收绕过代码检查。");
			const contract = acceptanceContract(task.acceptance, task.checks);
			const verification = task.checks?.length ? verifyReport(report.id, report.text, task.acceptance, task.checks, api.now()) : undefined;
			if (args.action === "accept" && (report.status !== "done" || task.status !== "review" || (verification && !verification.passed))) return fail("最新执行未成功、任务不在待验收状态或机器规则未通过；不能完成。请读取结果和缺口后返工。");
			const { result } = await commitBoard(project, { now: () => api.now(), output: (chunk) => api.output(chunk), commit: (change) => api.commit(change, context) }, (board) => {
				const current = board.tasks[args.id];
				if (!current || current.latestResult !== args.result_id || current.status !== task.status || acceptanceContract(current.acceptance, current.checks) !== contract) return "任务已变化，请重新读取后验收。";
				if (args.action === "accept" && current.deps.some((id) => board.tasks[id]?.status !== "done")) return "前置任务尚未验收完成。";
				if (verification) current.verification = verification;
				if (args.action !== "check") {
					current.status = args.action === "accept" ? "done" : args.action === "rework" ? "todo" : "blocked";
					current.review = { resultId: report.id, verdict: args.action === "accept" ? "accepted" : args.action === "rework" ? "rework" : "blocked", evidence: args.evidence!.trim().slice(0, 6000), at: api.now() };
					const note = `验收 ${args.action} · ${report.id}：${args.evidence!.trim().slice(0, 1500)}`;
					if (current.notes.at(-1) !== note) current.notes.push(note);
				}
				current.updatedAt = api.now();
				return null;
			});
			if (result) return fail(result);
			return { output: [{ type: "text" as const, text: JSON.stringify({ task: args.id, action: args.action, resultId: report.id, verification: verification ?? null, evidence: args.evidence ?? null }) }], isError: args.action === "check" && !!verification && !verification.passed };
		},
	});
}
