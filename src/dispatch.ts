// 一次派工的完整过程：选模型 → 定工作目录（续接会话回原目录、新会话建隔离 worktree）→ 带上项目目标和任务上下文
// → 调用本机 CLI → 提交改动 → 更新分工表 → 记下会话。
// 同步派工（ask_* 工具直接等结果）和后台派工（Pi Durable 后台任务）共用这里，区别只在 DispatchIO 由谁提供。
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, LiveDoc, type ConversationId, type Extension, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { agentAdapter, type TokenUsage } from "./agents.ts";
import { Board, taskBrief, type BoardState, type ProjectFiles, type TaskStatus } from "./board.ts";
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { cleanEnv, runCli } from "./cli-runner.ts";
import type { AgentKind, AppConfig, ModelOption } from "./config.ts";
import { WORKTREE_CONVENTION_FILES } from "./conventions.ts";
import { addWorktree, commitAll, git, linkIgnoredDirs, numstat, repoRoot, snapshot } from "./git.ts";
import { Learning, relevantLessons } from "./learning.ts";
import { summarizeResult } from "./result-summary.ts";
import { storeResult } from "./results.ts";
import { JOB_REQUEST_PREFIX, type JobHub } from "./jobs.ts";

/** 子调度的提交前缀（和 lead.ts 一致；放在这里避免循环引用） */
const LEAD_PREFIX = "pi-agent:lead:";
import { memberInstructions, runApiMember, type ExecOutcome } from "./api-member.ts";

/** 所有 CLI 会话的登记表：会话 ID → 哪个 agent、在哪个目录建立的、用了几轮。随对话一起持久化。 */
export type SessionRecord = {
	/** 成员上下文所属的总控对话；旧记录缺省时仍按当前存储隔离。 */
	controllerId?: string;
	agent: AgentKind;
	cwd: string;
	updatedAt: number;
	change?: string;
	createdAt?: number;
	rounds?: number;
	lastTask?: string;
	model?: string;
};
export const AgentSessions = defineDoc<{ sessions: Record<string, SessionRecord> }>({
	kind: "pi-agent.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
	checkpointWhen: () => false,
});

/** 当前运行（你的一次输入）已经花了多少：换了一次运行就从零算起（后台结果触发的运行仍算原来那一轮） */
export const RunBudget = defineDoc<{ runKey: string | null; spent: number; dispatches: number; blocked: number }>({
	kind: "pi-agent.budget",
	version: 1,
	scope: "session",
	initial: () => ({ runKey: null, spent: 0, dispatches: 0, blocked: 0 }),
	checkpointWhen: () => false,
});

const RESUME_AFTER_CRASH = "（系统提示：上一次执行在中途被中断了。请检查当前进度，把这个任务做完，然后给出最终结果。）";

export type DispatchArgs = { task: string; cwd?: string; model?: string; based_on?: string; session_id?: string; task_id?: string };

/** 派工过程需要的持久化能力：工具调用和后台任务各自提供 */
export interface DispatchIO {
	/** 记进分工表和改动记录的调用编号 */
	callId: string;
	/** 用来生成 worktree 编号 */
	taskId: string;
	conversationId: ConversationId;
	signal: AbortSignal;
	now(): number;
	commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
	memo<T extends JsonValue>(name: string, candidate?: T): Promise<T | undefined>;
	output(chunk: string): void;
	details(value: JsonObject): Promise<void>;
}

export interface DispatchDeps {
	config: AppConfig;
	changes: ChangeStore;
	project: ProjectFiles;
	hub: JobHub;
	/** API 成员的工具（读写文件 + 白名单 bash），按成员 */
	memberTools?: Map<AgentKind, Extension>;
}

export type DispatchResult = {
	text: string;
	isError: boolean;
	/** 被中止（用户 / 总调度取消，或进程关闭） */
	aborted?: boolean;
	details?: JsonObject;
	/** 后台派工收尾要用 */
	summary?: { sessionId?: string; changeId?: string; model?: string; costUsd?: number; costEstimated?: boolean; durationMs?: number; body: string };
};

