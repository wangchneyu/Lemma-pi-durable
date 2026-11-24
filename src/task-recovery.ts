import { defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { Board, type BoardState, type BoardTask, type ProjectFiles } from "./board.ts";
import type { AppConfig } from "./config.ts";
import type { ChangeStore } from "./changes.ts";
import type { DispatchArgs } from "./dispatch.ts";
import { Operations, unresolved } from "./operations.ts";
import { agentAdapter } from "./agents.ts";
import { join } from "node:path";

export type RecoveryRequest = { id: string; action: "resume" | "reassign" | "supply" | "cancel"; member?: string; note: string; result_id?: string };
export const pendingRecovery = (task: BoardTask) => task.recoveries?.findLast((recovery) => ["prepared", "running"].includes(recovery.status));
export function recoveryDispatch(task: BoardTask, recovery: NonNullable<BoardTask["recoveries"]>[number]): DispatchArgs {
	return { task: recovery.originalTask, task_id: task.id, recovery_id: recovery.id, ...(recovery.sessionId ? { session_id: recovery.sessionId } : {}), ...(recovery.basedOn ? { based_on: recovery.basedOn } : {}), ...(recovery.cwd ? { cwd: recovery.cwd } : {}), ...(recovery.model ? { model: recovery.model } : {}), ...(recovery.structured ? { structured: true } : {}), ...(recovery.originalInputs?.length ? { inputs: recovery.originalInputs } : {}) };
}
export function taskRecoveryView(board: BoardState | undefined, id: string, controller: string) {
	const task = board?.tasks[id]; if (!task) throw new Error("找不到任务。");
	if (task.controllerId && task.controllerId !== controller) throw new Error("该任务属于其他总控。");
	if (task.lastAttempt && task.lastAttempt.controllerId !== controller) throw new Error("该任务的派工属于其他总控，请在原总控处理。");
	return { task: { ...task, notes: task.notes.slice(-5), recoveries: task.recoveries?.slice(-3), dispatches: task.dispatches.slice(-3) }, acceptedDependencies: task.deps.map((id) => board!.tasks[id]).filter((dependency) => dependency?.status === "done").map((dependency) => ({ id: dependency!.id, title: dependency!.title, result_id: dependency!.latestResult ?? null })), next: pendingRecovery(task) ? "已有恢复计划；执行对应 ask_* 或取消计划，不能另开重复派工。" : task.status === "done" ? "任务已验收，直接复用结果；需求变化时新建任务。" : "先查看失败与验收依据；resume 续接、supply 补资料、reassign 换成员。" };
}
export async function prepareRecovery(tx: Tx, controller: ConversationId, config: AppConfig, changes: ChangeStore, args: RecoveryRequest, key: string, at: number) {
	const board = await tx.doc(Board), task = board.tasks[args.id];
	if (!task || !task.lastAttempt) throw new Error("任务没有可恢复的派工记录，请正常派工；旧版任务可显式传 session_id 继续。");
	if (task.lastAttempt.controllerId !== String(controller)) throw new Error("不能跨总控恢复成员任务。");
	if (task.controllerId && task.controllerId !== String(controller)) throw new Error("不能跨总控恢复其他任务。");
	if (task.checksByMember?.some((check) => check.status === "running")) throw new Error("独立复核仍在运行，等待其收尾后再恢复。");
	if (args.action === "cancel") { const cancelled = task.recoveries?.find((recovery) => recovery.cancelledByCall === key); if (cancelled) return { task: task.id, cancelled: cancelled.id }; }
	const recorded = task.recoveries?.find((recovery) => recovery.id === key);
	if (recorded) { if (recorded.status === "cancelled") throw new Error("恢复计划已取消。"); const snapshot = JSON.parse(JSON.stringify(recorded)) as typeof recorded; return { task: task.id, recovery: snapshot, dispatch: recoveryDispatch(task, snapshot) }; }
	if (!args.note.trim() || args.note.length > 6000) throw new Error("恢复需要 1–6000 字符的补充资料或处理依据。");
	const pending = pendingRecovery(task);
	if (args.action === "cancel") {
		if (!pending || pending.status !== "prepared" || task.activeDispatch) throw new Error("只有尚未执行的恢复计划可以取消；运行中的派工请先 /abort 或 /jobs cancel。");
		pending.status = "cancelled"; pending.cancelledByCall = key; task.status = pending.previousStatus; task.notes.push(`取消恢复 ${pending.id}：${args.note}`); task.updatedAt = at; board.updatedAt = at;
		return { task: task.id, cancelled: pending.id };
	}
	if (pending) throw new Error("该任务已有恢复计划，请执行或取消后再重建。");
	if (task.activeDispatch || !["todo", "blocked"].includes(task.status)) throw new Error("仅恢复待办或受阻任务；待验收结果先复核，已验收任务直接复用。");
	if (args.result_id && args.result_id !== task.latestResult) throw new Error("最新结果已变化，请重新查看任务再恢复。");
	if (task.deps.some((id) => board.tasks[id]?.status !== "done")) throw new Error("前置任务尚未验收，不能提前恢复。");
	const previous = task.lastAttempt, member = args.action === "reassign" ? args.member : previous.member;
	const target = member && Object.hasOwn(config.agents, member) ? config.agents[member] : undefined;
	if (!member || !target?.enabled) throw new Error("目标成员未配置或已停用；/agents 查看成员。");
	if (task.reviewer?.member === member) throw new Error("不能把执行任务恢复给它自己的独立复核成员。");
	if (args.action !== "reassign" && args.member && args.member !== member) throw new Error("换成员请使用 reassign。");
	if (Object.values((await tx.doc(Operations)).operations).some((operation) => operation.conversationId === previous.sessionId && operation.method === "POST" && unresolved(operation))) throw new Error("原派工仍有状态未知的外部写操作；先 /operations 核对远端，不能通过换人绕过。");
	const sessionId = args.action !== "reassign" && agentAdapter(member, target).canResume ? previous.sessionId : undefined;
	if (args.action === "resume" && !sessionId) throw new Error("没有可续接的成员会话，请 reassign 开新会话并交接已有证据。");
	const change = previous.changeId ? changes.get(previous.changeId) : undefined;
	if (previous.changeId && !change) throw new Error("原工作副本记录不存在，请先检查历史，不能静默从头重做。");
	if (change?.status === "dropped") throw new Error("原工作副本已丢弃，请明确重新建任务；恢复不会静默丢掉已有工作。");
	const basedOn = !sessionId && target.workspace !== "none" && change ? change.id : undefined;
	if (!sessionId && previous.changeId && target.workspace === "none") throw new Error("原任务有代码改动，请选择代码工作区成员接手。");
	const model = args.action !== "reassign" && previous.model && target.models.some((model) => model.id === previous.model) ? previous.model : target.defaultModel;
	const cwd = !sessionId && target.workspace !== "none" ? change ? join(change.root, change.subdir) : previous.cwd : undefined;
	const recovery = { id: key, controllerId: String(controller), action: args.action, member, note: args.note.trim(), fromResult: task.latestResult ?? null, originalTask: previous.task, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(previous.inputs ? { originalInputs: previous.inputs } : {}), ...(previous.structured ? { structured: true } : {}), ...(task.review ? { reviewEvidence: task.review.evidence } : {}), ...(sessionId ? { sessionId } : {}), ...(basedOn ? { basedOn } : {}), status: "prepared" as const, at, previousStatus: task.status };
	task.recoveries = [...(task.recoveries ?? []), recovery]; task.status = "todo"; task.owner = member; task.notes.push(`恢复 ${args.action} → ${member}：${args.note.trim()}`); task.updatedAt = at; board.updatedAt = at;
	const snapshot = JSON.parse(JSON.stringify(recovery)) as typeof recovery;
	return { task: task.id, recovery: snapshot, dispatch: recoveryDispatch(task, snapshot) };
}
export function createTaskRecoveryTool(project: ProjectFiles, config: AppConfig, changes: ChangeStore) {
	return defineTool({ name: "recover_task", description: "查看任务与已验收依赖，或准备受阻任务的续接、补资料、换成员计划。计划保留失败证据，不重跑已验收任务；返回的 dispatch 参数交给对应 ask_<成员> 执行。cancel 仅撤销未执行计划。不会调用成员或自动核销未知外部操作。", parameters: obj({ id: str(), action: oneOf(["inspect", "resume", "reassign", "supply", "cancel"]), member: opt(str()), note: opt(str()), result_id: opt(str()) }), replay: "safe", execute: async (args, api, context) => {
		try {
			if (args.action === "inspect") return { output: [{ type: "text" as const, text: JSON.stringify(taskRecoveryView(await api.snapshot(Board, context), args.id, String(api.conversationId))) }] };
			const out = await api.commit(async (tx) => { const result = await prepareRecovery(tx, api.conversationId, config, changes, { ...args, action: args.action as RecoveryRequest["action"], note: args.note ?? "" }, api.callId, api.now()); return { result, board: JSON.parse(JSON.stringify(await tx.doc(Board))) as BoardState }; }, context);
			try { project.writeAssign(out.board); } catch { api.output("恢复计划已保存，分工表文件暂未导出。\n"); }
			return { output: [{ type: "text" as const, text: JSON.stringify(out.result) }] };
		} catch (error) { return { output: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
	} });
}
