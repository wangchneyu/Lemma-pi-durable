// 把本机 CLI 包装成 Pi Durable 工具：ask_claude / ask_codex / ask_gemini。
// 每次派工可以：由总调度选模型；在独立的 git worktree 里干活（改动等用户在终端确认后才合并）；
// 受单次运行的花费上限约束；同步等结果，或者放到后台（background: true）由 wait_jobs 收结果。
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, defineTool, hook, ToolTask, section, type Extension, type JsonObject, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { agentAdapter } from "./agents.ts";
import { createMemberTools, memberAvailability } from "./api-member.ts";
import { Board, boardSummary, STATUS_LABEL, type BoardState, type BoardTask, type ProjectFiles, type TaskStatus } from "./board.ts";
import type { ChangeStore } from "./changes.ts";
import { resolveCommand, type AgentKind, type AppConfig } from "./config.ts";
import {
	checkBudget,
	commitBoard,
	defined,
	finishChange,
	runDispatch,
	validateDispatch,
	type DispatchArgs,
	type DispatchDeps,
	type DispatchIO,
} from "./dispatch.ts";
import { clip, JOB_REPORT_ENTRY, JOB_REQUEST_PREFIX, JobDone, jobReport, Jobs, type JobHub, type JobRecord, type JobsState } from "./jobs.ts";
import { managedDispatch } from "./repair.ts";
import { createLeadTool, LEAD_TOOL } from "./lead.ts";
import { conversationIdentity, CONVERSATION_POLICY } from "./conversation.ts";
import { createReadResultTool, Results } from "./results.ts";
import { completionRefusal, manualTransitionRefusal, recordReview } from "./task-lifecycle.ts";
import { validateAcceptanceChecks, type AcceptanceCheck } from "./acceptance.ts";
import { validateTaskScope, type TaskScope } from "./scope.ts";
import { createTaskReviewTool } from "./task-review.ts";
import { admit, releaseClaim } from "./resources.ts";
import { RunBudget } from "./dispatch.ts";
import { createTaskRecoveryTool, pendingRecovery, prepareRecovery, type RecoveryRequest } from "./task-recovery.ts";
import { readyTasks } from "./task-readiness.ts";
import { createTaskWorkflow } from "./task-workflow.ts";
import { createIntegrations, type IntegrationHooks } from "./integrations.ts";

export { AgentSessions, estimateCost, RunBudget } from "./dispatch.ts";

export interface AgentAvailability {
	kind: AgentKind;
	label?: string;
	transport?: "api" | "cli";
	command?: string[];
	available: boolean;
	reason?: string;
}

export function detectAgents(config: AppConfig): AgentAvailability[] {
	return Object.keys(config.agents).map((kind): AgentAvailability => {
		const agent = config.agents[kind];
		const identity = { kind, label: agentAdapter(kind, agent).label, transport: agent.api ? "api" as const : "cli" as const };
		if (!agent.enabled) return { ...identity, available: false, reason: "配置中已禁用" };
		// API 成员：不需要 CLI，看模型和密钥
		if (agent.api) {
			const a = memberAvailability(agent);
			return { ...identity, command: [], available: a.available, reason: a.reason };
		}
		const command = resolveCommand(kind, agent);
		if (!command) return { ...identity, available: false, reason: "本机未安装（未找到 CLI）" };
		return { ...identity, command, available: true };
	});
}

const TIER_LABEL = { economy: "经济", standard: "标准", premium: "强力" } as const;

function text(message: string) {
	return { output: [{ type: "text" as const, text: message }], isError: true };
}

/** 工具调用提供的持久化能力 */
function toolIO(api: any, context: any): DispatchIO {
	return {
		callId: api.callId,
		taskId: String(api.taskId),
		conversationId: api.conversationId,
		signal: context.abortSignal,
		now: () => api.now(),
		commit: (change) => api.commit(change, BACKGROUND_CONTEXT),
		memo: (name, candidate) => (candidate === undefined ? api.memo(name, context) : api.memo(name, candidate, context)),
		output: (chunk) => api.output(chunk),
		details: (value) => api.details(value, context),
	};
}

type JobInput = { job: string; kind: AgentKind; callId: string; args: DispatchArgs };

