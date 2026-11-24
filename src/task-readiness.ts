import type { BoardState, BoardTask } from "./board.ts";

export type TaskReadiness = { id: string; ready: boolean; reasons: string[]; dependencies: { id: string; status: string; resultId?: string }[] };

/** Derived from the Durable board; never duplicates execution or conversation state. */
export function taskReadiness(board: BoardState, task: BoardTask): TaskReadiness {
	const dependencies = task.deps.map((id) => { const dependency = board.tasks[id]; return { id, status: dependency?.status ?? "missing", ...(dependency?.latestResult ? { resultId: dependency.latestResult } : {}) }; });
	const reasons: string[] = [];
	if (task.status !== "todo") reasons.push(`任务状态：${task.status}`);
	if (task.activeDispatch) reasons.push("已有派工占用");
	if (task.checksByMember?.some((check) => check.status === "running")) reasons.push("独立复核正在进行");
	for (const dependency of dependencies) if (dependency.status !== "done") reasons.push(`等待 ${dependency.id} 验收（${dependency.status}）`);
	if (task.parent && ["done", "dropped"].includes(board.tasks[task.parent]?.status ?? "")) reasons.push("上级任务已结束");
	if (task.recoveries?.some((recovery) => ["prepared", "running"].includes(recovery.status))) reasons.push("已有恢复计划");
	return { id: task.id, ready: reasons.length === 0, reasons, dependencies };
}

export function readyTasks(board: BoardState, controllerId?: string): TaskReadiness[] {
	return board.order.map((id) => board.tasks[id]).filter((task): task is BoardTask => !!task && (!controllerId || (task.controllerId ?? task.lastAttempt?.controllerId ?? controllerId) === controllerId)).map((task) => taskReadiness(board, task));
}
