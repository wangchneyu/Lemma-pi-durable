// 把本机 CLI 包装成 Pi Durable 工具：ask_claude / ask_codex / ask_gemini。
// 每次派工可以：由总调度选模型；在独立的 git worktree 里干活（改动等用户在终端确认后才合并）；
// 受单次运行的花费上限约束。
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineDoc, defineExtension, defineTool, LiveDoc, section, type Extension } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ADAPTERS, type TokenUsage } from "./agents.ts";
import { Board, boardSummary, STATUS_LABEL, taskBrief, type BoardState, type BoardTask, type ProjectFiles, type TaskStatus } from "./board.ts";
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { WORKTREE_CONVENTION_FILES } from "./conventions.ts";
import { cleanEnv, runCli } from "./cli-runner.ts";
import { resolveCommand, type AgentKind, type AppConfig, type ModelOption } from "./config.ts";
import { addWorktree, commitAll, linkIgnoredDirs, numstat, repoRoot, snapshot } from "./git.ts";

/** 所有 CLI 会话的登记表：会话 ID → 哪个 agent、在哪个目录建立的。随对话一起持久化。 */
type SessionRecord = { agent: AgentKind; cwd: string; updatedAt: number; change?: string };
export const AgentSessions = defineDoc<{ sessions: Record<string, SessionRecord> }>({
	kind: "pi-agent.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
	checkpointWhen: () => false,
});

/** 当前运行（你的一次输入）已经花了多少：换了一次运行就从零算起 */
export const RunBudget = defineDoc<{ runKey: string | null; spent: number; dispatches: number; blocked: number }>({
	kind: "pi-agent.budget",
	version: 1,
	scope: "session",
	initial: () => ({ runKey: null, spent: 0, dispatches: 0, blocked: 0 }),
	checkpointWhen: () => false,
});

const RESUME_AFTER_CRASH =
	"（系统提示：上一次执行在中途被中断了。请检查当前进度，把这个任务做完，然后给出最终结果。）";

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
		const command = resolveCommand(kind, agent);
		if (!command) return { kind, available: false, reason: "本机未安装（未找到 CLI）" };
		return { kind, command, available: true };
	});
}

/** 按单价估算花费（CLI 没自报时）；没有单价返回 undefined */
export function estimateCost(option: ModelOption | undefined, usage: TokenUsage | undefined): number | undefined {
	if (!option?.price || !usage) return undefined;
	const p = option.price;
	const fresh = Math.max(0, usage.input - (usage.cacheRead ?? 0));
	return (fresh * p.input + (usage.cacheRead ?? 0) * (p.cacheRead ?? p.input) + usage.output * p.output) / 1_000_000;
}

const TIER_LABEL = { economy: "经济", standard: "标准", premium: "强力" } as const;

/** worktree 提交的信息：标题是任务的第一句（不截断在半个词上），正文是完整任务和模型 */
function commitMessage(kind: string, model: string | undefined, task: string): string {
	const flat = task.replace(/\s+/g, " ").trim();
	const first = flat.split(/(?<=[。！？!?；;])\s*|[:：]\s*(?=\d[)）.、])/)[0] ?? flat;
	const subject = first.length > 60 ? `${first.slice(0, 60).replace(/[，,、\s][^，,、\s]*$/, "")}…` : first;
	return `pi-agent(${kind}): ${subject}\n\n${task.trim()}\n\n成员：${kind}${model ? `\n模型：${model}` : ""}`;
}

function text(message: string) {
	return { output: [{ type: "text" as const, text: message }], isError: true };
}

/** 在一个事务里改分工表，提交后写出 ASSIGN.md；返回改完后的分工表快照 */
async function commitBoard<R>(
	project: ProjectFiles,
	api: { commit: (change: (tx: any) => any, context: any) => Promise<any>; now(): number; output(chunk: string): void },
	context: any,
	mutate: (board: BoardState) => R,
): Promise<{ result: R; board: BoardState }> {
	const out = await api.commit(async (tx: any) => {
		const board = (await tx.doc(Board)) as BoardState;
		const result = mutate(board);
		board.updatedAt = api.now();
		return { result, board: JSON.parse(JSON.stringify(board)) as BoardState };
	}, context);
	const { savedManualEdit } = project.writeAssign(out.board);
	if (savedManualEdit) api.output(`ℹ ASSIGN.md 被手动改过，已另存为 ${savedManualEdit}，再按分工表重新写出\n`);
	return out;
}