/** 后台派工任务：在 Pi Durable 里作为后台任务运行，做完后把结果交给总调度 */
function createJobTask(deps: DispatchDeps, commands: Map<AgentKind, string[]>, onSettled?: (controller: ConversationId) => Promise<void>) {
	const { hub, changes } = deps;
	/** 后台任务提供的持久化能力 */
	const jobIO = (runtime: any, context: Context, input: JobInput, signal: AbortSignal): DispatchIO => ({
		callId: input.callId,
		taskId: String(runtime.taskId),
		conversationId: runtime.conversationId,
		signal,
		now: () => runtime.now(),
		commit: async (change) => {
			let out: any;
			await runtime.commit(async (tx: any) => {
				out = await change(tx);
				return undefined;
			}, context);
			return out;
		},
		memo: (name, candidate) => (candidate === undefined ? runtime.memo(name, context) : runtime.memo(name, candidate, context)),
		output: (chunk) => hub.output(input.job, chunk),
		details: async (value) => {
			await runtime.commit(async (tx: any) => {
				const job = ((await tx.doc(Jobs)) as JobsState).jobs[input.job];
				if (!job) return undefined;
				if (typeof value.changeId === "string") job.changeId = value.changeId;
				if (typeof value.model === "string") job.model = value.model;
				if (typeof value.sessionId === "string") job.sessionId = value.sessionId;
				return undefined;
			}, context);
			hub.changed();
		},
	});

	return defineTask<JobInput, { phase: "run" }, { job: string; status: string }>({
		name: "pi-agent.job",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const input = task.input;
				const command = commands.get(input.kind);
				const cancel = hub.register(input.job);
				const signal = AbortSignal.any([runtime.signal, cancel]);
				const io = jobIO(runtime, context, input, signal);
				const stored = await runtime.snapshot(Results, runtime.conversationId, `dispatch:${runtime.taskId}`, context);
				const receipt = stored?.result?.dispatch;
				const admission = receipt ? { state: "ready" as const } : await io.commit(async (tx) => { const budget = await tx.doc(RunBudget); return admit(tx, deps.config, { id: String(runtime.taskId), member: input.kind, runKey: budget.runKey, spent: budget.spent, at: runtime.now() }); });
				if (admission.state === "queued" && !signal.aborted) { hub.output(input.job, admission.reason + "\n"); await runtime.sleepUntil(runtime.now() + 250, { phase: "run" }, context); hub.release(input.job); return; }
				let result: Awaited<ReturnType<typeof runDispatch>>;
				let cancelledBy: "user" | "orchestrator" | undefined;
				try {
					result = signal.aborted ? { text: "后台派工在执行前已取消，未启动成员。", isError: true, aborted: true } : admission.state === "budget" ? { text: admission.reason!, isError: true } : command
						? await managedDispatch(input.kind, command, deps, input.args, io, `后台派工 ${input.job}`)
						: { text: `${input.kind} 现在不可用（没有找到 CLI 或已禁用）。`, isError: true };
				} catch (error) {
					// 进程关闭或被 Pi Durable 中止：交给重启后的续接 / abort 收尾
					if (runtime.signal.aborted) return;
					result = { text: `后台派工出错：${error instanceof Error ? error.message : String(error)}`, isError: true };
				} finally {
					cancelledBy = hub.release(input.job);
				}
				if (runtime.signal.aborted) return;

				const status: JobRecord["status"] = result.aborted ? "cancelled" : result.isError ? "failed" : "done";
				const conversation = await runtime.conversation(runtime.conversationId, context);
				await runtime.commit(async (tx) => {
					const doc = (await tx.doc(Jobs)) as JobsState;
					await releaseClaim(tx, String(runtime.taskId));
					const boardTask = input.args.task_id ? (await tx.doc(Board)).tasks[input.args.task_id] : undefined;
					if (boardTask?.activeDispatch === input.callId) {
						boardTask.status = result.aborted ? "todo" : "blocked"; delete boardTask.activeDispatch;
						boardTask.notes.push(`派工未产生成功回执：${result.text.slice(0, 1500)}`); boardTask.updatedAt = runtime.now();
					}
					const recovery = boardTask ? pendingRecovery(boardTask) : undefined;
					if (recovery?.callId === input.callId) { recovery.status = "finished"; if (boardTask && !recovery.resultId) { boardTask.status = result.aborted ? "todo" : "blocked"; boardTask.notes.push(result.text.slice(0, 1500)); } }
					const current = doc.jobs[input.job];
					if (!current) return { status: "terminal", outcome: { status: "completed", result: { job: input.job, status } } };
					const s = result.summary;
					const next: JobRecord = defined({
						...current,
						status,
						endedAt: runtime.now(),
						durationMs: s?.durationMs ?? runtime.now() - current.startedAt,
						result: s?.body || result.text,
						isError: result.isError,
						sessionId: s?.sessionId ?? current.sessionId,
						changeId: s?.changeId ?? current.changeId,
						model: s?.model ?? current.model,
						costUsd: s?.costUsd,
						costEstimated: s?.costEstimated || undefined,
						cancelledBy: status === "cancelled" ? (cancelledBy ?? "user") : undefined,
						waiter: undefined,
					}) as JobRecord;
					// 交付结果：有 wait_jobs 在等就叫醒它；否则作为一条消息发回总调度（总调度自己取消的不发）
					const waiter = current.waiter;
					const waiterTask = waiter ? await tx.task(Number(waiter.task) as any) : undefined;
					if (waiter && waiterTask && waiterTask.state.status !== "terminal" && waiterTask.state.status !== "completing") {
						await tx.signal(Number(waiter.task) as any, JobDone, waiter.key, { id: input.job });
					} else if (current.workflow) {
						next.delivered = "workflow";
					} else if (!(status === "cancelled" && next.cancelledBy === "orchestrator") && conversation) {
						await conversation.submit(tx, {
							type: "input",
							content: `${jobReport(next)}\n\n（这是后台派工的结果，由系统自动发来，不是用户的新要求。请验收、更新分工表，继续推进依赖它的任务；全部结束后再向用户汇报。）`,
							whenBusy: "steer",
							onAbort: "keep",
							requestId: `${JOB_REQUEST_PREFIX}${input.job}`,
							entry: { kind: JOB_REPORT_ENTRY, data: { job: input.job, agent: input.kind, status } },
						});
						next.delivered = "report";
					}
					doc.jobs[input.job] = next;
					return { status: "terminal", outcome: { status: "completed", result: { job: input.job, status } } };
				}, context);
				if (!hub.closing) await onSettled?.(runtime.conversationId);
				hub.changed();
			},
		},
		// 被 Pi Durable 中止（比如 /abort all 连后台一起停）：提交已有改动，任务退回待办，不再发消息
		abort: async (task, runtime, context) => {
			const input = task.input;
			const io = jobIO(runtime, context, input, new AbortController().signal);
			const job = await io.commit(async (tx) => {
				const j = ((await tx.doc(Jobs)) as JobsState).jobs[input.job];
				return j ? (JSON.parse(JSON.stringify(j)) as JobRecord) : undefined;
			});
			const change = job?.changeId ? changes.get(job.changeId) : undefined;
			const finished = change?.status === "running" ? await finishChange(deps, change, input.kind, job?.model, input.args.task) : change;
			await runtime.commit(async (tx) => {
				const doc = (await tx.doc(Jobs)) as JobsState;
				const current = doc.jobs[input.job];
				await releaseClaim(tx, String(runtime.taskId));
				const resultId = `dispatch:${runtime.taskId}`;
				const report = await tx.doc(Results, runtime.conversationId, resultId, null);
				const board = await tx.doc(Board);
				const task = input.args.task_id ? board.tasks[input.args.task_id] : undefined;
				const recovery = task ? pendingRecovery(task) : undefined; if (recovery?.callId === input.callId) { recovery.status = "finished"; recovery.resultId = resultId; }
				if (!report.result) {
					report.result = { id: resultId, member: input.kind, conversationId: job?.sessionId ?? "", submissionId: null, taskId: String(runtime.taskId), status: "unanswered", text: "后台派工被中止，结果和已有工作保留；外部写操作须先核对远端状态。", createdAt: runtime.now() };
					if (task && (!task.activeDispatch || task.activeDispatch === input.callId)) {
						task.status = "todo"; task.latestResult = resultId; delete task.activeDispatch; delete task.review; delete task.verification;
						if (finished?.files.length && !task.changes.includes(finished.id)) task.changes.push(finished.id);
						task.notes.push("后台派工被中止，保留结果并退回待办"); task.updatedAt = runtime.now(); board.updatedAt = runtime.now();
					}
				}
				if (current && current.status === "running") {
					doc.jobs[input.job] = defined({ ...current, status: "cancelled", cancelledBy: current.cancelledBy ?? "user", endedAt: runtime.now(), waiter: undefined }) as JobRecord;
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
			const board = await runtime.snapshot(Board, context);
			if (board) { try { deps.project.writeAssign(board as BoardState); } catch { hub.output(input.job, "分工已保存，文件导出暂时失败。\n"); } }
			hub.changed();
		},
	});
}

async function enqueueJob(tx: Tx, jobTask: ReturnType<typeof createJobTask>, controller: ConversationId, callId: string, kind: string, args: DispatchArgs, model: string | undefined, at: number): Promise<JobRecord> {
	const doc = await tx.doc(Jobs), existing = doc.byCall[callId];
	if (existing && doc.jobs[existing]) return JSON.parse(JSON.stringify(doc.jobs[existing])) as JobRecord;
	const task = args.task_id ? (await tx.doc(Board)).tasks[args.task_id] : undefined, recovery = task ? pendingRecovery(task) : undefined;
	if (recovery) {
		if (recovery.id !== args.recovery_id || recovery.member !== kind || (recovery.callId && recovery.callId !== callId)) throw new Error("恢复计划已被其他派工占用。");
		recovery.status = "running"; recovery.callId = callId;
	}
	const id = `J${doc.nextId++}`;
	const piTask = await tx.createTask(jobTask, { job: id, kind, callId, args: defined(args) } as JobInput, { ownership: { kind: "conversation" }, conversationId: controller, background: true });
	const record = defined({ id, agent: kind, callId, piTask: String(piTask), conversation: String(controller), task: args.task, taskId: args.task_id, model, resume: args.session_id, basedOn: args.based_on, status: "running", startedAt: at }) as JobRecord;
	doc.jobs[id] = record; doc.byCall[callId] = id; return JSON.parse(JSON.stringify(record)) as JobRecord;
}

function createAgentTool(kind: AgentKind, command: string[], deps: DispatchDeps, jobTask: ReturnType<typeof createJobTask>) {
	const { config } = deps;
	const adapter = agentAdapter(kind, config.agents[kind]);
	const agent = config.agents[kind];
	const models = agent.models;
	const resumeHint = adapter.canResume
		? "返回结果末尾会带上 session_id；想让它在同一上下文里继续（追问、修改），下次调用时传入这个 session_id。"
		: "这个 agent 不支持续接会话，每次调用都是全新上下文，请把必要背景写进 task。";
	const modelHint = models.length
		? `可选 model：${models.map((m) => `${m.id}（${TIER_LABEL[m.tier]}${m.note ? `，${m.note}` : ""}）`).join("；")}。不传则用 ${agent.defaultModel ?? "CLI 默认"}。`
		: "";

	return defineTool({
		name: `ask_${kind}`,
		description:
			`把一个任务交给成员 ${adapter.label} 去完成。${agent.description}\n` +
			(agent.workspace === "none" ? "这是独立会话的领域 Agent，只能使用配置中明确授予的工具，不创建 Git 改动。" : "这是编码成员，按配置使用工作目录、工具和代码隔离流程。") +
			"task 要写清楚目标、范围、必要资料和验收标准。" +
			"续接会话时会自动回到会话当初的目录，不必再传 cwd。" +
			"background: true 时放到后台执行、立刻返回后台编号（Jn），结果之后自动发回或用 wait_jobs 收取；不传则等它做完再返回结果。" +
			resumeHint +
			modelHint,
		parameters: obj({
			task: str({ description: "交给它的完整任务说明" }),
			cwd: opt(str({ description: "工作目录，默认是项目的 workdir" })),
			...(models.length ? { model: opt(str({ description: `用哪个模型：${models.map((m) => m.id).join(" / ")}` })) } : {}),
			based_on: opt(str({ description: "在某次改动（改动编号）的基础上开工，比如审查或接着修改另一个成员刚做的改动" })),
			task_id: opt(str({ description: "这次派工对应分工表里的哪项任务（如 T3）；会把目标和任务上下文一起交给成员，并更新任务状态" })),
			recovery_id: opt(str({ description: "recover_task 返回的恢复计划 ID；沿用其 session_id/based_on" })),
			context_mode: opt(oneOf(["auto", "full"], { description: "auto 续接只传变更和必要任务约束；full 重发相关项目上下文" })),
			inputs: opt(arr(obj({ result_id: str(), field: opt(str({ description: "结构化字段，如 data.total 或 evidence；不填交接原文" })), offset: opt(num({ minimum: 0 })), limit: opt(num({ minimum: 1, maximum: 8000 })) }), { maxItems: 8, description: "显式交接已成功的成员结果片段；保留来源，不复制完整聊天" })),
			structured: opt(bool({ description: "要求 lemma.delivery.v1 JSON 交付：conclusion、data、evidence、artifacts、incomplete" })),
			background: opt(bool({ description: "放到后台执行，不等结果（耗时长、可以和别的工作并行的任务用）" })),
			...(adapter.canResume ? { session_id: opt(str({ description: "续接之前的会话（之前返回的 session_id）" })) } : {}),
		}),
		// 崩溃重启后允许重新执行：靠记下来的会话 ID 和 worktree 续接，而不是从头再跑
		replay: "safe",
		execute: async (raw: DispatchArgs & { background?: boolean }, api, context) => {
			const { background, ...args } = raw;
			const io = toolIO(api, context);
			if (!background) {
				const stored = (await api.snapshot(Results, api.conversationId, `dispatch:${api.taskId}`, context))?.result?.dispatch;
				if (stored) { const result = await managedDispatch(kind, command, deps, args, io); return { output: [{ type: "text", text: result.text }], isError: result.isError, ...(result.details ? { details: result.details } : {}) }; }
				const over = await checkBudget(io, config);
				if (over) return text(over);
				const invalid = await validateDispatch(kind, deps, args, io); if (invalid) return text(invalid);
				const admission = await io.commit(async (tx) => { const budget = await tx.doc(RunBudget); return admit(tx, config, { id: String(api.taskId), member: kind, runKey: budget.runKey, spent: budget.spent, at: api.now() }); });
				if (admission.state === "queued") { api.output(admission.reason + "\n"); return { sleep: { until: api.now() + 250 } } as any; }
				if (admission.state === "budget") return text(admission.reason!);
				const r = await managedDispatch(kind, command, deps, args, io);
				return { output: [{ type: "text", text: r.text }], isError: r.isError, ...(r.details ? { details: r.details } : {}) };
			}

			// ---- 后台派工：先把能查的错误报出来，再建后台任务，立刻返回 ----
			const invalid = await validateDispatch(kind, deps, args, io);
			if (invalid) return text(invalid);
			const over = await checkBudget(io, config);
			if (over) return text(over);
			const model = args.model ?? agent.defaultModel;
			const job = await api.commit((tx) => enqueueJob(tx, jobTask, api.conversationId, api.callId, kind, args, model, api.now()), context);
			deps.hub.changed();
			api.output(`⇢ 已在后台开工 ${job.id}\n`);
			return {
				output: [
					{
						type: "text",
						text:
							`已在后台开工 ${job.id}：${adapter.label}${model ? `（模型 ${model}）` : ""}${args.task_id ? `，任务 ${args.task_id}` : ""}${args.session_id ? `，续接会话 ${args.session_id}` : ""}。\n` +
							`结果出来后会自动发给你（以【后台结果 ${job.id}】开头）。这期间可以继续派不依赖它的任务；需要它的结果才能往下走时，调用 wait_jobs。`,
					},
				],
				details: defined({ agent: kind, job: job.id, background: true, model: model ?? null, taskId: args.task_id ?? null }) as JsonObject,
			};
		},
	});
}

/** 后台派工的等待和取消 */
function createJobTools(hub: JobHub) {
	const waitJobs = defineTool<any, JsonObject, { round: number; deadline: number; ids: string[] }>({
		name: "wait_jobs",
		description:
			"等后台派工（Jn）的结果：mode any（默认）是有一个做完就返回，all 是全部做完才返回。不传 ids 就等所有还在进行的后台派工。" +
			"等待期间不占用任何资源；已经自动发回过的结果不会重复给全文。",
		parameters: obj({
			ids: opt(arr(str(), { description: "要等的后台编号，如 [\"J1\",\"J3\"]" })),
			mode: opt(oneOf(["any", "all"])),
			timeout_minutes: opt(num({ description: "最多等多久（分钟），默认 30" })),
		}),
		replay: "safe",
		execute: async (args: { ids?: string[]; mode?: "any" | "all"; timeout_minutes?: number }, api, context) => {
			const mode = args.mode ?? "any";
			const round = api.checkpoint ? api.checkpoint.round + 1 : 0;
			const deadline = api.checkpoint?.deadline ?? api.now() + Math.max(0.1, args.timeout_minutes ?? 30) * 60_000;
			const expired = api.now() >= deadline;
			const state = await api.commit(async (tx) => {
				const doc = (await tx.doc(Jobs)) as JobsState;
				const ids = api.checkpoint?.ids ?? (args.ids?.length ? args.ids : Object.values(doc.jobs).filter((j) => j.status === "running").map((j) => j.id));
				const unknown = ids.filter((id) => !doc.jobs[id]);
				if (unknown.length) return { kind: "error" as const, message: `没有后台派工 ${unknown.join("、")}。` };
				if (!ids.length) return { kind: "none" as const };
				const running = ids.filter((id) => doc.jobs[id]!.status === "running");
				const fresh = ids.filter((id) => doc.jobs[id]!.status !== "running" && !doc.jobs[id]!.delivered);
				const ready = mode === "any" ? fresh.length > 0 || running.length === 0 : running.length === 0;
				if (ready || expired) {
					const jobs = ids.map((id) => JSON.parse(JSON.stringify(doc.jobs[id])) as JobRecord);
					for (const id of ids) {
						const j = doc.jobs[id]!;
						if (j.waiter?.task === String(api.taskId)) delete j.waiter;
						if (j.status !== "running" && !j.delivered) j.delivered = "wait";
					}
					return { kind: "done" as const, jobs, expired: expired && !ready };
				}
				for (const id of running) doc.jobs[id]!.waiter = { task: String(api.taskId), key: `${id}.${round}` };
				return { kind: "wait" as const, ids, running };
			}, context);
			if (state.kind === "error") return text(state.message);
			if (state.kind === "none") return { output: [{ type: "text", text: "现在没有进行中的后台派工。" }] };
			if (state.kind === "wait") {
				await api.details({ waiting: state.running }, context);
				return { sleep: { signals: state.running.map((id) => JobDone.key(`${id}.${round}`)), until: deadline, checkpoint: { round, deadline, ids: state.ids } } } as any;
			}
			const blocks = state.jobs.map((j) => {
				if (j.delivered === "workflow") return `【后台结果 ${j.id}】已由 Durable 协作流程处理；/tasks 或 ready_tasks 查看任务与复核状态。`;
				if (j.status === "running") return `【${j.id} · 进行中】${j.agent}${j.taskId ? ` · 任务 ${j.taskId}` : ""}：${clip(j.task, 60)}`;
				if (j.delivered === "report") return `【后台结果 ${j.id}】已经自动发给过你（见前面的消息），这里不重复全文。`;
				return jobReport(j);
			});
			const running = state.jobs.filter((j) => j.status === "running").map((j) => j.id);
			const footer = state.expired
				? `\n\n等待超时，${running.join("、")} 还在进行。可以先汇报进度，或再次 wait_jobs。`
				: running.length
					? `\n\n还在进行：${running.join("、")}。`
					: "\n\n这些后台派工都结束了。";
			return { output: [{ type: "text", text: blocks.join("\n\n———\n\n") + footer }], details: { jobs: state.jobs.map((j) => j.id) } };
		},
		// 等待中被中止（比如用户 /abort）：撤掉登记，之后做完的结果改为自动发回
		cancel: async (_args, api, context) => {
			await api.commit(async (tx) => {
				const doc = (await tx.doc(Jobs)) as JobsState;
				for (const j of Object.values(doc.jobs)) if (j.waiter?.task === String(api.taskId)) delete j.waiter;
			}, context);
		},
	});

	const cancelJob = defineTool({
		name: "cancel_job",
		description: "取消一个还在进行的后台派工（比如方向错了、不再需要）。已有的改动会保留在它的分支里，对应任务退回待办。",
		parameters: obj({ id: str({ description: "后台编号，如 J2" }) }),
		replay: "safe",
		execute: async (args: { id: string }, _api, context) => {
			const r = await hub.cancel(args.id, "orchestrator", context);
			if (r === "not_found") return text(`没有后台派工 ${args.id}。`);
			if (r === "not_running") return { output: [{ type: "text", text: `${args.id} 已经结束了，不用取消。` }] };
			return { output: [{ type: "text", text: `已取消 ${args.id}。` }] };
		},
	});
	return [waitJobs, cancelJob];
}

const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked", "dropped"] as const;

/** 总调度维护分工表的工具：拆任务、改状态、起草目标 */
function createBoardTools(config: AppConfig, project: ProjectFiles, changes: ChangeStore) {
	const roleNames = config.roles.map((r) => r.name);
	const planTasks = defineTool({
		name: "plan_tasks",
		description:
			"把项目拆成任务，写进分工表（.pi-agent/ASSIGN.md 会自动更新）。每项写清楚标题、验收标准、角色和依赖。" +
			"deps 写已有任务编号（如 T2），或写 +序号 指本次新增的第几项（+1 是第一项）。" +
			(roleNames.length ? `角色可选：${roleNames.join("、")}。` : ""),
		parameters: obj({
			tasks: arr(
				obj({
					title: str({ description: "任务标题，一句话" }),
					acceptance: opt(str({ description: "验收标准：做到什么程度算完成，尽量可检验（比如测试通过、接口可调用）" })),
					checks: opt(arr(obj({ name: str(), kind: oneOf(["contains", "json_exists", "json_equals"]), path: opt(str()), value: opt(str({ description: "contains 用文本；json_equals 用 JSON 文本" })) }), { maxItems: 20 })),
					role: opt(str({ description: "角色" })),
					owner: opt(str({ description: "指定成员：claude / codex / gemini；不填按角色" })),
					automation: opt(obj({ member: str(), model: opt(str()), maxReworks: opt(num({ minimum: 0, maximum: 3 })) }, { description: "明确授权依赖就绪后自动派发；maxReworks 限制独立复核后的自动返工，默认 0" })),
					reviewer: opt(obj({ member: str(), model: opt(str()), blind: opt(bool({ description: "代码盲审模式：为 true 时不向复核员传递执行者的自述文本，仅基于需求与 git_diff 客观代码变更做盲审，消除迎合偏见" })) }, { description: "交付后自动派给另一独立成员复核；首次派工后锁定" })),
					scope: opt(obj({ allow: opt(arr(str(), { minItems: 1, maxItems: 16, description: "仅允许修改的相对路径前缀或文件" })), forbid: opt(arr(str(), { minItems: 1, maxItems: 16, description: "禁止修改的相对路径前缀或文件（如契约文件或测试目录）" })) }, { description: "任务级代码路径契约（硬性边界，首次派工后锁定）" })),
					deps: opt(arr(str(), { description: "依赖的任务" })),
					detail: opt(str({ description: "补充说明" })),
					parent: opt(str({ description: "属于哪项上级任务（子调度拆子任务时传它负责的任务编号）" })),
				}),
			),
		}),
		replay: "safe",
		execute: async (args: { tasks: { title: string; acceptance?: string; checks?: AcceptanceCheck[]; role?: string; owner?: string; automation?: { member: string; model?: string; maxReworks?: number }; reviewer?: { member: string; model?: string; blind?: boolean }; scope?: TaskScope; deps?: string[]; detail?: string; parent?: string }[] }, api, context) => {
			for (const task of args.tasks) {
				validateAcceptanceChecks(task.checks ?? []);
				validateTaskScope(task.scope);
				for (const policy of [task.automation, task.reviewer]) if (policy) {
					const member = config.agents[policy.member];
					if (!member?.enabled || policy.model && !member.models.some((model) => model.id === policy.model) && policy.model !== member.defaultModel) throw new Error("自动执行或复核成员未启用，或指定模型不在清单中。");
				}
				if (task.automation && (!Number.isInteger(task.automation.maxReworks ?? 0) || (task.automation.maxReworks ?? 0) < 0 || (task.automation.maxReworks ?? 0) > 3)) throw new Error("maxReworks 必须为 0–3 的整数。");
				if (task.reviewer && task.reviewer.member === (task.automation?.member ?? task.owner)) throw new Error("执行成员与独立复核成员不能相同。");
			}
			const { result } = await commitBoard(project, toolIO(api, context), (b) => {
				// 同一次调用重放时不重复建任务
				const done = (b as any).calls?.[api.callId] as string[] | undefined;
				if (done) return done;
				const ids = args.tasks.map((_, index) => `T${b.nextId + index}`);
				const dependencies = args.tasks.map((task) => [...new Set((task.deps ?? []).map((id) => /^\+\d+$/.test(id) ? ids[Number(id.slice(1)) - 1] ?? "" : id))]);
				const graph = new Map(Object.values(b.tasks).map((task) => [task.id, task.deps]));
				for (const [index, deps] of dependencies.entries()) {
					if (deps.some((id) => !id || id === ids[index] || (!ids.includes(id) && !b.tasks[id]))) throw new Error("任务依赖不存在、引用自己或新增序号无效，未创建任务。");
					graph.set(ids[index]!, deps);
				}
				const visiting = new Set<string>(), visited = new Set<string>();
				const visit = (id: string): void => { if (visiting.has(id)) throw new Error("任务依赖存在循环，未创建任务。"); if (visited.has(id)) return; visiting.add(id); for (const dependency of graph.get(id) ?? []) visit(dependency); visiting.delete(id); visited.add(id); };
				for (const id of ids) visit(id);
				b.nextId += ids.length;
				for (const [index, t] of args.tasks.entries()) {
					const id = ids[index]!, deps = dependencies[index]!;
					b.tasks[id] = defined({
						id,
						controllerId: String(api.conversationId),
						automation: t.automation ? defined({ ...t.automation, maxReworks: t.automation.maxReworks ?? 0 }) : undefined,
						reviewer: t.reviewer ? defined(t.reviewer) : undefined,
						scope: t.scope && (t.scope.allow?.length || t.scope.forbid?.length) ? defined(t.scope) : undefined,
						title: t.title,
						detail: t.detail,
						role: t.role,
						owner: t.owner,
						status: "todo" as TaskStatus,
						deps,
						parent: t.parent,
						acceptance: t.acceptance,
						checks: t.checks,
						notes: [],
						dispatches: [],
						changes: [],
						createdAt: api.now(),
						updatedAt: api.now(),
					}) as BoardTask;
					b.order.push(id);
				}
				(b as any).calls ??= {}; (b as any).calls[api.callId] = ids;
				return ids;
			});
			const board = await api.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Board))) as BoardState, context);
			const unknownRoles = args.tasks.map((t) => t.role).filter((r) => r && roleNames.length && !roleNames.includes(r));
			return {
				output: [
					{
						type: "text",
						text:
							`已写入分工表：${result.map((id) => `${id} ${board.tasks[id]?.title ?? ""}`).join("；")}。\n` +
							(unknownRoles.length ? `注意：角色 ${[...new Set(unknownRoles)].join("、")} 不在配置里。\n` : "") +
							`当前分工：\n${boardSummary(board)}\n派工时传 task_id。`,
					},
				],
			};
		},
	});

	const updateTask = defineTool({
		name: "update_task",
		description: "更新分工表里的一项任务：标完成（done）、打回（todo，写明原因）、受阻（blocked）、取消（dropped），改负责人或补充记录。",
		parameters: obj({
			id: str({ description: "任务编号，如 T3" }),
			status: opt(oneOf([...TASK_STATUSES])),
			owner: opt(str()),
			role: opt(str()),
			title: opt(str()),
			acceptance: opt(str()),
			note: opt(str({ description: "记录：验收结论、打回原因、决定等" })),
		}),
		replay: "safe",
		execute: async (args: { id: string; status?: TaskStatus; owner?: string; role?: string; title?: string; acceptance?: string; note?: string }, api, context) => {
			const { result, board } = await commitBoard(project, toolIO(api, context), async (b, tx) => {
				const t = b.tasks[args.id];
				if (!t) return false;
				if (t.controllerId && t.controllerId !== String(api.conversationId)) return "不能跨总控修改任务。";
				if (t.checksByMember?.some((check) => check.status === "running") && args.status && !["blocked", "dropped"].includes(args.status)) return "独立复核正在进行，等待结论或明确标为受阻/取消。";
				if (pendingRecovery(t) && (args.status || args.owner || args.acceptance || args.title)) return "任务已有恢复计划，请执行或 /task cancel 取消后再调整。";
				if (args.acceptance !== undefined && args.acceptance !== t.acceptance && t.dispatches.length) return "首次派工后验收标准已锁定；请保留失败证据，需求变化时新建任务。";
				if (args.status === "done" && t.checks?.length && t.status !== "done") return "该任务配置了机器验收规则，请使用 review_task 对最新结果验收，不能直接标完成。";
				const invalid = manualTransitionRefusal(t, args.status, args.note); if (invalid) return invalid;
				if (args.status === "done") {
					const report = t.latestResult ? (await tx.doc(Results, api.conversationId, t.latestResult, null)).result : null;
					const refusal = completionRefusal(b, t, report, args.note ?? "", config, changes); if (refusal) return refusal;
					recordReview(t, report!, "accept", args.note!, api.now());
				}
				Object.assign(t, defined({ status: args.status, owner: args.owner, role: args.role, title: args.title, acceptance: args.acceptance }));
				const note = args.note ? `${new Date(api.now()).toLocaleString("zh-CN", { hour12: false })} 总调度：${args.status ? `[${STATUS_LABEL[args.status]}] ` : ""}${args.note}` : undefined;
				if (note && t.notes.at(-1) !== note) t.notes.push(note);
				t.updatedAt = api.now();
				return true;
			});
			if (!result) return { output: [{ type: "text", text: `分工表里没有任务 ${args.id}。` }], isError: true };
			if (typeof result === "string") return text(result);
			return { output: [{ type: "text", text: `已更新 ${args.id}。当前分工：\n${boardSummary(board)}` }] };
		},
	});

	const setGoal = defineTool({
		name: "set_goal",
		description:
			"起草项目的最终目标（.pi-agent/GOAL.md）：要做成什么、验收标准、约束和不做什么。只在还没有 GOAL.md、用户明确要求开展项目且给出具体目标时使用；问候、身份确认、使用咨询或仅说想做项目时不用此工具。" +
			"GOAL.md 以用户写的为准，已经存在时不要改，除非用户明确要求（overwrite: true）。",
		parameters: obj({
			content: str({ description: "GOAL.md 的 Markdown 内容" }),
			overwrite: opt(bool()),
		}),
		replay: "safe",
		execute: async (args: { content: string; overwrite?: boolean }) => {
			const r = project.writeGoal(args.content, args.overwrite === true);
			return { output: [{ type: "text", text: r.ok ? `${r.message}。告诉用户：目标是你起草的，请他确认或修改。` : r.message }], isError: !r.ok };
		},
	});
	const ready = defineTool({ name: "ready_tasks", description: "读取当前总控的就绪队列、依赖等待原因与已验收结果引用，不调用成员。自动执行只对 plan_tasks 中显式声明 automation 的任务启用。", parameters: obj({}), replay: "safe", execute: async (_args, api, context) => {
		const board = await api.snapshot(Board, context);
		return { output: [{ type: "text" as const, text: JSON.stringify(board ? readyTasks(board, String(api.conversationId)) : []) }] };
	} });
	return [planTasks, updateTask, setGoal, ready];
}

