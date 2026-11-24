import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { App } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { Board, type BoardState } from "./board.ts";
import { prepareRecovery, taskRecoveryView, type RecoveryRequest } from "./task-recovery.ts";

export const TASK_HELP = "/task inspect <任务ID> · /task resume <任务ID> <处理依据> · /task supply <任务ID> <新增资料> · /task reassign <任务ID> <成员ID> <交接依据> · /task cancel <任务ID> <原因>";
export async function taskCommand(line: string, host: { app: App; config: AppConfig; context: Context; assertIdle(): Promise<void>; log(text: string): void }): Promise<boolean> {
	if (!/^\/task(?:\s|$)/.test(line)) return false;
	const [, action = "help", id, ...rest] = line.trim().split(/\s+/);
	if (action === "help") { host.log(TASK_HELP); return true; }
	if (!id || !["inspect", "resume", "supply", "reassign", "cancel"].includes(action)) throw new Error(TASK_HELP);
	const { app, context, config } = host;
	if (action === "inspect") { if (rest.length) throw new Error(TASK_HELP); host.log(JSON.stringify(taskRecoveryView(await app.harness.snapshot(Board, context), id, String(app.root.id)), null, 2)); return true; }
	await host.assertIdle();
	const member = action === "reassign" ? rest.shift() : undefined, note = rest.join(" ");
	const args: RecoveryRequest = { id, action: action as RecoveryRequest["action"], note, ...(member ? { member } : {}) };
	if (action === "cancel") {
		const board = await app.harness.commit(async (tx) => { await prepareRecovery(tx, app.root.id, config, app.changes, args, randomUUID(), Date.now()); return JSON.parse(JSON.stringify(await tx.doc(Board))) as BoardState; }, context);
		try { app.project.writeAssign(board); } catch {} host.log(`已取消 ${id} 尚未执行的恢复计划。`); return true;
	}
	const job = await app.recoverTask(app.root.id, args, randomUUID(), context);
	host.log(`恢复 ${id} 已交给 ${job.agent}，后台 ${job.id}；${job.resume ? `续接 ${job.resume}` : "新成员会话"}。不重跑已验收依赖；/jobs 查看，/jobs cancel ${job.id} 取消。`); return true;
}