/** 只保留有值的字段（持久化文档只接受严格 JSON，不能有 undefined） */
function defined<T extends Record<string, unknown>>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function createAgentTool(kind: AgentKind, command: string[], config: AppConfig, changes: ChangeStore, project: ProjectFiles) {
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
			`把一个任务交给本机的 ${adapter.label} 去完成，并返回它的最终回答。${agent.description}\n` +
			"它是一个完整的编码 agent，能在 cwd 目录里读写文件、执行命令。task 要写清楚目标、范围和期望的输出格式。" +
			"续接会话时会自动回到会话当初的目录，不必再传 cwd。" +
			resumeHint +
			modelHint,
		parameters: obj({
			task: str({ description: "交给它的完整任务说明" }),
			cwd: opt(str({ description: "工作目录，默认是项目的 workdir" })),
			...(models.length ? { model: opt(str({ description: `用哪个模型：${models.map((m) => m.id).join(" / ")}` })) } : {}),
			based_on: opt(str({ description: "在某次改动（改动编号）的基础上开工，比如审查或接着修改另一个成员刚做的改动" })),
			task_id: opt(str({ description: "这次派工对应分工表里的哪项任务（如 T3）；会把目标和任务上下文一起交给成员，并更新任务状态" })),
			...(adapter.canResume ? { session_id: opt(str({ description: "续接之前的会话（之前返回的 session_id）" })) } : {}),
		}),
		// 崩溃重启后允许重新执行：靠记下来的会话 ID 和 worktree 续接，而不是从头再跑
		replay: "safe",
		execute: async (args: { task: string; cwd?: string; model?: string; based_on?: string; session_id?: string; task_id?: string }, api, context) => {
			// ---- 模型：只能从清单里选 ----
			const model = args.model ?? agent.defaultModel;
			if (args.model && models.length && !models.some((m) => m.id === args.model)) {
				return text(`${adapter.label} 没有配置模型 ${args.model}。可选：${models.map((m) => m.id).join("、")}。`);
			}
			const option = models.find((m) => m.id === model);

			// ---- 预算：这次运行成员已经花了多少 ----
			const limit = config.budget.perRunUsd;
			const budget = await api.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, api.conversationId);
				const runKey = String(live.run?.inputs?.[0] ?? live.run?.taskId ?? "none");
				const doc = await tx.doc(RunBudget);
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
			}, context);
			if (budget.over) {
				return text(
					`本次运行的成员花费已达上限 $${limit!.toFixed(2)}（已花 $${budget.spent.toFixed(2)}），不再派工。请把已有结果汇报给用户，说明还有哪些没做；用户可以调高 budget.perRunUsd 或开始新的一轮。`,
				);
			}

			// ---- 工作目录：续接会话时回到当初的目录 ----
			const known = args.session_id
				? await api.commit(async (tx) => {
						const record = (await tx.doc(AgentSessions)).sessions[args.session_id!];
						return record ? { agent: record.agent, cwd: record.cwd } : undefined;
					}, context)
				: undefined;
			if (known && known.agent !== kind) return text(`session_id ${args.session_id} 属于 ${known.agent}，不能交给 ${kind} 续接。`);
			const requested = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(config.workdir, args.cwd)) : undefined;
			let cwd = known?.cwd ?? requested ?? config.workdir;
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
				const dropped = changes.byPath(cwd);
				return text(dropped ? `会话所在的改动 #${dropped.id} 已被丢弃，不能再续接；请开新会话。` : `工作目录不存在：${cwd}`);
			}
			if (known && requested && resolve(requested) !== resolve(known.cwd)) {
				api.output(`ℹ 会话 ${args.session_id} 建立在 ${known.cwd}，续接时使用原目录（忽略 cwd=${requested}）\n`);
			}

			// ---- 隔离：新会话在独立的 worktree 里干活 ----
			let change: ChangeRecord | undefined = changes.byPath(cwd);
			if (args.based_on && known) return text("based_on 只能用于新会话；续接会话会回到它自己的目录。");
			if (!known && config.isolation.enabled) {
				const root = await repoRoot(cwd);
				if (root) {
					// 随机编号（memo 保证崩溃重放时拿回同一个），避免重建会话存储后和旧分支撞名
					const id = createHash("sha1").update(`${api.taskId}:${randomUUID()}`).digest("hex").slice(0, 6);
					const plan = await api.memo(
						"worktree",
						{ id, branch: `pi/${kind}-${id}`, path: join(config.storage, "..", "worktrees", id), subdir: relative(root, cwd) },
						context,
					);
					change = changes.get(plan.id);
					if (!change) {
						let base: string;
						let basedOn: string | undefined;
						if (args.based_on) {
							const from = changes.get(args.based_on);
							if (!from || from.status === "dropped") return text(`找不到可用的改动 ${args.based_on}。`);
							if (from.root !== root) return text(`改动 ${args.based_on} 属于另一个仓库（${from.root}）。`);
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
							callId: api.callId,
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
				return text("工作区隔离没有开启（或工作目录不是 git 仓库），不能用 based_on。");
			}
			if (change && change.status !== "running") changes.upsert({ ...change, status: "running" });

			// ---- 分工表：标记任务进行中；把共同目标 + 这项任务 + 分工全貌交给成员 ----
			const goal = project.goal();
			let brief = "";
			if (args.task_id || goal) {
				const { board } = await commitBoard(project, api, context, (b) => {
					const t = args.task_id ? b.tasks[args.task_id] : undefined;
					if (!t) return;
					if (t.status !== "done") t.status = "doing";
					t.owner = kind;
					if (!t.dispatches.includes(api.callId)) t.dispatches.push(api.callId);
					t.updatedAt = api.now();
				});
				if (args.task_id && !board.tasks[args.task_id]) return text(`分工表里没有任务 ${args.task_id}。先用 plan_tasks 建任务，或者不传 task_id。`);
				brief = taskBrief(goal, board, args.task_id);
			}

			// ---- 这次调用之前是否已经启动过（即：这是崩溃后的重放） ----
			const startedBefore = await api.memo<boolean>("started", context);
			const presetSession = adapter.presetSession ? await api.memo<string>("session", args.session_id ?? randomUUID(), context) : undefined;
			const seenSession = await api.memo<string>("seen-session", context);

			let resumeId: string | undefined = args.session_id;
			let prompt = `${brief}${args.task}`;
			if (startedBefore && adapter.canResume) {
				const crashed = seenSession ?? presetSession;
				if (crashed) {
					resumeId = crashed;
					prompt = `${RESUME_AFTER_CRASH}\n\n原始任务：\n${brief}${args.task}`;
				}
			}
			/** 派工结束后更新任务：关联改动，按结果改状态（成功 → 待验收，由总调度核对后标完成） */
			const settleTask = async (status: TaskStatus, changeId: string | undefined, note: string) => {
				if (!args.task_id) return;
				await commitBoard(project, api, context, (b) => {
					const t = b.tasks[args.task_id!];
					if (!t) return;
					if (t.status !== "done") t.status = status;
					if (changeId && !t.changes.includes(changeId)) t.changes.push(changeId);
					t.notes.push(`${new Date(api.now()).toLocaleString("zh-CN", { hour12: false })} ${kind}：${note}`);
					t.updatedAt = api.now();
				});
			};
			await api.memo("started", true, context);

			const argv = [
				...command.slice(1),
				...adapter.buildArgs({ resumeId, newSessionId: resumeId ? undefined : presetSession, model, extraArgs: agent.extraArgs }),
			];
			api.output(
				`▶ ${adapter.label} 开始执行${model ? `（模型 ${model}）` : ""}（cwd: ${cwd}${resumeId ? `，续接会话 ${resumeId}` : ""}${change ? `，隔离改动 #${change.id}` : ""}）\n`,
			);
			await api.details({ agent: kind, cwd, resumeId: resumeId ?? null, model: model ?? null, changeId: change?.id ?? null }, context);

			let memoizedSession = false;
			let reportedModel: string | undefined;
			const result = await runCli({
				command: command[0]!,
				args: argv,
				cwd,
				stdin: prompt,
				env: cleanEnv(config.stripEnv),
				timeoutMs: agent.timeoutMinutes * 60_000,
				signal: context.abortSignal,
				onLine: (line, stream) => {
					if (stream !== "stdout") return;
					const p = adapter.progress(line);
					if (p.model) reportedModel = p.model;
					if (p.sessionId && !memoizedSession) {
						memoizedSession = true;
						// 一拿到会话 ID 就持久化，进程崩了也能续接
						void api.memo("seen-session", p.sessionId, context).catch(() => {});
					}
					if (p.summary) api.output(`${p.summary}\n`);
				},
			});

			// ---- 收尾：提交 worktree 里的改动 ----
			const finishChange = async (): Promise<ChangeRecord | undefined> => {
				if (!change) return undefined;
				try {
					const head = (await commitAll(change.path, commitMessage(kind, reportedModel ?? model, args.task), change.copied)) ?? change.head;
					const [from] = changes.range({ ...change, head });
					const files = head === from ? [] : await numstat(change.root, from, head);
					return changes.upsert({
						...change,
						head,
						files,
						add: files.reduce((s, f) => s + f.add, 0),
						del: files.reduce((s, f) => s + f.del, 0),
						status: files.length ? "pending" : change.appliedHead ? "applied" : "empty",
						model: reportedModel ?? model,
					});
				} catch (error) {
					return changes.upsert({ ...change, status: "pending", message: error instanceof Error ? error.message : String(error) });
				}
			};

			if (result.aborted) {
				const c = await finishChange();
				await settleTask("todo", c?.files.length ? c.id : undefined, "被中止");
				return text(`${adapter.label} 已被中止。`);
			}
			if (result.timedOut) {
				const c = await finishChange();
				await settleTask("blocked", c?.files.length ? c.id : undefined, `超时（${agent.timeoutMinutes} 分钟）`);
				return text(`${adapter.label} 超时（${agent.timeoutMinutes} 分钟）被终止。`);
			}

			const parsed = adapter.parse(result.stdout, result.stderr, result.exitCode);
			const usedModel = parsed.model ?? reportedModel ?? model;
			const estimated = parsed.costUsd === undefined ? estimateCost(models.find((m) => m.id === usedModel) ?? option, parsed.usage) : undefined;
			const cost = parsed.costUsd ?? estimated;
			if (cost) {
				await api.commit(async (tx) => {
					(await tx.doc(RunBudget)).spent += cost;
				}, context);
			}
			const sessionId = parsed.sessionId ?? seenSession ?? presetSession;
			const finished = await finishChange();
			if (finished && sessionId) changes.upsert({ ...finished, sessionId });
			await settleTask(
				parsed.isError ? "blocked" : "review",
				finished?.files.length ? finished.id : undefined,
				parsed.isError ? `失败：${parsed.text.trim().split("\n")[0]!.slice(0, 80)}` : `完成${finished?.files.length ? `，改动 #${finished.id}` : ""}，待验收`,
			);
			if (sessionId && adapter.canResume) {
				await api.commit(async (tx) => {
					// 持久化文档只接受严格 JSON：没有改动编号时不写这个字段
					(await tx.doc(AgentSessions)).sessions[sessionId] = { agent: kind, cwd, updatedAt: api.now(), ...(finished ? { change: finished.id } : {}) };
				}, context);
			}
			let body = parsed.text.trim() || "（没有文字输出）";
			if (body.length > agent.maxOutputChars) {
				body = `${body.slice(0, agent.maxOutputChars)}\n…（已截断，原文 ${parsed.text.length} 字符）`;
			}
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
				usedModel ? `模型: ${usedModel}` : undefined,
				sessionId && adapter.canResume ? `session_id: ${sessionId}` : undefined,
				`耗时: ${Math.round(result.durationMs / 1000)}s`,
				cost !== undefined ? `花费: $${cost.toFixed(4)}${estimated !== undefined ? "（估算）" : ""}` : undefined,
			].filter(Boolean);

			return {
				output: [{ type: "text", text: `${body}${changeLine}${taskLine}\n\n[${meta.join(" | ")}]` }],
				isError: parsed.isError,
				details: {
					agent: kind,
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
			};
		},
	});
}

