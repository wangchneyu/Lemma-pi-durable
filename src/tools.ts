// 把本机 CLI 包装成 Pi Durable 工具：ask_claude / ask_codex / ask_gemini。
// 每次派工可以：由总调度选模型；在独立的 git worktree 里干活（改动等用户在终端确认后才合并）；
// 受单次运行的花费上限约束。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineDoc, defineExtension, defineTool, LiveDoc, section, type Extension } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { ADAPTERS, type TokenUsage } from "./agents.ts";
import type { ChangeRecord, ChangeStore } from "./changes.ts";
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

function text(message: string) {
	return { output: [{ type: "text" as const, text: message }], isError: true };
}

function createAgentTool(kind: AgentKind, command: string[], config: AppConfig, changes: ChangeStore) {
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
			...(adapter.canResume ? { session_id: opt(str({ description: "续接之前的会话（之前返回的 session_id）" })) } : {}),
		}),
		// 崩溃重启后允许重新执行：靠记下来的会话 ID 和 worktree 续接，而不是从头再跑
		replay: "safe",
		execute: async (args: { task: string; cwd?: string; model?: string; based_on?: string; session_id?: string }, api, context) => {
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
						if (!existsSync(plan.path)) await addWorktree(root, plan.path, plan.branch, base);
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

			// ---- 这次调用之前是否已经启动过（即：这是崩溃后的重放） ----
			const startedBefore = await api.memo<boolean>("started", context);
			const presetSession = adapter.presetSession ? await api.memo<string>("session", args.session_id ?? randomUUID(), context) : undefined;
			const seenSession = await api.memo<string>("seen-session", context);

			let resumeId: string | undefined = args.session_id;
			let prompt = args.task;
			if (startedBefore && adapter.canResume) {
				const crashed = seenSession ?? presetSession;
				if (crashed) {
					resumeId = crashed;
					prompt = `${RESUME_AFTER_CRASH}\n\n原始任务：\n${args.task}`;
				}
			}
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
					const head = (await commitAll(change.path, `pi-agent: ${kind} — ${args.task.replace(/\s+/g, " ").slice(0, 72)}`)) ?? change.head;
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
				await finishChange();
				return text(`${adapter.label} 已被中止。`);
			}
			if (result.timedOut) {
				await finishChange();
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
			const meta = [
				`agent: ${kind}`,
				usedModel ? `模型: ${usedModel}` : undefined,
				sessionId && adapter.canResume ? `session_id: ${sessionId}` : undefined,
				`耗时: ${Math.round(result.durationMs / 1000)}s`,
				cost !== undefined ? `花费: $${cost.toFixed(4)}${estimated !== undefined ? "（估算）" : ""}` : undefined,
			].filter(Boolean);

			return {
				output: [{ type: "text", text: `${body}${changeLine}\n\n[${meta.join(" | ")}]` }],
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

export function createLocalAgentsExtension(config: AppConfig, changes: ChangeStore): { extension: Extension; agents: AgentAvailability[] } {
	const agents = detectAgents(config);
	const tools = agents.filter((a) => a.available).map((a) => createAgentTool(a.kind, a.command!, config, changes));
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
	const limit = config.budget.perRunUsd;

	const extension = defineExtension({
		name: "local-agents",
		tools,
		sections: [
			section(
				"team",
				() =>
					[
						"你是本机多 agent 协作的总调度。你自己不直接改代码，而是把工作拆成清晰的子任务，交给下面这些本机 AI 去做，然后核对、汇总它们的结果。",
						"",
						"团队成员：",
						roster,
						"",
						"工作方式：",
						"1. 先理解用户目标，必要时拆分任务；简单问题可以直接回答，不必派活。",
						"2. 按各自擅长的方向分配；互不依赖的子任务可以在同一轮里并行调用多个工具。",
						"3. 选模型：按任务难度传 model。简单、机械的活用［经济］，日常开发用［标准］，复杂设计、跨模块改动、疑难问题才用［强力］。不确定就不传，用默认。",
						"4. 重要的产出可以让另一个 agent 交叉审查（例如 Codex 写、Claude 审）。",
						"5. 需要在之前的上下文里继续时，传入上次返回的 session_id。",
						"6. 最后用中文向用户汇报：谁做了什么、用了什么模型、结果、改动编号、还有什么没完成或有风险。",
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
		],
	});
	return { extension, agents };
}
