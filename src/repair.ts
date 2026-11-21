// 与同步/后台共用的派工闭环。只续接已有工作副本，保留预算、取消和原有合并流程。
import type { AgentKind } from "./config.ts";
import { createHash } from "node:crypto";
import { checkBudget, RunBudget, runDispatch, type DispatchArgs, type DispatchDeps, type DispatchIO, type DispatchResult } from "./dispatch.ts";
import { Learning } from "./learning.ts";

export async function managedDispatch(kind: AgentKind, command: string[], deps: DispatchDeps, args: DispatchArgs, io: DispatchIO, label?: string): Promise<DispatchResult> {
	const policy = deps.config.autonomy;
	if (!policy.enabled) return runDispatch(kind, command, deps, args, io, label);
	const runKey = await io.commit(async (tx) => (await tx.doc(RunBudget)).runKey);
	const fingerprint = createHash("sha256").update(args.task_id ?? args.task.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 20);
	const key = `${runKey}:${kind}:${fingerprint}`;
	const previous = await io.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Learning)).events.filter((e) => e.key === key))) as import("./learning.ts").RepairEvent[]);
	const used = previous.reduce((max, event) => Math.max(max, event.attempt), 0);
	if (used >= policy.maxRepairAttempts && previous.some((e) => e.attempt === used && e.status === "failed")) {
		return { text: "这项任务已耗尽本轮自动修复次数，停止重复派工。请汇报失败证据；用户明确调整任务后再继续。", isError: true };
	}
	let result = await runDispatch(kind, command, deps, args, io, label);
	const firstFailure = result.text.slice(-1200);
	let totalCost = result.summary?.costUsd ?? 0;
	let totalTime = result.summary?.durationMs ?? 0;
	let attempts = 0;
	for (let attempt = used + 1; result.isError && !result.aborted && attempt <= policy.maxRepairAttempts; attempt++) {
		if (io.signal.aborted || deps.hub.closing) break;
		const summary = result.summary;
		// 没有可续接的执行上下文、权限/认证错误等，交回调度，不盲目重复付费。
		if (!summary?.sessionId && !summary?.changeId) break;
		if (/超时|timed? ?out|permission denied|权限拒绝|被权限拒绝|unauthorized|authentication|api.?key|insufficient|余额|没有就绪|不可用|已达上限/i.test(result.text)) break;
		const over = await checkBudget(io, deps.config);
		if (over) { result.text += `\n\n${over}`; if (result.summary) result.summary.body += `\n\n${over}`; break; }
		attempts = attempt;
		await io.commit(async (tx) => {
			const state = await tx.doc(Learning);
			if (!state.events.some((e) => e.key === key && e.attempt === attempt)) {
				state.events.push({ key, task: args.task.slice(0, 200), agent: kind, attempt, status: "repairing", at: io.now() });
				state.events = state.events.slice(-100);
			}
		});
		io.output(`自动修复 ${attempt}/${policy.maxRepairAttempts}：续接 ${kind}，只传本次失败摘要\n`);
		const repairIO: DispatchIO = {
			...io, callId: `${io.callId}:repair:${attempt}`, taskId: `${io.taskId}:repair:${attempt}`,
			memo: (name, candidate) => io.memo(`repair.${attempt}.${name}`, candidate),
		};
		const next: DispatchArgs = {
			task: `原任务：${args.task.slice(0, 2500)}\n\n自动修复 ${attempt}/${policy.maxRepairAttempts}。当前代码未通过验收，检查根因并最小修改，保留原有验收标准，不要跳过或弱化检查。\n失败证据（节选）：\n${result.text.slice(-3000)}`,
			...(args.task_id ? { task_id: args.task_id } : {}),
			...(args.model ? { model: args.model } : {}),
			...(summary.sessionId ? { session_id: summary.sessionId } : { based_on: summary.changeId! }),
		};
		result = await runDispatch(kind, command, deps, next, repairIO, label);
		totalCost += result.summary?.costUsd ?? 0;
		totalTime += result.summary?.durationMs ?? 0;
		await io.commit(async (tx) => {
			const event = (await tx.doc(Learning)).events.find((e) => e.key === key && e.attempt === attempt);
			if (event) event.status = result.aborted ? "cancelled" : result.isError ? "failed" : "completed";
		});
	}
	if (attempts) {
		const change = result.summary?.changeId ? deps.changes.get(result.summary.changeId) : undefined;
		if (!result.isError && change?.verification?.passed && change.verification.head === change.head) {
			await io.commit(async (tx) => {
				const state = await tx.doc(Learning);
				if (!state.lessons.some((l) => l.key === key)) state.lessons.push({ key, task: args.task.slice(0, 200), checks: change.verification!.checks, repairs: attempts, at: io.now(), failure: firstFailure, resolution: result.summary?.body.slice(0, 800) ?? "", changeId: change.id, head: change.head });
				state.lessons = state.lessons.slice(-50);
			});
		}
		const note = `\n\n[自动修复 ${attempts}/${policy.maxRepairAttempts}；${result.isError ? "尚未通过，停止重试并交回调度" : "派工完成，仍需对照任务验收"}；本次派工累计 $${totalCost.toFixed(4)}]`;
		result.text += note;
		if (result.summary) { result.summary.costUsd = totalCost; result.summary.durationMs = totalTime; result.summary.body += note; }
		if (result.details) { result.details.costUsd = totalCost; result.details.durationMs = totalTime; result.details.repairs = attempts; }
	}
	return result;
}