export function createLocalAgentsExtension(
	config: AppConfig,
	changes: ChangeStore,
	project: ProjectFiles,
	hub: JobHub,
): { extension: Extension; agents: AgentAvailability[]; memberExtensions: Extension[]; integrations: ReturnType<typeof createIntegrations>; ensureWorkflow(tx: Tx, controller: ConversationId): Promise<void>; recover(controller: ConversationId, args: RecoveryRequest, key: string, context: Context): Promise<JobRecord> } {
	const agents = detectAgents(config);
	// API 成员的工具扩展：只装给它们自己的子对话，总调度看不到
	const memberTools = new Map<AgentKind, Extension>();
	for (const a of agents) {
		const api = config.agents[a.kind].api;
		if (a.available && api) memberTools.set(a.kind, createMemberTools(a.kind, api, { workspace: config.agents[a.kind].workspace ?? "code", changes }));
	}
	const deps: DispatchDeps = { config, changes, project, hub, memberTools };
	const integrationHooks: IntegrationHooks = {};
	const integrations = createIntegrations(deps, integrationHooks);
	deps.integrations = integrations;
	const commands = new Map(agents.filter((a) => a.available).map((a) => [a.kind, a.command!] as const));
	const enqueueInternal = async (tx: Tx, controller: ConversationId, key: string, member: string, args: DispatchArgs, model?: string) => {
		const job = await enqueueJob(tx, jobTask, controller, key, member, args, model, Date.now());
		(await tx.doc(Jobs)).jobs[job.id]!.workflow = true; return job;
	};
	const jobTask = createJobTask(deps, commands, async (controller) => { if (hub.harness) await hub.harness.commit((tx) => workflow.ensure(tx, controller), BACKGROUND_CONTEXT); });
	const availableSet = new Set(commands.keys());
	const workflow = createTaskWorkflow(deps, availableSet, enqueueInternal);
	integrationHooks.available = availableSet;
	integrationHooks.enqueue = enqueueInternal;
	integrationHooks.ensureWorkflow = workflow.ensure;
	const tools = [
		...integrations.tools,
		createReadResultTool(),
		createTaskReviewTool(project, config, changes),
		createTaskRecoveryTool(project, config, changes),
		...agents.filter((a) => a.available).map((a) => createAgentTool(a.kind, a.command!, deps, jobTask)),
		...createJobTools(hub),
		...createBoardTools(config, project, changes),
		// 子调度：只给总调度；子调度自己的对话里会去掉它（只有一层）
		...(config.lead.enabled ? [createLeadTool(deps)] : []),
	];
	const available = new Set(agents.filter((a) => a.available).map((a) => a.kind));
	const roster = agents
		.map((a) => {
			if (!a.available) return `- ${a.kind}: 不可用（${a.reason}）`;
			const c = config.agents[a.kind];
			const models = c.models.length
				? `\n  模型：${c.models.map((m) => `${m.id}［${TIER_LABEL[m.tier]}］${m.note ? ` ${m.note}` : ""}`).join("；")}；默认 ${c.defaultModel ?? "CLI 默认"}`
				: "";
			return `- ${c.name ?? a.kind}（ID: ${a.kind}，${c.api ? "API" : "CLI"}）: 可用，工具 ask_${a.kind}。${c.description}${models}`;
		})
		.join("\n");
	const roles = config.roles
		.map((r) => {
			const chain = [r.agent, ...(r.fallback ?? [])];
			const pick = chain.find((k) => available.has(k));
			return `- ${r.name}：${chain.join(" → ")}${r.model ? `（${r.agent} 用 ${r.model}）` : ""}${r.note ? `，${r.note}` : ""}${pick && pick !== r.agent ? `　※${r.agent} 不可用，现在由 ${pick} 顶上` : ""}${pick ? "" : "　※都不可用"}`;
		})
		.join("\n");
	const limit = config.budget.perRunUsd;
	const hasCodeMembers = agents.some((a) => a.available && config.agents[a.kind].workspace !== "none");

	const extension = defineExtension({
		name: "local-agents",
		tools,
		hooks: [hook(ToolTask, { afterTool: async (call, result, api, context) => {
			if (hub.harness && !hub.closing && (["plan_tasks", "review_task", "update_task", LEAD_TOOL].includes(call.name) || call.name.startsWith("ask_"))) await hub.harness.commit((tx) => workflow.ensure(tx, api.conversationId), BACKGROUND_CONTEXT);
			if (call.name.startsWith("ask_") && hub.harness) await hub.harness.commit((tx) => releaseClaim(tx, String(api.taskId)), BACKGROUND_CONTEXT);
			if (call.name.startsWith("ask_") && !(call.arguments as any).background && hub.harness && !hub.closing) await hub.harness.commit(async (tx) => {
				const id = (call.arguments as any).task_id, task = id ? (await tx.doc(Board)).tasks[id] : undefined, recovery = task ? pendingRecovery(task) : undefined;
				if (recovery?.callId === call.id) recovery.status = "finished";
			}, BACKGROUND_CONTEXT);
			// Aborting a native tool joins its owned children before this hook runs.
			// Its execute() continuation may have been cut off and cannot do cleanup.
			if (!result.isError || (!call.name.startsWith("ask_") && call.name !== LEAD_TOOL) || (call.arguments as any).background || !hub.harness || hub.closing) return;
			const cancelled = result.diagnostics?.some((diagnostic) => ["aborted", "abandoned"].includes(diagnostic.code ?? "")) ?? false;
			const resultId = `${call.name === LEAD_TOOL ? "lead" : "dispatch"}:${api.taskId}`;
			const out = await hub.harness.commit(async (tx) => {
				const board = await tx.doc(Board);
				const taskId = (call.arguments as any).task_id as string | undefined;
				const task = taskId ? board.tasks[taskId] : undefined;
				const owned = task?.activeDispatch === call.id || task?.activeDispatch?.startsWith(`${call.id}:repair:`);
				if (!owned) return null;
				const report = await tx.doc(Results, api.conversationId, resultId, null);
				if (!report.result) report.result = { id: resultId, member: call.name === LEAD_TOOL ? "lead" : call.name.slice(4), conversationId: "", submissionId: null, taskId: String(api.taskId), status: "unanswered", text: cancelled ? "派工已取消，已有结果保留；外部操作需核对远端状态。" : "派工异常终止，已有结果保留，请核对失败证据后重派。", createdAt: api.now() };
				task!.status = cancelled ? "todo" : "blocked"; task!.latestResult = report.result.id; delete task!.activeDispatch; delete task!.review; delete task!.verification;
				const recovery = pendingRecovery(task!); if (recovery?.callId === call.id) { recovery.status = "finished"; recovery.resultId = report.result.id; }
				task!.notes.push(report.result.text); task!.updatedAt = api.now(); board.updatedAt = api.now();
				return JSON.parse(JSON.stringify(board)) as BoardState;
			}, BACKGROUND_CONTEXT);
			if (out) { try { project.writeAssign(out); } catch {} }
		} })],
		tasks: [jobTask, workflow.task, integrations.task],
		sections: [
			section("identity", conversationIdentity),
			section("conversation", () => CONVERSATION_POLICY),
			section(
				"team",
				() =>
					[
						"Lemma 总调度按职责协调团队成员；成员可以通过模型 API 或 CLI 执行。按任务需要交接工作、核对依据和汇总结果，简单任务直接回答。子调度只负责自己的子目标。",
						config.collaboration?.instructions ?? "",
						"",
						"团队成员：",
						roster,
						"",
						...(roles ? ["角色分工（规划任务时给每项定角色，派工时按角色找成员；首选不可用时用后面的）：", roles, ""] : []),
						"工作方式：",
						"1. 先理解用户目标。简单问题直接回答，不必派活，也不必建分工表。",
						"1a. 总控已有足够资料时直接完成；只有明确需要独立工具、专业能力、并行工作或独立核查才派成员。不要为形式分工，也不要为转述结果再开一个成员。",
						"2. 项目级、多步骤的任务：先用 plan_tasks 拆解，每项写清楚验收标准、角色、依赖；然后按依赖顺序派工，互不依赖的任务同时派。",
						"3. 派工时传 task_id：成员会同时拿到项目目标、这项任务和分工全貌，知道自己在全局里的位置。",
						"4. 选模型：按任务难度传 model。简单、机械的活用［经济］，日常开发用［标准］，复杂设计、跨模块改动、疑难问题才用［强力］。不确定就不传，用默认（角色配置里写了模型的优先用它）。",
						"5. 成员完成后任务会变成「待验收」：用 review_task 对最新 result_id 检查、accept、rework 或 block，并写明证据。预设 checks 会对完整结果计算，不通过不能完成；规则只验证格式和显式字段，不证明事实。首次派工后标准锁定，不能降低标准绕过失败。",
						"5a. 跨成员交接使用 ask_* 的 inputs，按 result_id、offset、limit 交付原文片段；保留来源，避免手工转述失真。有依赖的任务必须等前置任务验收完成才能派工。业务工具 POST 失败时可能已在远端生效，先核对状态，不自动重试。",
						"5b. 优先复用同一任务已验收结果及可信证据；结构化交接优先 inputs.field，只送必要字段。资料过期、来源冲突或任务要求独立核查时才重查，并说明原因；不要用未经核验的缓存替代独立审查。",
						"5c. 受阻或被取消后，用 recover_task inspect 查清失败依据；resume 续接原成员、supply 补资料、reassign 换人。按返回的 dispatch 参数调用对应 ask_*，只修失败部分；不重跑已验收前置任务，不降低验收标准。恢复同一任务不要重复 plan_tasks。",
						"5d. ready_tasks 返回系统计算的就绪队列与等待原因。明确授权自动执行时，plan_tasks 为对应任务声明 automation:{member,model?,maxReworks?}；依赖验收通过后 Durable 自动交接结果并派工。未声明不自动执行，不要再对自动执行中的任务重复 ask_*。",
						"5e. 要求独立复核时，plan_tasks 声明 reviewer:{member,model?,blind?}，成员必须不同于执行者。代码任务可设 blind:true 开启盲审（不向复核员传递执行者的主观自述解释，仅审需求契约与 git_diff 客观代码变更，消除迎合偏见）。交付后系统在独立会话复核并绑定 result_id；通过才完成，返工仅在已授权次数内续接原成员，不可绕过复核标 done。",
						"5f. 多个成员代码分支先 integrate_changes changes:[完整改动编号]，read_integration id:集成编号 wait:true 原生挂起等待联合检查；若主目录或来源更新导致过期，传 rerun_id 重验；若出现合并冲突（conflict）或跨模块检查失败（failed），可用 repair_integration 在独立修复副本派编码成员解决并重跑全部检查。自动依赖任务包含多分支时由 Durable 先集成，通过才派下游。集成只改独立副本，最终应用必须用户终端 /apply，模型无权代替确认。",
						"5g. 自适应编码拓扑与路径契约（scope）：单文件低风险任务走 L0（单成员直派）；核心逻辑走 L1（automation + reviewer:{member,blind:true} 异构盲审）；多模块并行或高风险开发走 L2（先建 T1 契约任务冻结接口定义 → 并行派发 T2 功能实现 scope:{allow:['src/'],forbid:['test/']} 与 T3 独立测试 scope:{allow:['test/'],forbid:['src/']} → 下游联合集成测试），用硬性路径边界防止越界改动与篡改测试。",
						"6. 需要在之前的上下文里继续时，传入上次返回的 session_id。同一个成员可以同时开多个会话（多个新派工），各自独立；但同一个会话同一时间只能有一个派工。",
						"6a. 成员结果默认只带限长预览；全文按 result_id 持久保存。缺少证据时用 read_result 分页读取，不能把截断预览当全文。续接只发送变更和必要证据，避免重复复制整段历史。",
						"6b. ask_* 默认自动省略原成员会话里未变化的项目背景与相同交接片段；改了目标/约束会重发。怀疑原会话缺失或用户要求完整核对时用 context_mode=full；不能把少传字符当作真实 token/费用节省结论。",
						...(config.lead.enabled
							? [
									`6b. 子调度（${LEAD_TOOL}）：目标很大、能分成几块相对独立的子目标时（比如前端 / 后端 / 数据），把每块整个交给一个子调度：给出子目标、范围和验收标准，它会自己拆任务、派成员、验收后汇报给你。几个子调度可以在同一轮里并行。小任务直接派成员，不要用子调度。子调度汇报后，你仍要对照验收标准核对。`,
								]
							: []),
						"7. 完成实际派工后，再用中文汇报：有任务编号时按编号说明成员、模型、结果、改动与未完成事项；没有派工的普通对话不套执行汇报模板。",
						...(config.autonomy.enabled && hasCodeMembers ? [
							`代码工作区成员启用配置验收与有限修复，最多修复 ${config.autonomy.maxRepairAttempts} 次。领域成员不执行代码检查或自动代码修复，需要按任务的业务验收标准核对证据。收到“停止重试”时不要再派相同任务。`,
							"不要反复转发完整历史；续接用 session_id，跨成员交接传必要资料，代码改动才使用 based_on。未通过的检查不能通过改测试标准或标 done 绕过。",
						] : []),
						"",
						"同步和异步：",
						"- 不传 background 时，派工会等成员做完才返回；同一轮里的几个派工并行执行，但要等最慢的那个。",
						"- 耗时长、互不依赖的任务用 background: true 放到后台：立刻返回后台编号 Jn，你可以接着派别的、先回复用户。",
						"- 后台结果会以「【后台结果 Jn …】」开头的消息自动发来（不是用户的新要求）：收到后验收、更新分工表、继续派依赖它的任务。",
						"- 需要等结果才能往下走时调用 wait_jobs（mode any：做完一个就返回，先处理它；mode all：全部做完）。不要在同一轮里既开后台派工又调用 wait_jobs。",
						"- 方向错了或不再需要的后台派工用 cancel_job 取消。所有任务都结束后再给用户最终汇报；中途可以简短告知进度。",
						"",
						...(config.isolation.enabled && hasCodeMembers
							? [
									"工作区隔离：",
									"- 仅代码工作区成员在 Git 仓库中创建独立 worktree，改动提交到独立分支，不自动进入主目录；workspace=none 的领域成员不创建代码分支。",
									"- 改动要由用户在终端确认后才合并（/apply 编号）。所以并行派给不同成员的改动互不可见；汇报时列出每个改动编号和改了什么，方便用户决定合并哪些。",
									"- 要让另一个成员审查或接着修改某次改动，调用时传 based_on: 改动编号，它会在那次改动的基础上开工。",
									"- 续接会话（session_id）会回到同一个副本继续改。",
									"",
								]
							: []),
						limit !== null ? `花费上限：一次运行里成员的花费最多 $${limit}（后台结果触发的后续处理也算在这一轮里）。超过后派工会被拒绝，届时直接汇报已有结果。能用便宜模型完成的活不要用贵的。` : "",
						`默认工作目录：${config.workdir}`,
					]
						.filter((l) => l !== undefined)
						.join("\n"),
				{ tag: false },
			),
			// 项目目标 + 分工表 + 后台派工：每次请求都按最新状态渲染（变了这一段才重发，其余部分的提示缓存不受影响）
			section("project", async (input, context) => {
				const goal = project.goal();
				const board = (await input.read.snapshot(Board, context)) as BoardState | undefined;
				const jobs = Object.values(((await input.read.snapshot(Jobs, context)) as JobsState | undefined)?.jobs ?? {});
				const running = jobs.filter((j) => j.status === "running");
				const unread = jobs.filter((j) => j.status !== "running" && !j.delivered);
				return [
					"以下项目状态只供当前话题相关时参考；缺少目标或任务是正常空状态，不是要求你立即创建它们。",
					goal ? `项目最终目标（.pi-agent/GOAL.md，以用户写的为准）：\n${goal}` : "项目目标：尚未设置。仅在用户明确要求开展项目且目标已清楚时，才按需起草；普通对话不要求提供目标。",
					"",
					"当前分工表（.pi-agent/ASSIGN.md 由你通过 plan_tasks / update_task 维护）：",
					boardSummary(board),
					board ? `就绪队列与等待原因（系统计算）：${JSON.stringify(readyTasks(board, String(input.conversationId)))}` : "",
					...(running.length || unread.length
						? [
								"",
								"后台派工：",
								...running.map((j) => `- ${j.id} 进行中 · ${j.agent}${j.taskId ? ` · 任务 ${j.taskId}` : ""} · ${clip(j.task, 50)}`),
								...unread.map((j) => `- ${j.id} 已结束（${j.status === "done" ? "完成" : j.status === "failed" ? "失败" : "已取消"}），结果还没取：用 wait_jobs ids:["${j.id}"] 取`),
							]
						: []),
				].join("\n");
			}),
		],
	});
	return { extension, agents, memberExtensions: [...memberTools.values()], integrations, ensureWorkflow: workflow.ensure, async recover(controller, args, key, context) {
		if (!hub.harness) throw new Error("运行时尚未就绪。");
		const job = await hub.harness.commit(async (tx) => {
			const prepared = await prepareRecovery(tx, controller, config, changes, args, key, Date.now());
			if (!prepared.recovery || !prepared.dispatch) throw new Error("该操作不启动派工。");
			const recovery = prepared.recovery;
			if (!commands.has(recovery.member)) throw new Error("该成员目前不可用，请先 /agents 检查连接。");
			const job = await enqueueJob(tx, jobTask, controller, `recovery:${key}`, recovery.member, prepared.dispatch, prepared.dispatch.model ?? config.agents[recovery.member]!.defaultModel, Date.now());
			const task = (await tx.doc(Board)).tasks[args.id]!; const plan = pendingRecovery(task);
			if (plan && plan.id === recovery.id) { plan.status = "running"; plan.callId = job.callId; }
			return job;
		}, context);
		hub.harness.resume(); hub.changed(); return job;
	} };
}
