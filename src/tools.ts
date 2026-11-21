// 把本机 CLI 包装成 Pi Durable 工具：ask_claude / ask_codex / ask_gemini。
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defineDoc, defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { ADAPTERS } from "./agents.ts";
import { cleanEnv, runCli } from "./cli-runner.ts";
import { resolveCommand, type AgentKind, type AppConfig } from "./config.ts";

/** 所有 CLI 会话的登记表：会话 ID → 哪个 agent、在哪个目录建立的。随对话一起持久化。 */
type SessionRecord = { agent: AgentKind; cwd: string; updatedAt: number };
export const AgentSessions = defineDoc<{ sessions: Record<string, SessionRecord> }>({
	kind: "pi-agent.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
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

function createAgentTool(kind: AgentKind, command: string[], config: AppConfig) {
	const adapter = ADAPTERS[kind];
	const agent = config.agents[kind];
	const resumeHint = adapter.canResume
		? "返回结果末尾会带上 session_id；想让它在同一上下文里继续（追问、修改），下次调用时传入这个 session_id。"
		: "这个 agent 不支持续接会话，每次调用都是全新上下文，请把必要背景写进 task。";

	return defineTool({
		name: `ask_${kind}`,
		description:
			`把一个任务交给本机的 ${adapter.label} 去完成，并返回它的最终回答。${agent.description}\n` +
			"它是一个完整的编码 agent，能在 cwd 目录里读写文件、执行命令。task 要写清楚目标、范围和期望的输出格式。" +
			"续接会话时会自动回到会话当初的目录，不必再传 cwd。" +
			resumeHint,
		parameters: obj({
			task: str({ description: "交给它的完整任务说明" }),
			cwd: opt(str({ description: "工作目录，默认是项目的 workdir" })),
			...(adapter.canResume ? { session_id: opt(str({ description: "续接之前的会话（之前返回的 session_id）" })) } : {}),
		}),
		// 崩溃重启后允许重新执行：靠记下来的会话 ID 续接，而不是从头再跑
		replay: "safe",
		execute: async (args: { task: string; cwd?: string; session_id?: string }, api, context) => {
			// 续接会话时：CLI 的会话和启动目录绑定，自动回到当初的目录
			const known = args.session_id
				? await api.commit(async (tx) => {
						const record = (await tx.doc(AgentSessions)).sessions[args.session_id!];
						return record ? { agent: record.agent, cwd: record.cwd } : undefined;
					}, context)
				: undefined;
			if (known && known.agent !== kind) {
				return { output: [{ type: "text", text: `session_id ${args.session_id} 属于 ${known.agent}，不能交给 ${kind} 续接。` }], isError: true };
			}
			const requested = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(config.workdir, args.cwd)) : undefined;
			const cwd = known?.cwd ?? requested ?? config.workdir;
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
				return { output: [{ type: "text", text: `工作目录不存在：${cwd}` }], isError: true };
			}
			if (known && requested && resolve(requested) !== resolve(known.cwd)) {
				api.output(`ℹ 会话 ${args.session_id} 建立在 ${known.cwd}，续接时使用原目录（忽略 cwd=${requested}）\n`);
			}

			// 这次调用之前是否已经启动过（即：这是崩溃后的重放）
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
				...adapter.buildArgs({
					resumeId,
					newSessionId: resumeId ? undefined : presetSession,
					extraArgs: agent.extraArgs,
				}),
			];
			api.output(`▶ ${adapter.label} 开始执行（cwd: ${cwd}${resumeId ? `，续接会话 ${resumeId}` : ""}）\n`);
			await api.details({ agent: kind, cwd, resumeId: resumeId ?? null }, context);

			let memoizedSession = false;
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
					if (p.sessionId && !memoizedSession) {
						memoizedSession = true;
						// 一拿到会话 ID 就持久化，进程崩了也能续接
						void api.memo("seen-session", p.sessionId, context).catch(() => {});
					}
					if (p.summary) api.output(`${p.summary}\n`);
				},
			});

			if (result.aborted) return { output: [{ type: "text", text: `${adapter.label} 已被中止。` }], isError: true };
			if (result.timedOut) {
				return { output: [{ type: "text", text: `${adapter.label} 超时（${agent.timeoutMinutes} 分钟）被终止。` }], isError: true };
			}

			const parsed = adapter.parse(result.stdout, result.stderr, result.exitCode);
			const sessionId = parsed.sessionId ?? seenSession ?? presetSession;
			if (sessionId && adapter.canResume) {
				await api.commit(async (tx) => {
					(await tx.doc(AgentSessions)).sessions[sessionId] = { agent: kind, cwd, updatedAt: api.now() };
				}, context);
			}
			let text = parsed.text.trim() || "（没有文字输出）";
			if (text.length > agent.maxOutputChars) {
				text = `${text.slice(0, agent.maxOutputChars)}\n…（已截断，原文 ${parsed.text.length} 字符）`;
			}
			const meta = [
				`agent: ${kind}`,
				sessionId && adapter.canResume ? `session_id: ${sessionId}` : undefined,
				`耗时: ${Math.round(result.durationMs / 1000)}s`,
				parsed.costUsd !== undefined ? `花费: $${parsed.costUsd.toFixed(4)}` : undefined,
			].filter(Boolean);

			return {
				output: [{ type: "text", text: `${text}\n\n[${meta.join(" | ")}]` }],
				isError: parsed.isError,
				details: {
					agent: kind,
					cwd,
					sessionId: sessionId ?? null,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					costUsd: parsed.costUsd ?? null,
				},
			};
		},
	});
}

export function createLocalAgentsExtension(config: AppConfig): { extension: Extension; agents: AgentAvailability[] } {
	const agents = detectAgents(config);
	const tools = agents.filter((a) => a.available).map((a) => createAgentTool(a.kind, a.command!, config));
	const roster = agents
		.map((a) => `- ${a.kind}: ${a.available ? `可用，工具 ask_${a.kind}。${config.agents[a.kind].description}` : `不可用（${a.reason}）`}`)
		.join("\n");

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
						"3. 重要的产出可以让另一个 agent 交叉审查（例如 Codex 写、Claude 审）。",
						"4. 需要在之前的上下文里继续时，传入上次返回的 session_id。",
						"5. 最后用中文向用户汇报：谁做了什么、结果、还有什么没完成或有风险。",
						`默认工作目录：${config.workdir}`,
					].join("\n"),
				{ tag: false },
			),
		],
	});
	return { extension, agents };
}