/** 按单价估算花费（CLI 没自报时）；没有单价返回 undefined */
export function estimateCost(option: ModelOption | undefined, usage: TokenUsage | undefined): number | undefined {
	if (!option?.price || !usage) return undefined;
	const p = option.price;
	const fresh = Math.max(0, usage.input - (usage.cacheRead ?? 0));
	return (fresh * p.input + (usage.cacheRead ?? 0) * (p.cacheRead ?? p.input) + usage.output * p.output) / 1_000_000;
}

/** worktree 提交的信息：标题是任务的第一句（不截断在半个词上），正文是完整任务和模型 */
function commitMessage(kind: string, model: string | undefined, task: string): string {
	const flat = task.replace(/\s+/g, " ").trim();
	const first = flat.split(/(?<=[。！？!?；;])\s*|[:：]\s*(?=\d[)）.、])/)[0] ?? flat;
	const subject = first.length > 60 ? `${first.slice(0, 60).replace(/[，,、\s][^，,、\s]*$/, "")}…` : first;
	return `pi-agent(${kind}): ${subject}\n\n${task.trim()}\n\n成员：${kind}${model ? `\n模型：${model}` : ""}`;
}

/** 只保留有值的字段（持久化文档只接受严格 JSON，不能有 undefined） */
export function defined<T extends Record<string, unknown>>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** 在一个事务里改分工表，提交后写出 ASSIGN.md；返回改完后的分工表快照 */
export async function commitBoard<R>(
	project: ProjectFiles,
	io: Pick<DispatchIO, "commit" | "now" | "output">,
	mutate: (board: BoardState) => R,
): Promise<{ result: R; board: BoardState }> {
	const out = await io.commit(async (tx) => {
		const board = (await tx.doc(Board)) as BoardState;
		const result = mutate(board);
		board.updatedAt = io.now();
		return { result, board: JSON.parse(JSON.stringify(board)) as BoardState };
	});
	const { savedManualEdit } = project.writeAssign(out.board);
	if (savedManualEdit) io.output(`ℹ ASSIGN.md 被手动改过，已另存为 ${savedManualEdit}，再按分工表重新写出\n`);
	return out;
}

/** 预算：这次运行成员已经花了多少。超了返回拒绝说明（并记一次被拒） */
export async function checkBudget(io: DispatchIO, config: AppConfig): Promise<string | undefined> {
	const limit = config.budget.perRunUsd;
	const budget = await io.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, io.conversationId);
		const first = live.run?.inputs?.[0];
		const doc = await tx.doc(RunBudget);
		let runKey = String(first ?? live.run?.taskId ?? "none");
		// 后台结果发回来触发的运行：仍算用户那一轮，不重新计数
		if (first !== undefined && doc.runKey !== null) {
			const submission = await tx.submission(first as any);
			// 子调度里的派工也算用户那一轮（子调度的对话由总调度的派工发起）
			if (submission?.requestId?.startsWith(JOB_REQUEST_PREFIX) || submission?.requestId?.startsWith(LEAD_PREFIX)) runKey = doc.runKey;
		}
		if (doc.runKey !== runKey) {
			doc.runKey = runKey;
			doc.spent = 0;
			doc.dispatches = 0;
			doc.blocked = 0;
		}
		const over = limit !== null && doc.spent >= limit;
		if (over) doc.blocked++;
		else doc.dispatches++;
		return { spent: doc.spent, over };
	});
	if (!budget.over) return undefined;
	return `本次运行的成员花费已达上限 $${limit!.toFixed(2)}（已花 $${budget.spent.toFixed(2)}），不再派工。请把已有结果汇报给用户，说明还有哪些没做；用户可以调高 budget.perRunUsd 或开始新的一轮。`;
}