const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked", "dropped"] as const;

/** 总调度维护分工表的工具：拆任务、改状态、起草目标 */
function createBoardTools(config: AppConfig, project: ProjectFiles) {
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
				}),
			),
		}),
		replay: "safe",
		execute: async (args: { tasks: { title: string; acceptance?: string; role?: string; owner?: string; deps?: string[]; detail?: string }[] }, api, context) => {
			const { result } = await commitBoard(project, api, context, (b) => {
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
			const { result, board } = await commitBoard(project, api, context, (b) => {
				const t = b.tasks[args.id];
				if (!t) return false;
				Object.assign(t, defined({ status: args.status, owner: args.owner, role: args.role, title: args.title, acceptance: args.acceptance }));
				const note = args.note ? `${new Date(api.now()).toLocaleString("zh-CN", { hour12: false })} 总调度：${args.status ? `[${STATUS_LABEL[args.status]}] ` : ""}${args.note}` : undefined;
				if (note && t.notes.at(-1) !== note) t.notes.push(note);
				t.updatedAt = api.now();
				return true;
			});
			if (!result) return { output: [{ type: "text", text: `分工表里没有任务 ${args.id}。` }], isError: true };
			return { output: [{ type: "text", text: `已更新 ${args.id}。当前分工：\n${boardSummary(board)}` }] };
		},
	});

	const setGoal = defineTool({
		name: "set_goal",
		description:
			"起草项目的最终目标（.pi-agent/GOAL.md）：要做成什么、验收标准、约束和不做什么。只在还没有 GOAL.md、用户给出项目级目标时使用；" +
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
): { extension: Extension; agents: AgentAvailability[] } {
	const agents = detectAgents(config);
	const tools = [...agents.filter((a) => a.available).map((a) => createAgentTool(a.kind, a.command!, config, changes, project)), ...createBoardTools(config, project)];
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
		sections: [
			section(
				"team",
				() =>
					[
						"你是本机多 agent 协作的总调度，相当于团队的项目负责人。你自己不直接改代码，而是把工作拆成清晰的任务，按角色分给下面这些本机 AI，再核对、汇总它们的结果。",
						"",
						"团队成员：",
						roster,
						"",
						...(roles ? ["角色分工（规划任务时给每项定角色，派工时按角色找成员；首选不可用时用后面的）：", roles, ""] : []),
						"工作方式：",
						"1. 先理解用户目标。简单问题直接回答，不必派活，也不必建分工表。",
						"2. 项目级、多步骤的任务：先用 plan_tasks 拆解，每项写清楚验收标准、角色、依赖；然后按依赖顺序派工，互不依赖的任务在同一轮里并行派。",
						"3. 派工时传 task_id：成员会同时拿到项目目标、这项任务和分工全貌，知道自己在全局里的位置。",
						"4. 选模型：按任务难度传 model。简单、机械的活用［经济］，日常开发用［标准］，复杂设计、跨模块改动、疑难问题才用［强力］。不确定就不传，用默认（角色配置里写了模型的优先用它）。",
						"5. 成员完成后任务会变成「待验收」：对照验收标准核对（必要时派审查角色），用 update_task 标完成或打回并写明原因。",
						"6. 需要在之前的上下文里继续时，传入上次返回的 session_id。",
						"7. 最后用中文向用户汇报：按任务编号说明谁做了什么、用了什么模型、结果、改动编号、还有什么没完成或有风险。",
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
						limit !== null ? `花费上限：一次运行里成员的花费最多 $${limit}。超过后派工会被拒绝，届时直接汇报已有结果。能用便宜模型完成的活不要用贵的。` : "",
						`默认工作目录：${config.workdir}`,
					]
						.filter((l) => l !== undefined)
						.join("\n"),
				{ tag: false },
			),
			// 项目目标 + 分工表：每次请求都按最新状态渲染（分工表变了这一段才重发，其余部分的提示缓存不受影响）
			section(
				"project",
				async (input, context) => {
					const goal = project.goal();
					const board = (await input.read.snapshot(Board, context)) as BoardState | undefined;
					return [
						goal ? `项目最终目标（.pi-agent/GOAL.md，以用户写的为准）：\n${goal}` : "还没有 .pi-agent/GOAL.md。用户给出项目级目标时，用 set_goal 起草一份，并请用户确认。",
						"",
						"当前分工表（.pi-agent/ASSIGN.md 由你通过 plan_tasks / update_task 维护）：",
						boardSummary(board),
					].join("\n");
				},
			),
		],
	});
	return { extension, agents };
}
