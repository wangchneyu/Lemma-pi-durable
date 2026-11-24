import { defineDoc, defineTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { memberToolNames } from "./api-member.ts";
import { Board, type BoardState, type BoardTask } from "./board.ts";
import type { ChangeStore } from "./changes.ts";
import type { DispatchArgs, DispatchDeps } from "./dispatch.ts";
import { Jobs, JOB_REQUEST_PREFIX, JOB_REPORT_ENTRY, type JobRecord } from "./jobs.ts";
import { Results } from "./results.ts";
import { taskReadiness } from "./task-readiness.ts";
import { completionRefusal, recordReview } from "./task-lifecycle.ts";
import { prepareRecovery } from "./task-recovery.ts";
import { Integrations } from "./integrations.ts";
import { integrationStale } from "./integration-git.ts";
import { checkFilesScope, formatScopeSummary } from "./scope.ts";

export const Workflow = defineDoc<{ controllers: Record<string, { taskId?: string; paused?: boolean; summaryKey?: string }> }>({ kind: "lemma.task-workflow", version: 1, scope: "session", initial: () => ({ controllers: {} }), checkpointWhen: () => false });
export type EnqueueWorkflowJob = (tx: Tx, controller: ConversationId, key: string, member: string, args: DispatchArgs, model?: string) => Promise<JobRecord>;
export type CheckerVerdict = { verdict: "accept" | "rework" | "block"; evidence: string; result_id: string };

export function checkerVerdict(text: string, resultId: string): CheckerVerdict | undefined {
	try {
		const value = JSON.parse(text.trim());
		if (!value || !["accept", "rework", "block"].includes(value.verdict) || value.result_id !== resultId || typeof value.evidence !== "string" || !value.evidence.trim() || value.evidence.length > 6000) return;
		return { verdict: value.verdict, evidence: value.evidence.trim(), result_id: value.result_id };
	} catch { return; }
}

const own = (task: BoardTask, controller: string) => task.controllerId === controller || !task.controllerId && task.lastAttempt?.controllerId === controller;

/** Return non-dropped changes not superseded via basedOn by a newer change in the same set. */
export function effectiveTaskChanges(store: ChangeStore, ids: string[]): string[] {
	const active = [...new Set(ids)].filter((id) => {
		const record = store.get(id);
		return !!record && record.status !== "dropped";
	});
	const hasDescendant = (ancestorId: string): boolean => active.some((id) => {
		if (id === ancestorId) return false;
		const seen = new Set<string>();
		let cur = store.get(id)?.basedOn;
		while (cur && !seen.has(cur)) {
			if (cur === ancestorId) return true;
			seen.add(cur);
			cur = store.get(cur)?.basedOn;
		}
		return false;
	});
	return active.filter((id) => !hasDescendant(id));
}

/** Claims and checker decisions share Durable transactions; scans never call a model. */
export function createTaskWorkflow(deps: DispatchDeps, available: Set<string>, enqueue: EnqueueWorkflowJob) {
	const { config, changes, hub, project } = deps;
	async function advance(tx: Tx, controller: ConversationId, at: number): Promise<boolean> {
		if ((await tx.doc(Workflow)).controllers[String(controller)]?.paused) return false;
		const board = await tx.doc(Board), jobs = await tx.doc(Jobs);
		const tasks = board.order.map((id) => board.tasks[id]).filter((item): item is BoardTask => !!item && own(item, String(controller)));
		let waiting = false;
		for (const item of tasks) {
			const execution = item.workflowJobs?.findLast((job) => job.kind === "execute");
			if (execution && jobs.jobs[execution.jobId]?.status === "running") { waiting = true; continue; }
			if (item.activeDispatch) { waiting = true; continue; }
			const check = item.checksByMember?.at(-1);
			if (check?.status === "running") {
				const job = check.jobId ? jobs.jobs[check.jobId] : undefined;
				if (job?.status === "running") { waiting = true; continue; }
				const report = job ? (await tx.doc(Results, controller, `dispatch:${job.piTask}`, null)).result : null;
				if (item.latestResult !== check.sourceResultId || item.status !== "review") { check.status = "failed"; check.evidence = "交付版本或任务状态已变化，旧复核不生效。"; continue; }
				if (check.sourceChangeId && changes.get(check.sourceChangeId)?.head !== check.sourceHead) { check.status = "failed"; check.evidence = "代码版本已变化，当前复核作废。"; item.status = "blocked"; item.notes.push(check.evidence); continue; }
				const verdict = job?.status === "done" && report?.status === "done" ? checkerVerdict(report.text, check.sourceResultId) : undefined;
				if (report) check.resultId = report.id;
				const reviewChange = job?.changeId ? changes.get(job.changeId) : undefined;
				if (!verdict || reviewChange && (reviewChange.head !== reviewChange.base || !!reviewChange.message)) {
					check.status = "failed"; check.evidence = !verdict ? "独立复核失败或缺少绑定当前交付的 JSON 结论，需人工处理。" : "复核成员修改了被审查代码，未将结论当作通过。";
					item.status = "blocked"; item.notes.push(check.evidence); item.updatedAt = at; continue;
				}
				check.status = verdict.verdict === "accept" ? "accepted" : verdict.verdict === "rework" ? "rework" : "blocked"; check.evidence = verdict.evidence;
				const source = (await tx.doc(Results, controller, check.sourceResultId, null)).result;
				const refusal = verdict.verdict === "accept" ? completionRefusal(board, item, source, verdict.evidence, config, changes) : undefined;
				if (refusal) { check.status = "blocked"; check.evidence = refusal; item.status = "blocked"; item.notes.push(refusal); }
				else if (source) recordReview(item, source, verdict.verdict, verdict.evidence, at);
				item.updatedAt = at;
			}
			if (item.status === "review" && item.reviewer && item.latestResult && !item.activeDispatch && !item.checksByMember?.some((entry) => entry.sourceResultId === item.latestResult)) {
				const source = (await tx.doc(Results, controller, item.latestResult, null)).result;
				const member = item.reviewer.member;
				if (!source || source.status !== "done" || member === source.member || !available.has(member)) { item.status = "blocked"; item.notes.push("独立复核未启动：交付未成功、复核成员与执行者相同或成员不可用。"); continue; }
				const permissions = config.agents[member]?.api;
				if (permissions && (memberToolNames(permissions).some((tool) => ["write", "edit", "bash"].includes(tool)) || permissions.httpTools?.some((tool) => tool.method === "POST"))) { item.status = "blocked"; item.notes.push("自动独立复核要求只读 API 成员，不授予写入、编辑、Shell 或 POST；请配置专用复核成员。"); continue; }
				const effectiveChanges = effectiveTaskChanges(changes, item.changes);
				const changeId = item.lastAttempt?.changeId ?? effectiveChanges.at(-1) ?? item.changes.at(-1);
				const changed = changeId ? changes.get(changeId) : undefined;
				if (changeId && (!changed || changed.status === "dropped" || changed.message)) { item.status = "blocked"; item.notes.push("原交付代码副本不存在、已丢弃或提交未成功，未对其他代码版本复核。"); continue; }
				if (effectiveChanges.length > 1) { item.status = "blocked"; item.notes.push("交付涉及多个未集成活动代码分支，需要联合集成验证后复核，未只审查单个分支即标完成。"); continue; }
				if (changed?.files.length && (config.agents[member]?.workspace === "none" || !config.isolation.enabled)) { item.status = "blocked"; item.notes.push("代码复核需要启用隔离且复核成员能够读取独立代码工作区。"); continue; }
				if (changed?.files.length && item.scope && checkFilesScope(changed.files, item.scope).length) { item.status = "blocked"; item.notes.push(`交付代码违反任务路径契约（${formatScopeSummary(item.scope)}），未进入独立复核。`); continue; }
				const blindReview = !!item.reviewer.blind && !!changed?.files.length;
				if (!blindReview && source.text.length > 64000) { item.status = "blocked"; item.notes.push("交付超过自动复核单次交接上限（64000 字符），需总控拆分证据后复核；未将截断结果当作完整验收。"); continue; }
				const chunkCount = Math.max(1, Math.ceil(source.text.length / 8000));
				const reviewInputs = blindReview ? [] : Array.from({ length: chunkCount }, (_, index) => ({ result_id: source.id, offset: index * 8000, limit: 8000 }));
				const scopeNote = item.scope ? `\n路径契约：${formatScopeSummary(item.scope)}` : "";
				const codeSummary = changed?.files.length
					? `\n代码改动 #${changed.id}（${changes.range(changed)[0].slice(0, 12)}..${changed.head.slice(0, 12)}，共 ${changed.files.length} 个文件，+${changed.add} -${changed.del}）：\n${changed.files.slice(0, 30).map((f) => `  - ${f.path} (+${f.add} -${f.del})`).join("\n")}${changed.files.length > 30 ? `\n  - …共 ${changed.files.length} 个文件` : ""}\n请结合工作区只读检查（git_diff / outline_file / find_symbol / search_code / list_files / read）核对真实代码实现与边界情况，不要仅凭执行者自述判断。`
					: "";
				const blindNote = blindReview
					? `\n【代码盲审模式（Blind Review）】为消除迎合偏见（Sycophancy），系统已隐去执行者的主观自述解释。请完全依据任务验收标准、路径契约与工作区真实代码改动（git_diff / read）独立核查实现质量与边界缺陷；当前待签名交付版本为 result_id="${source.id}"。`
					: "\n核对引用中的完整交付和证据；资料不足应 block，发现缺陷应 rework。";
				const args: DispatchArgs = { task: `独立复核任务 ${item.id}：${item.title}。你不是执行者，不得修改交付或代码，不得降低验收标准。\n验收标准：${item.acceptance ?? "逐项核对结论与证据"}${scopeNote}\n机器规则：${JSON.stringify(item.checks ?? [])}${codeSummary}${blindNote}\n仅输出 JSON：{"verdict":"accept|rework|block","result_id":"${source.id}","evidence":"逐项核对依据和具体缺口"}。`, ...(reviewInputs.length ? { inputs: reviewInputs } : {}), ...(changed?.files.length ? { based_on: changed.id } : {}), ...(item.reviewer.model ? { model: item.reviewer.model } : {}) };
				const job = await enqueue(tx, controller, `checker:${item.id}:${source.id}`, member, args, item.reviewer.model);
				item.checksByMember ??= []; item.checksByMember.push({ sourceResultId: source.id, member, status: "running", jobId: job.id, at, ...(changed?.files.length ? { sourceChangeId: changed.id, sourceHead: changed.head } : {}) });
				item.workflowJobs ??= []; item.workflowJobs.push({ jobId: job.id, kind: "review", sourceResultId: source.id }); board.updatedAt = at; return true;
			}
			if (!item.automation || !taskReadiness(board, item).ready) { if (item.reviewer && item.status === "doing") waiting = true; continue; }
			if (item.reviewer && item.automation.member === item.reviewer.member) { item.status = "blocked"; item.notes.push("执行者和独立复核者不能相同。"); continue; }
			if (!available.has(item.automation.member)) { item.status = "blocked"; item.notes.push("自动执行成员不可用；请检查 /agents 后人工恢复。"); continue; }
			if (item.dispatches.length && item.review?.verdict !== "rework") continue;
			let args: DispatchArgs;
			if (item.dispatches.length) {
				const reworks = item.checksByMember?.filter((entry) => entry.status === "rework").length ?? 0;
				if (!reworks || reworks > item.automation.maxReworks) { item.status = "blocked"; item.notes.push("独立复核返工次数已达上限，保留证据交给人工处理。"); continue; }
				try {
					const prepared = await prepareRecovery(tx, controller, config, changes, { id: item.id, action: "resume", note: `独立复核要求返工：${item.review!.evidence}` }, `workflow-rework:${item.id}:${item.latestResult}`, at);
					if (!prepared.dispatch) continue; args = prepared.dispatch;
				} catch (error) { item.status = "blocked"; item.notes.push(`自动返工未启动：${error instanceof Error ? error.message : String(error)}`); continue; }
			} else {
				const dependencies = item.deps.map((id) => board.tasks[id]!);
				if (dependencies.length > 8 || dependencies.some((dependency) => !dependency.latestResult || (dependency.controllerId ?? dependency.lastAttempt?.controllerId ?? String(controller)) !== String(controller))) { item.status = "blocked"; item.notes.push("自动交接需要最多 8 个同总控且有交付引用的前置结果；请拆分任务或显式交接，未静默省略依赖。"); continue; }
				const changeIds = effectiveTaskChanges(changes, dependencies.flatMap((dependency) => dependency.changes));
				if (changeIds.length && (config.agents[item.automation.member]?.workspace === "none" || !config.isolation.enabled || changeIds.some((id) => !changes.get(id) || changes.get(id)?.status === "dropped"))) { item.status = "blocked"; item.notes.push("前置代码需要可用的隔离改动和编码成员，未在缺少前置代码时盲目执行。"); continue; }
				let basedOn = changeIds[0];
				if (changeIds.length > 1) {
					if (!deps.integrations) { item.status = "blocked"; item.notes.push("集成运行时尚未就绪。"); continue; }
					if (!item.integrationId) {
						try { const merged = await deps.integrations.create(tx, controller, changeIds, `workflow-integration:${item.id}:${changeIds.map((id) => `${id}:${changes.get(id)!.head}`).join(":")}`); item.integrationId = merged.id; return true; }
						catch (error) { item.status = "blocked"; item.notes.push(`无法启动联合集成：${String(error)}`); continue; }
					}
					const merged = (await tx.doc(Integrations)).records[item.integrationId];
					if (!merged || ["preparing", "merging", "repairing", "testing"].includes(merged.integration!.status)) { waiting = true; continue; }
					if (merged.integration!.status !== "passed") { item.status = "blocked"; item.notes.push(`前置联合集成 #${merged.id} ${merged.integration!.status}：${merged.message ?? "查看集成记录"}`); continue; }
					basedOn = merged.id;
				}
				const inputs: NonNullable<DispatchArgs["inputs"]> = [];
				for (const dependency of dependencies) {
					const depResult = (await tx.doc(Results, controller, dependency.latestResult!, null)).result;
					const total = depResult?.text.length ?? 0;
					const chunks = Math.max(1, Math.ceil(total / 8000));
					for (let offset = 0; offset < chunks * 8000 && inputs.length < 8; offset += 8000) {
						inputs.push({ result_id: dependency.latestResult!, offset, limit: 8000 });
						if (offset + 8000 >= total) break;
					}
				}
				args = { task_id: item.id, task: `${item.title}\n${item.detail ?? ""}\n验收标准：${item.acceptance ?? "提供可核对的结果与依据"}`, inputs, ...(basedOn ? { based_on: basedOn } : {}), ...(item.automation.model ? { model: item.automation.model } : {}) };
			}
			const job = await enqueue(tx, controller, `workflow:${item.id}:${item.dispatches.length}:${item.latestResult ?? "initial"}`, item.automation.member, args, args.model);
			item.activeDispatch = job.callId; item.status = "doing";
			if (!item.dispatches.includes(job.callId)) item.dispatches.push(job.callId);
			item.workflowJobs ??= []; item.workflowJobs.push({ jobId: job.id, kind: "execute" }); board.updatedAt = at; return true;
		}
		return waiting;
	}
	const task = defineTask<{ controller: string }, { phase: "scan" }, { stopped: boolean }>({
		name: "lemma.task-workflow", version: 1, initial: () => ({ phase: "scan" }),
		phases: { scan: async (running, runtime, context) => {
			const conversation = await runtime.conversation(runtime.conversationId, context);
			let active = false, changed = false;
			await runtime.commit(async (tx) => {
				const board = await tx.doc(Board), before = JSON.stringify(board);
				active = await advance(tx, runtime.conversationId, runtime.now()); changed = JSON.stringify(board) !== before;
				if (changed) board.updatedAt = runtime.now();
				if (!active) {
					const state = (await tx.doc(Workflow)).controllers[running.input.controller];
					const items = board.order.map((id) => board.tasks[id]).filter((item) => item && own(item, running.input.controller));
					const summaryKey = createHash("sha256").update(JSON.stringify(items.map((item) => [item!.id, item!.status, item!.latestResult ?? null, item!.checksByMember?.at(-1)?.status ?? null, item!.notes.at(-1) ?? null]))).digest("hex");
					if (conversation && state && !state.paused && state.summaryKey !== summaryKey) {
						await conversation.submit(tx, { type: "input", content: `【协作推进结果】${items.map((item) => `${item!.id}:${item!.status}${item!.checksByMember?.at(-1) ? `，独立复核 ${item!.checksByMember.at(-1)!.status}` : ""}`).join("；")}。这是系统状态通知；查看 ready_tasks 和失败证据，汇报已完成、受阻与等待人工决定的事项，不重复派发已完成或自动执行中的任务。`, whenBusy: "steer", onAbort: "keep", requestId: `${JOB_REQUEST_PREFIX}workflow:${runtime.taskId}`, entry: { kind: JOB_REPORT_ENTRY, data: { job: `workflow:${runtime.taskId}`, agent: "team", status: "done" } } });
						state.summaryKey = summaryKey;
					}
					return { status: "terminal", outcome: { status: "completed", result: { stopped: true } } };
				}
			}, context);
			if (changed) { const board = await runtime.snapshot(Board, context); if (board) try { project.writeAssign(board as BoardState); } catch {} hub.changed(); }
			if (active) await runtime.sleepUntil(runtime.now() + (changed ? 1 : 250), { phase: "scan" }, context);
		} },
		abort: async (_task, runtime, context) => { await runtime.commit(async (tx) => {
			const state = await tx.doc(Workflow); state.controllers[String(runtime.conversationId)] = { ...state.controllers[String(runtime.conversationId)], taskId: String(runtime.taskId), paused: true };
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context); },
	});
	return { task, async ensure(tx: Tx, controller: ConversationId) {
		const board = await tx.doc(Board);
		if (!Object.values(board.tasks).some((item) => own(item, String(controller)) && (item.automation && ["todo", "doing"].includes(item.status) || item.reviewer && ["doing", "review"].includes(item.status) || item.checksByMember?.some((check) => check.status === "running")))) return;
		const state = await tx.doc(Workflow), previous = state.controllers[String(controller)];
		if (previous?.paused) return;
		const existing = previous?.taskId ? await tx.task(Number(previous.taskId) as TaskId) : undefined;
		if (existing && !["terminal", "completing"].includes(existing.state.status)) return;
		const id = await tx.createTask(task, { controller: String(controller) }, { ownership: { kind: "conversation" }, conversationId: controller, background: true });
		state.controllers[String(controller)] = { ...previous, taskId: String(id) };
	} };
}