/** 开工前能查出来的错误（后台派工要在返回之前就报出来） */
export async function validateDispatch(kind: AgentKind, deps: DispatchDeps, args: DispatchArgs, io: DispatchIO): Promise<string | undefined> {
	const adapter = agentAdapter(kind, deps.config.agents[kind]);
	if (deps.config.agents[kind].workspace === "none" && args.based_on) return "该成员不使用代码工作区，不能传 based_on；请通过任务说明和 read_result 交接资料。";
	const models = deps.config.agents[kind].models;
	if (args.model && models.length && !models.some((m) => m.id === args.model)) {
		return `${adapter.label} 没有配置模型 ${args.model}。可选：${models.map((m) => m.id).join("、")}。`;
	}
	if (args.session_id) {
		if (args.based_on) return "based_on 只能用于新会话；续接会话会回到它自己的目录。";
		const busy = deps.hub.busySessions.get(args.session_id);
		if (busy) return `会话 ${args.session_id} 正在被 ${busy} 使用，不能同时续接。等它结束（wait_jobs），或者开新会话。`;
		const record = await io.commit(async (tx) => {
			const found = (await tx.doc(AgentSessions)).sessions[args.session_id!];
			return found ? { agent: found.agent, controllerId: found.controllerId ?? null } : undefined;
		});
		if (!record) return "当前会话没有登记这个成员上下文，不能跨会话续接。请在所属会话继续，或新开一次派工。";
		if (record.controllerId && record.controllerId !== String(io.conversationId)) return "这个成员上下文属于另一个总控对话，不能跨总控续接。";
		if (record.agent !== kind) return `session_id ${args.session_id} 属于 ${record.agent}，不能交给 ${kind} 续接。`;
	}
	if (args.based_on) {
		const from = deps.changes.get(args.based_on);
		if (!from || from.status === "dropped") return `找不到可用的改动 ${args.based_on}。`;
	}
	if (args.task_id) {
		const exists = await io.commit(async (tx) => !!((await tx.doc(Board)) as BoardState).tasks[args.task_id!]);
		if (!exists) return `分工表里没有任务 ${args.task_id}。先用 plan_tasks 建任务，或者不传 task_id。`;
	}
	return undefined;
}

/** 提交 worktree 里的改动，更新改动记录 */
export async function finishChange(deps: DispatchDeps, change: ChangeRecord | undefined, kind: AgentKind, model: string | undefined, task: string): Promise<ChangeRecord | undefined> {
	if (!change) return undefined;
	const { changes } = deps;
	try {
		const head = (await commitAll(change.path, commitMessage(kind, model, task), change.copied)) ?? change.head;
		const [from] = changes.range({ ...change, head });
		const files = head === from ? [] : await numstat(change.root, from, head);
		return changes.upsert({
			...change,
			head,
			files,
			add: files.reduce((s, f) => s + f.add, 0),
			del: files.reduce((s, f) => s + f.del, 0),
			status: files.length ? "pending" : change.appliedHead ? "applied" : "empty",
			model,
		});
	} catch (error) {
		return changes.upsert({ ...change, status: "pending", message: error instanceof Error ? error.message : String(error) });
	}
}

/** 派工结束后更新任务：关联改动，按结果改状态（成功 → 待验收，由总调度核对后标完成） */
export async function settleTask(deps: DispatchDeps, io: DispatchIO, kind: AgentKind, taskId: string | undefined, status: TaskStatus, changeId: string | undefined, note: string) {
	if (!taskId) return;
	await commitBoard(deps.project, io, (b) => {
		const t = b.tasks[taskId];
		if (!t) return;
		if (t.status !== "done") t.status = status;
		if (changeId && !t.changes.includes(changeId)) t.changes.push(changeId);
		t.notes.push(`${new Date(io.now()).toLocaleString("zh-CN", { hour12: false })} ${kind}：${note}`);
		t.updatedAt = io.now();
	});
}

const fail = (text: string): DispatchResult => ({ text, isError: true });

