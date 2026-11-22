// 把本机 CLI 包装成 Pi Durable 工具：ask_claude / ask_codex / ask_gemini。
// 每次派工可以：由总调度选模型；在独立的 git worktree 里干活（改动等用户在终端确认后才合并）；
// 受单次运行的花费上限约束；同步等结果，或者放到后台（background: true）由 wait_jobs 收结果。
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTask, defineTool, section, type Extension, type JsonObject } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ADAPTERS } from "./agents.ts";
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
	settleTask,
	validateDispatch,
	type DispatchArgs,
	type DispatchDeps,
	type DispatchIO,
} from "./dispatch.ts";
import { clip, JOB_REPORT_ENTRY, JOB_REQUEST_PREFIX, JobDone, jobReport, Jobs, type JobHub, type JobRecord, type JobsState } from "./jobs.ts";
import { managedDispatch } from "./repair.ts";
import { createLeadTool, LEAD_TOOL } from "./lead.ts";
import { conversationIdentity, CONVERSATION_POLICY } from "./conversation.ts";

export { AgentSessions, estimateCost, RunBudget } from "./dispatch.ts";

export interface AgentAvailability {
	kind: AgentKind;
	command?: string[];
	available: boolean;
	reason?: string;
}

export function detectAgents(config: AppConfig): AgentAvailability[] {
	return (Object.keys(ADAPTERS) as AgentKind[]).map((kind) => {
		const agent = config.agents[kind];
		if (!agent.enabled) return { kind, available: false, reason: "配置中已禁用" };
		// API 成员：不需要 CLI，看模型和密钥
		if (agent.api) {
			const a = memberAvailability(agent);
			return { kind, command: [], available: a.available, reason: a.reason };
		}
		const command = resolveCommand(kind, agent);
		if (!command) return { kind, available: false, reason: "本机未安装（未找到 CLI）" };
		return { kind, command, available: true };
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
		commit: (change) => api.commit(change, context),
		memo: (name, candidate) => (candidate === undefined ? api.memo(name, context) : api.memo(name, candidate, context)),
		output: (chunk) => api.output(chunk),
		details: (value) => api.details(value, context),
	};
}

type JobInput = { job: string; kind: AgentKind; callId: string; args: DispatchArgs };

/** 后台派工任务：在 Pi Durable 里作为后台任务运行，做完后把结果交给总调度 */
function createJobTask(deps: DispatchDeps, commands: Map<AgentKind, string[]>) {
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
				let result: Awaited<ReturnType<typeof runDispatch>>;
				let cancelledBy: "user" | "orchestrator" | undefined;
				try {
					result = command
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
					const waiterTask = waiter ? await tx.task(waiter.task as any) : undefined;
					if (waiter && waiterTask && waiterTask.state.status !== "terminal" && waiterTask.state.status !== "completing") {
						await tx.signal(waiter.task as any, JobDone, waiter.key, { id: input.job });
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
			if (job?.taskId) await settleTask(deps, io, input.kind, job.taskId, "todo", finished?.files.length ? finished.id : undefined, "后台派工被中止");
			await runtime.commit(async (tx) => {
				const doc = (await tx.doc(Jobs)) as JobsState;
				const current = doc.jobs[input.job];
				if (current && current.status === "running") {
					doc.jobs[input.job] = defined({ ...current, status: "cancelled", cancelledBy: current.cancelledBy ?? "user", endedAt: runtime.now(), waiter: undefined }) as JobRecord;
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
			hub.changed();
		},
	});
}

function createAgentTool(kind: AgentKind, command: string[], deps: DispatchDeps, jobTask: ReturnType<typeof createJobTask>) {
	const { config } = deps;
	const adapter = ADAPTERS[kind];
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
			`把一个任务交给本机的 ${adapter.label} 去完成。${agent.description}\n` +
			"它是一个完整的编码 agent，能在 cwd 目录里读写文件、执行命令。task 要写清楚目标、范围和期望的输出格式。" +
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
			background: opt(bool({ description: "放到后台执行，不等结果（耗时长、可以和别的工作并行的任务用）" })),
			...(adapter.canResume ? { session_id: opt(str({ description: "续接之前的会话（之前返回的 session_id）" })) } : {}),
		}),
		// 崩溃重启后允许重新执行：靠记下来的会话 ID 和 worktree 续接，而不是从头再跑
		replay: "safe",
		execute: async (raw: DispatchArgs & { background?: boolean }, api, context) => {
			const { background, ...args } = raw;
			const io = toolIO(api, context);
			if (!background) {
				const over = await checkBudget(io, config);
				if (over) return text(over);
				const r = await managedDispatch(kind, command, deps, args, io);
				return { output: [{ type: "text", text: r.text }], isError: r.isError, ...(r.details ? { details: r.details } : {}) };
			}

			// ---- 后台派工：先把能查的错误报出来，再建后台任务，立刻返回 ----
			const invalid = await validateDispatch(kind, deps, args, io);
			if (invalid) return text(invalid);
			const over = await checkBudget(io, config);
			if (over) return text(over);
			const model = args.model ?? agent.defaultModel;
			const job = await api.commit(async (tx) => {
				const doc = (await tx.doc(Jobs)) as JobsState;
				// 同一次调用重放时不重复开工
				const existing = doc.byCall[api.callId];
				if (existing && doc.jobs[existing]) return JSON.parse(JSON.stringify(doc.jobs[existing])) as JobRecord;
				const id = `J${doc.nextId++}`;
				const piTask = await tx.createTask(jobTask, { job: id, kind, callId: api.callId, args: defined(args) } as JobInput, {
					ownership: { kind: "conversation" },
					conversationId: api.conversationId,
					background: true,
				});
				const record = defined({
					id,
					agent: kind,
					callId: api.callId,
					piTask: String(piTask),
					conversation: String(api.conversationId),
					task: args.task,
					taskId: args.task_id,
					model,
					resume: args.session_id,
					basedOn: args.based_on,
					status: "running",
					startedAt: api.now(),
				}) as JobRecord;
				doc.jobs[id] = record;
				doc.byCall[api.callId] = id;
				return JSON.parse(JSON.stringify(record)) as JobRecord;
			}, context);
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
					role: opt(str({ description: "角色" })),
					owner: opt(str({ description: "指定成员：claude / codex / gemini；不填按角色" })),
					deps: opt(arr(str(), { description: "依赖的任务" })),
					detail: opt(str({ description: "补充说明" })),
					parent: opt(str({ description: "属于哪项上级任务（子调度拆子任务时传它负责的任务编号）" })),
				}),
			),
		}),
		replay: "safe",
		execute: async (args: { tasks: { title: string; acceptance?: string; role?: string; owner?: string; deps?: string[]; detail?: string; parent?: string }[] }, api, context) => {
			const { result } = await commitBoard(project, toolIO(api, context), (b) => {
				// 同一次调用重放时不重复建任务
				const done = (b as any).calls?.[api.callId] as string[] | undefined;
				if (done) return done;
				const ids: string[] = [];
				for (const t of args.tasks) {
					const id = `T${b.nextId++}`;
					ids.push(id);
					const deps = (t.deps ?? []).map((d) => (/^\+\d+$/.test(d) ? ids[Number(d.slice(1)) - 1] ?? "" : d)).filter((d) => d && d !== id);
					b.tasks[id] = defined({
						id,
						title: t.title,
						detail: t.detail,
						role: t.role,
						owner: t.owner,
						status: "todo" as TaskStatus,
						deps,
						parent: t.parent,
						acceptance: t.acceptance,
						notes: [],
						dispatches: [],
						changes: [],
						createdAt: api.now(),
						updatedAt: api.now(),
					}) as BoardTask;
					b.order.push(id);
				}
				((b as any).calls ??= {})[api.callId] = ids;
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
			const { result, board } = await commitBoard(project, toolIO(api, context), (b) => {
				const t = b.tasks[args.id];
				if (!t) return false;
				if (args.status === "done" && config.autonomy.enabled && t.changes.some((id) => {
					const change = changes.get(id);
					return change && change.files.length > 0 && config.autonomy.checks.length > 0 && (!change.verification || change.verification.head !== change.head || !change.verification.passed);
				})) return "验收检查尚未通过，不能把任务标为完成。请根据失败证据修复并重新验证。";
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
	return [planTasks, updateTask, setGoal];
}

export function createLocalAgentsExtension(
	config: AppConfig,
	changes: ChangeStore,
	project: ProjectFiles,
	hub: JobHub,
): { extension: Extension; agents: AgentAvailability[]; memberExtensions: Extension[] } {
	const agents = detectAgents(config);
	// API 成员的工具扩展：只装给它们自己的子对话，总调度看不到
	const memberTools = new Map<AgentKind, Extension>();
	for (const a of agents) {
		const api = config.agents[a.kind].api;
		if (a.available && api) memberTools.set(a.kind, createMemberTools(a.kind, api));
	}
	const deps: DispatchDeps = { config, changes, project, hub, memberTools };
	const commands = new Map(agents.filter((a) => a.available).map((a) => [a.kind, a.command!] as const));
	const jobTask = createJobTask(deps, commands);
	const tools = [
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
			return `- ${a.kind}: 可用，工具 ask_${a.kind}。${c.description}${models}`;
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

	const extension = defineExtension({
		name: "local-agents",
		tools,
		tasks: [jobTask],
		sections: [
			section("identity", conversationIdentity),
			section("conversation", () => CONVERSATION_POLICY),
			section(
				"team",
				() =>
					[
						"需要执行项目任务时，Lemma 总调度相当于团队的项目负责人；子调度只负责自己的子目标。你自己不直接改代码，而是按任务需要派给下面这些本机 AI，再核对、汇总结果。普通聊天直接回答。",
						"",
						"团队成员：",
						roster,
						"",
						...(roles ? ["角色分工（规划任务时给每项定角色，派工时按角色找成员；首选不可用时用后面的）：", roles, ""] : []),
						"工作方式：",
						"1. 先理解用户目标。简单问题直接回答，不必派活，也不必建分工表。",
						"2. 项目级、多步骤的任务：先用 plan_tasks 拆解，每项写清楚验收标准、角色、依赖；然后按依赖顺序派工，互不依赖的任务同时派。",
						"3. 派工时传 task_id：成员会同时拿到项目目标、这项任务和分工全貌，知道自己在全局里的位置。",
						"4. 选模型：按任务难度传 model。简单、机械的活用［经济］，日常开发用［标准］，复杂设计、跨模块改动、疑难问题才用［强力］。不确定就不传，用默认（角色配置里写了模型的优先用它）。",
						"5. 成员完成后任务会变成「待验收」：对照验收标准核对（必要时派审查角色），用 update_task 标完成或打回并写明原因。",
						"6. 需要在之前的上下文里继续时，传入上次返回的 session_id。同一个成员可以同时开多个会话（多个新派工），各自独立；但同一个会话同一时间只能有一个派工。",
						...(config.lead.enabled
							? [
									`6b. 子调度（${LEAD_TOOL}）：目标很大、能分成几块相对独立的子目标时（比如前端 / 后端 / 数据），把每块整个交给一个子调度：给出子目标、范围和验收标准，它会自己拆任务、派成员、验收后汇报给你。几个子调度可以在同一轮里并行。小任务直接派成员，不要用子调度。子调度汇报后，你仍要对照验收标准核对。`,
								]
							: []),
						"7. 完成实际派工后，再用中文汇报：有任务编号时按编号说明成员、模型、结果、改动与未完成事项；没有派工的普通对话不套执行汇报模板。",
						...(config.autonomy.enabled ? [
							`自动验收与修复已启用：由执行层运行配置中的检查，失败时最多修复 ${config.autonomy.maxRepairAttempts} 次。收到“停止重试”时不要再派相同任务，汇报失败证据和下一步。`,
							"节省上下文：工具结果已给出结论、验收摘要和改动编号，不要把完整历史反复转给成员；续接用 session_id，跨成员交接用 based_on。未通过的检查不能通过改测试标准或标 done 绕过。",
						] : []),
						"",
						"同步和异步：",
						"- 不传 background 时，派工会等成员做完才返回；同一轮里的几个派工并行执行，但要等最慢的那个。",
						"- 耗时长、互不依赖的任务用 background: true 放到后台：立刻返回后台编号 Jn，你可以接着派别的、先回复用户。",
						"- 后台结果会以「【后台结果 Jn …】」开头的消息自动发来（不是用户的新要求）：收到后验收、更新分工表、继续派依赖它的任务。",
						"- 需要等结果才能往下走时调用 wait_jobs（mode any：做完一个就返回，先处理它；mode all：全部做完）。不要在同一轮里既开后台派工又调用 wait_jobs。",
						"- 方向错了或不再需要的后台派工用 cancel_job 取消。所有任务都结束后再给用户最终汇报；中途可以简短告知进度。",
						"",
						...(config.isolation.enabled
							? [
									"工作区隔离：",
									"- 每次新派工都在一个独立的副本（git worktree）里干活，改动提交到独立分支，**不会自动进入用户的主目录**。结果末尾会写明「改动 #编号」。",
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
	return { extension, agents, memberExtensions: [...memberTools.values()] };
}