export async function runDispatch(kind: AgentKind, command: string[], deps: DispatchDeps, args: DispatchArgs, io: DispatchIO, label: string = kind): Promise<DispatchResult> {
	const { config, changes, project, hub } = deps;
	const adapter = agentAdapter(kind, config.agents[kind]);
	const agent = config.agents[kind];
	const models = agent.models;

	// ---- 模型：只能从清单里选 ----
	const model = args.model ?? agent.defaultModel;
	const invalid = await validateDispatch(kind, deps, args, io);
	if (invalid) return fail(invalid);
	const option = models.find((m) => m.id === model);

	// ---- 工作目录：续接会话时回到当初的目录 ----
	const known = args.session_id
		? await io.commit(async (tx) => {
				const record = (await tx.doc(AgentSessions)).sessions[args.session_id!];
				return record ? { agent: record.agent, cwd: record.cwd } : undefined;
			})
		: undefined;
	const requested = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(config.workdir, args.cwd)) : undefined;
	let cwd = known?.cwd ?? requested ?? config.workdir;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		const dropped = changes.byPath(cwd);
		return fail(dropped ? `会话所在的改动 #${dropped.id} 已被丢弃，不能再续接；请开新会话。` : `工作目录不存在：${cwd}`);
	}
	if (known && requested && resolve(requested) !== resolve(known.cwd)) {
		io.output(`ℹ 会话 ${args.session_id} 建立在 ${known.cwd}，续接时使用原目录（忽略 cwd=${requested}）\n`);
	}

	// ---- 隔离：新会话在独立的 worktree 里干活 ----
	const codeWorkspace = agent.workspace !== "none";
	let change: ChangeRecord | undefined = codeWorkspace ? changes.byPath(cwd) : undefined;
	if (codeWorkspace && !known && config.isolation.enabled) {
		const root = await repoRoot(cwd);
		if (root) {
			// 随机编号（memo 保证崩溃重放时拿回同一个），避免重建会话存储后和旧分支撞名
			const id = createHash("sha1").update(`${io.taskId}:${randomUUID()}`).digest("hex").slice(0, 6);
			const plan = (await io.memo("worktree", {
				id,
				branch: `pi/${kind}-${id}`,
				path: join(config.storage, "..", "worktrees", id),
				subdir: relative(root, cwd),
			}))!;
			change = changes.get(plan.id);
			if (!change) {
				let base: string;
				let basedOn: string | undefined;
				if (args.based_on) {
					const from = changes.get(args.based_on);
					if (!from || from.status === "dropped") return fail(`找不到可用的改动 ${args.based_on}。`);
					if (from.root !== root) return fail(`改动 ${args.based_on} 属于另一个仓库（${from.root}）。`);
					base = from.head;
					basedOn = from.id;
				} else {
					base = await snapshot(root);
				}
				const copied: string[] = [];
				if (!existsSync(plan.path)) {
					await addWorktree(root, plan.path, plan.branch, base);
					// 快照不含未跟踪的文件：新写的规范文件（CLAUDE.md / AGENTS.md / GEMINI.md / RULES.md）还没提交时也带过去，成员才读得到
					for (const rel of WORKTREE_CONVENTION_FILES) {
						const from = join(root, rel);
						const to = join(plan.path, rel);
						if (existsSync(from) && !existsSync(to)) {
							mkdirSync(dirname(to), { recursive: true });
							copyFileSync(from, to);
							copied.push(rel);
						}
					}
				}
				const linked = await linkIgnoredDirs(root, plan.path, plan.subdir, config.isolation.linkDirs);
				change = changes.upsert({
					id: plan.id,
					agent: kind,
					callId: io.callId,
					task: args.task,
					model,
					root,
					subdir: plan.subdir,
					path: plan.path,
					branch: plan.branch,
					base,
					basedOn,
					head: base,
					files: [],
					add: 0,
					del: 0,
					status: "running",
					linked,
					...(copied.length ? { copied } : {}),
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
			cwd = join(plan.path, plan.subdir);
		}
	} else if (args.based_on) {
		return fail("工作区隔离没有开启（或工作目录不是 git 仓库），不能用 based_on。");
	}
	if (change && change.status !== "running") changes.upsert({ ...change, status: "running" });

	// ---- 分工表：标记任务进行中；把共同目标 + 这项任务 + 分工全貌交给成员 ----
	const goal = project.goal();
	let brief = "";
	if (args.task_id || goal) {
		const { board } = await commitBoard(project, io, (b) => {
			const t = args.task_id ? b.tasks[args.task_id] : undefined;
			if (!t) return;
			if (t.status !== "done") t.status = "doing";
			t.owner = kind;
			if (!t.dispatches.includes(io.callId)) t.dispatches.push(io.callId);
			t.updatedAt = io.now();
		});
		if (args.task_id && !board.tasks[args.task_id]) return fail(`分工表里没有任务 ${args.task_id}。先用 plan_tasks 建任务，或者不传 task_id。`);
		brief = taskBrief(goal, board, args.task_id);
	}

	// ---- 这次调用之前是否已经启动过（即：这是崩溃后的重放） ----
	const startedBefore = await io.memo<boolean>("started");
	const presetSession = adapter.presetSession ? await io.memo<string>("session", args.session_id ?? randomUUID()) : undefined;
	const seenSession = await io.memo<string>("seen-session");

	let resumeId: string | undefined = args.session_id;
	let prompt = `${brief}${args.task}`;
	if (codeWorkspace && config.autonomy.enabled) {
		const lessons = await io.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Learning)).lessons)) as import("./learning.ts").VerifiedLesson[]);
		const relevant = relevantLessons(lessons, args.task);
		if (relevant) prompt = `【相关已验证记录，仅供参考】\n${relevant}\n\n${prompt}`;
	}
	// API 成员的子对话本身是持久的：重放时按同一个提交接着等，不需要「中断后续接」的提示
	if (startedBefore && adapter.canResume && !agent.api) {
		const crashed = seenSession ?? presetSession;
		if (crashed) {
			resumeId = crashed;
			prompt = `${RESUME_AFTER_CRASH}\n\n原始任务：\n${brief}${args.task}`;
		}
	}
	await io.memo("started", true);

	io.output(`▶ ${adapter.label} 开始执行${model ? `（模型 ${model}）` : ""}（cwd: ${cwd}${resumeId ? `，续接会话 ${resumeId}` : ""}${change ? `，隔离改动 #${change.id}` : ""}）\n`);
	const detailBase = { agent: kind, cwd, resumeId: resumeId ?? null, model: model ?? null, changeId: change?.id ?? null };
	await io.details({ ...detailBase, sessionId: (adapter.canResume ? (resumeId ?? presetSession) : undefined) ?? null } as JsonObject);

	// 会话占用：同一个会话同一时间只能有一个派工
	const holding = new Set<string>();
	const hold = (sid: string | undefined) => {
		if (!sid || holding.has(sid)) return;
		holding.add(sid);
		hub.busySessions.set(sid, label);
	};
	hold(resumeId ?? presetSession);

	let memoizedSession = false;
	let reportedModel: string | undefined;
	/** 一拿到会话 ID 就持久化（进程崩了也能续接），并占住这个会话 */
	const noteSession = (sid: string) => {
		if (memoizedSession) return;
		memoizedSession = true;
		hold(sid);
		void io.memo("seen-session", sid).catch(() => {});
		if (adapter.canResume) void io.details({ ...detailBase, sessionId: sid } as JsonObject).catch(() => {});
	};
	let result: ExecOutcome;
	try {
		if (agent.api) {
			// API 成员：Pi Durable 子对话 + 内置读写工具
			const tools = deps.memberTools?.get(kind);
			if (!hub.harness || !tools || !model) return fail(`${adapter.label} 没有就绪（模型或工具没有注册）。`);
			result = await runApiMember({
				harness: hub.harness,
				hub,
				kind,
				api: agent.api,
				name: adapter.label,
				tools,
				model,
				cwd,
				prompt,
				resumeId,
				instructions: memberInstructions(kind, agent.api, config.workdir, adapter.label, agent, config.collaboration?.instructions),
				io,
				timeoutMs: agent.timeoutMinutes * 60_000,
				onSession: noteSession,
			});
		} else {
			const argv = [...command.slice(1), ...adapter.buildArgs({ resumeId, newSessionId: resumeId ? undefined : presetSession, model, extraArgs: agent.extraArgs })];
			result = await runCli({
				command: command[0]!,
				args: argv,
				cwd,
				stdin: prompt,
				env: cleanEnv(config.stripEnv),
				timeoutMs: agent.timeoutMinutes * 60_000,
				signal: io.signal,
				onLine: (line, stream) => {
					if (stream !== "stdout") return;
					const p = adapter.progress(line);
					if (p.model) reportedModel = p.model;
					if (p.sessionId) noteSession(p.sessionId);
					if (p.summary) io.output(`${p.summary}\n`);
				},
			});
		}
	} finally {
		for (const sid of holding) hub.busySessions.delete(sid);
	}

	if (result.aborted) {
		// 进程正在关闭：什么都不提交，重启后会续接这个会话接着做
		if (io.signal.aborted && hub.closing) return { text: `${adapter.label} 已被中止。`, isError: true, aborted: true };
		const c = await finishChange(deps, change, kind, reportedModel ?? model, args.task);
		await settleTask(deps, io, kind, args.task_id, "todo", c?.files.length ? c.id : undefined, "被中止");
		return { text: `${adapter.label} 已被中止。`, isError: true, aborted: true, summary: { changeId: c?.files.length ? c.id : undefined, body: "" } };
	}
	if (result.timedOut) {
		const c = await finishChange(deps, change, kind, reportedModel ?? model, args.task);
		await settleTask(deps, io, kind, args.task_id, "blocked", c?.files.length ? c.id : undefined, `超时（${agent.timeoutMinutes} 分钟）`);
		const text = `${adapter.label} 超时（${agent.timeoutMinutes} 分钟）被终止。`;
		return { text, isError: true, summary: { changeId: c?.files.length ? c.id : undefined, body: text, durationMs: result.durationMs } };
	}

	const parsed = result.parsed ?? adapter.parse(result.stdout, result.stderr, result.exitCode);
	const usedModel = parsed.model ?? reportedModel ?? model;
	const estimated = parsed.costUsd === undefined ? estimateCost(models.find((m) => m.id === usedModel) ?? option, parsed.usage) : undefined;
	const cost = parsed.costUsd ?? estimated;
	if (cost) {
		await io.commit(async (tx) => {
			(await tx.doc(RunBudget)).spent += cost;
		});
	}
	const sessionId = parsed.sessionId ?? seenSession ?? presetSession;
	const finished = await finishChange(deps, change, kind, usedModel, args.task);
	// 验收命令来自用户配置，模型不能临时改命令或仅凭自述把失败标成功。
	if (finished?.files.length && !parsed.isError && config.autonomy.enabled && config.autonomy.checks.length) {
		const reports: string[] = [];
		let passed = true;
		const headBefore = await git(cwd, ["rev-parse", "HEAD"]);
		if (headBefore.code !== 0 || headBefore.stdout.trim() !== finished.head) passed = false;
		for (const check of config.autonomy.checks) {
			if (io.signal.aborted) { passed = false; break; }
			io.output(`验收：${check.name}\n`);
			try {
				const outcome = await runCli({ command: check.command === "node" ? process.execPath : check.command, args: check.args, cwd,
					env: cleanEnv(config.stripEnv), timeoutMs: (check.timeoutSeconds ?? 120) * 1000, signal: io.signal });
				const ok = outcome.exitCode === 0 && !outcome.aborted && !outcome.timedOut;
				passed &&= ok;
				reports.push(`${check.name}：${ok ? "通过" : "失败"}${ok ? "" : `\n${(outcome.stderr + outcome.stdout).slice(-1800)}`}`);
			} catch (error) { passed = false; reports.push(`${check.name}：${error instanceof Error ? error.message : String(error)}`); }
		}
		const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
		const headAfter = await git(cwd, ["rev-parse", "HEAD"]);
		if (headAfter.code !== 0 || headAfter.stdout.trim() !== finished.head) { passed = false; reports.push("验收期间提交发生变化，需要重新验收。"); }
		if (dirty.code !== 0 || dirty.stdout.trim()) { passed = false; reports.push("验收后存在未提交改动，不能证明当前提交通过。"); }
		parsed.isError = !passed;
		parsed.text += `\n\n【配置验收】\n${reports.join("\n")}`;
		changes.upsert({ ...finished, verification: { head: finished.head, passed, at: io.now(), checks: config.autonomy.checks.map((c) => c.name) } });
		if (io.signal.aborted) {
			await settleTask(deps, io, kind, args.task_id, "todo", finished.id, "验收已中止");
			return { text: "验收已中止。", isError: true, aborted: true };
		}
	}
	if (finished && sessionId) changes.upsert({ ...(changes.get(finished.id) ?? finished), sessionId });
	await settleTask(
		deps,
		io,
		kind,
		args.task_id,
		parsed.isError ? "blocked" : "review",
		finished?.files.length ? finished.id : undefined,
		parsed.isError ? `失败：${parsed.text.trim().split("\n")[0]!.slice(0, 80)}` : `完成${finished?.files.length ? `，改动 #${finished.id}` : ""}，待验收`,
	);
	if (sessionId && adapter.canResume) {
		await io.commit(async (tx) => {
			const sessions = (await tx.doc(AgentSessions)).sessions;
			const prev = sessions[sessionId];
			// 持久化文档只接受严格 JSON：没有的字段不写
			sessions[sessionId] = defined({
				controllerId: String(io.conversationId),
				agent: kind,
				cwd,
				updatedAt: io.now(),
				change: finished?.id ?? prev?.change,
				createdAt: prev?.createdAt ?? io.now(),
				rounds: (prev?.rounds ?? 0) + 1,
				lastTask: args.task.replace(/\s+/g, " ").trim().slice(0, 120),
				model: usedModel,
			}) as SessionRecord;
		});
	}
	let body = parsed.text.trim() || "（没有文字输出）";
	// Preserve the full member report before limiting what enters the controller context.
	const resultId = `dispatch:${io.taskId}`;
	await io.commit((tx) => storeResult(tx, io.conversationId, {
		id: resultId, member: kind, conversationId: sessionId ?? "", submissionId: null, taskId: io.taskId,
		status: parsed.isError ? "unanswered" : "done", text: body, createdAt: io.now(),
	}));
	const outputLimit = config.autonomy.enabled ? Math.min(agent.maxOutputChars, config.autonomy.resultMaxChars) : agent.maxOutputChars;
	const truncated = body.length > outputLimit;
	body = summarizeResult(body, outputLimit);
	if (truncated) body += `\n\n[完整结果已保存；result_id: ${resultId}；需要省略部分时用 read_result 分页读取。]`;
	const changeLine = finished
		? finished.files.length
			? `\n\n[改动 #${finished.id}：${finished.files.length} 个文件 +${finished.add} −${finished.del}，在分支 ${finished.branch}，还没有合并到主目录，等用户在终端确认（/apply ${finished.id}）]`
			: `\n\n[改动 #${finished.id}：没有修改文件]`
		: "";
	const taskLine = args.task_id
		? parsed.isError
			? `\n\n[任务 ${args.task_id} 标为受阻；可以换成员 / 换模型重派，或用 update_task 调整]`
			: `\n\n[任务 ${args.task_id} 标为待验收：请对照验收标准核对，用 update_task 标完成（done）或打回（todo 并写明原因）]`
		: "";
	const meta = [
		`agent: ${kind}`,
		`result_id: ${resultId}`,
		usedModel ? `模型: ${usedModel}` : undefined,
		sessionId && adapter.canResume ? `session_id: ${sessionId}` : undefined,
		`耗时: ${Math.round(result.durationMs / 1000)}s`,
		cost !== undefined ? `花费: $${cost.toFixed(4)}${estimated !== undefined ? "（估算）" : ""}` : undefined,
	].filter(Boolean);

	return {
		text: `${body}${changeLine}${taskLine}\n\n[${meta.join(" | ")}]`,
		isError: parsed.isError,
		details: {
			agent: kind,
			resultId,
			cwd,
			sessionId: sessionId ?? null,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			costUsd: cost ?? null,
			costEstimated: estimated !== undefined,
			model: usedModel ?? null,
			usage: parsed.usage ? { ...parsed.usage } : null,
			changeId: finished?.id ?? null,
		},
		summary: {
			sessionId: sessionId && adapter.canResume ? sessionId : undefined,
			changeId: finished?.files.length ? finished.id : undefined,
			model: usedModel,
			costUsd: cost,
			costEstimated: estimated !== undefined,
			durationMs: result.durationMs,
			body: `${body}${changeLine}${taskLine}\n\n[result_id: ${resultId}]`,
		},
	};
}
