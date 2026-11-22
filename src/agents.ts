// 成员执行适配器：保留 CLI 协议，API 成员通过独立的 Durable 子会话执行。
import type { AgentConfig, AgentKind, BuiltinAgentKind } from "./config.ts";

export interface Invocation {
	/** 新会话时预先指定的会话 ID（仅 Claude 支持） */
	newSessionId?: string;
	/** 要续接的会话 ID */
	resumeId?: string;
	/** 本次要用的模型（已从 extraArgs 里去掉写死的模型参数） */
	model?: string;
	extraArgs: string[];
}

/** CLI 报告的 token 用量（用来按单价估算花费） */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead?: number;
}

export interface ParsedResult {
	text: string;
	sessionId?: string;
	isError: boolean;
	costUsd?: number;
	/** CLI 实际使用的模型（输出里有就读出来） */
	model?: string;
	usage?: TokenUsage;
}

export interface AgentAdapter {
	kind: AgentKind;
	label: string;
	canResume: boolean;
	/** 能否在新会话开始前指定会话 ID（--session-id）；不能的要等输出里出现 ID */
	presetSession?: boolean;
	buildArgs(inv: Invocation): string[];
	/** 解析一行实时输出：返回给人看的进度摘要，以及其中出现的会话 ID */
	progress(line: string): { summary?: string; sessionId?: string; model?: string };
	parse(stdout: string, stderr: string, exitCode: number | null): ParsedResult;
}

function short(value: unknown, max = 100): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function tryJson(line: string): Record<string, any> | undefined {
	const t = line.trim();
	if (!t.startsWith("{")) return undefined;
	try {
		return JSON.parse(t) as Record<string, any>;
	} catch {
		return undefined;
	}
}

function lastLines(text: string, n: number): string {
	return text.trim().split(/\r?\n/).slice(-n).join("\n");
}

// ---------- Claude Code：claude -p --output-format stream-json ----------
const claude: AgentAdapter = {
	kind: "claude",
	label: "Claude Code",
	canResume: true,
	presetSession: true,
	buildArgs({ newSessionId, resumeId, model, extraArgs }) {
		const args = ["-p", "--output-format", "stream-json", "--verbose"];
		if (resumeId) args.push("--resume", resumeId);
		else if (newSessionId) args.push("--session-id", newSessionId);
		if (model) args.push("--model", model);
		return [...args, ...extraArgs];
	},
	progress(line) {
		const ev = tryJson(line);
		if (!ev) return {};
		const sessionId = typeof ev.session_id === "string" ? ev.session_id : undefined;
		if (ev.type === "system" && ev.subtype === "init") return { sessionId, model: typeof ev.model === "string" ? ev.model : undefined };
		if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
			const parts: string[] = [];
			for (const block of ev.message.content) {
				if (block.type === "tool_use") parts.push(`🔧 ${block.name} ${short(block.input, 80)}`);
				else if (block.type === "text" && block.text) parts.push(`💬 ${short(block.text)}`);
			}
			return { summary: parts.join("\n") || undefined, sessionId };
		}
		return { sessionId };
	},
	parse(stdout, stderr, exitCode) {
		let result: Record<string, any> | undefined;
		let sessionId: string | undefined;
		let model: string | undefined;
		for (const line of stdout.split(/\r?\n/)) {
			const ev = tryJson(line);
			if (!ev) continue;
			if (typeof ev.session_id === "string") sessionId = ev.session_id;
			if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
			if (ev.type === "result") result = ev;
		}
		if (!result) {
			return { text: `Claude 没有返回结果（退出码 ${exitCode}）。\n${lastLines(stderr || stdout, 20)}`, sessionId, isError: true, model };
		}
		const isError = result.is_error === true || result.subtype !== "success";
		// 被权限系统拦下的命令：告诉总调度，免得它只看到"没跑成"却不知道原因
		const denied: string[] = Array.isArray(result.permission_denials)
			? result.permission_denials.map((d: any) => short(d?.tool_input?.command ?? d?.tool_input?.file_path ?? d?.tool_name ?? "", 80)).filter(Boolean)
			: [];
		const deniedNote = denied.length ? `\n\n（被权限拒绝、没有执行的操作：${[...new Set(denied)].join("；")}）` : "";
		return {
			text: String(result.result ?? (isError ? `出错：${result.subtype ?? "unknown"}` : "")) + deniedNote,
			sessionId,
			isError,
			costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
			model,
			usage: result.usage
				? {
						input: Number(result.usage.input_tokens ?? 0),
						output: Number(result.usage.output_tokens ?? 0),
						cacheRead: Number(result.usage.cache_read_input_tokens ?? 0),
					}
				: undefined,
		};
	},
};

// ---------- Codex：codex exec --json ----------
const codex: AgentAdapter = {
	kind: "codex",
	label: "Codex (ChatGPT)",
	canResume: true,
	buildArgs({ resumeId, model, extraArgs }) {
		// 提示词通过 stdin 传入（"-"）
		const opts = [...(model ? ["-m", model] : []), ...extraArgs];
		return resumeId
			? ["exec", "resume", "--json", "--skip-git-repo-check", ...opts, resumeId, "-"]
			: ["exec", "--json", "--skip-git-repo-check", ...opts, "-"];
	},
	progress(line) {
		const ev = tryJson(line);
		if (!ev) return {};
		const sessionId = ev.type === "thread.started" && typeof ev.thread_id === "string" ? ev.thread_id : undefined;
		if (ev.type === "item.completed" || ev.type === "item.started") {
			const item = ev.item ?? {};
			if (item.type === "command_execution" && ev.type === "item.started") return { summary: `⚙️ ${short(item.command, 100)}`, sessionId };
			if (item.type === "file_change" && ev.type === "item.completed") {
				const files = Array.isArray(item.changes) ? item.changes.map((c: any) => c.path).join(", ") : "";
				return { summary: `📝 ${short(files, 100)}`, sessionId };
			}
			if (item.type === "agent_message" && ev.type === "item.completed") return { summary: `💬 ${short(item.text)}`, sessionId };
		}
		if (ev.type === "error" || ev.type === "turn.failed") return { summary: `❌ ${short(ev.message ?? ev.error?.message ?? ev, 150)}`, sessionId };
		return { sessionId };
	},
	parse(stdout, stderr, exitCode) {
		let sessionId: string | undefined;
		let text: string | undefined;
		let error: string | undefined;
		let usage: TokenUsage | undefined;
		for (const line of stdout.split(/\r?\n/)) {
			const ev = tryJson(line);
			if (!ev) continue;
			if (ev.type === "thread.started" && typeof ev.thread_id === "string") sessionId = ev.thread_id;
			// 每轮结束时报告用量，累加
			if (ev.type === "turn.completed" && ev.usage) {
				usage ??= { input: 0, output: 0, cacheRead: 0 };
				usage.input += Number(ev.usage.input_tokens ?? 0);
				usage.output += Number(ev.usage.output_tokens ?? 0);
				usage.cacheRead = (usage.cacheRead ?? 0) + Number(ev.usage.cached_input_tokens ?? 0);
			}
			if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = String(ev.item.text ?? "");
			if (ev.type === "turn.failed") error = String(ev.error?.message ?? "turn failed");
			if (ev.type === "error") error = String(ev.message ?? "error");
		}
		if (text !== undefined && !error) return { text, sessionId, isError: false, usage };
		const detail = error ?? lastLines(stderr || stdout, 20);
		return { text: `Codex 执行失败（退出码 ${exitCode}）：${detail}`, sessionId, isError: true, usage };
	},
};

// ---------- Gemini CLI：gemini --output-format json ----------
const gemini: AgentAdapter = {
	kind: "gemini",
	label: "Gemini CLI",
	canResume: true,
	presetSession: true,
	buildArgs({ newSessionId, resumeId, model, extraArgs }) {
		// 非交互模式：stdin 不是终端时 Gemini CLI 读取 stdin 作为提示词
		const args = ["--output-format", "json"];
		if (resumeId) args.push("--resume", resumeId);
		else if (newSessionId) args.push("--session-id", newSessionId);
		if (model) args.push("-m", model);
		return [...args, ...extraArgs];
	},
	progress() {
		return {};
	},
	parse(stdout, stderr, exitCode) {
		const start = stdout.indexOf("{");
		const parsed = start >= 0 ? tryJson(stdout.slice(start)) : undefined;
		// stats.models 形如 { "<模型>": { tokens: { prompt, candidates, cached } } }
		const entries = parsed?.stats?.models && typeof parsed.stats.models === "object" ? Object.entries<any>(parsed.stats.models) : [];
		const model = entries[0]?.[0];
		const usage: TokenUsage | undefined = entries.length
			? {
					input: entries.reduce((s, [, m]) => s + Number(m?.tokens?.prompt ?? 0), 0),
					output: entries.reduce((s, [, m]) => s + Number(m?.tokens?.candidates ?? 0), 0),
					cacheRead: entries.reduce((s, [, m]) => s + Number(m?.tokens?.cached ?? 0), 0),
				}
			: undefined;
		if (parsed && typeof parsed.response === "string" && !parsed.error) {
			return { text: parsed.response, sessionId: parsed.session_id, isError: false, model, usage };
		}
		const detail = parsed?.error?.message ?? (parsed?.error ? short(parsed.error, 500) : geminiError(stderr) ?? lastLines(stderr || stdout, 20));
		return { text: `Gemini 执行失败（退出码 ${exitCode}）：${detail}`, sessionId: parsed?.session_id, isError: true };
	},
};

/** Gemini 出错时 stderr 是一大段堆栈，挑出真正的错误信息（额度、模型不可用、过载等） */
function geminiError(stderr: string): string | undefined {
	const m = stderr.match(/"message":\s*"((?:[^"\\]|\\.){10,})"/) ?? stderr.match(/(?:Error|error)[^\n]*?:\s*([^\n]{10,})/);
	if (!m) return undefined;
	return short(m[1]!.replace(/\\n/g, " ").replace(/\\"/g, '"'), 400);
}

/**
 * DeepSeek 是 API 成员：不启动 CLI，由 api-member.ts 在 Pi Durable 子对话里执行。
 * 这里只提供名称和能力，供派工、后台展示共用；会话 = 子对话的编号，可以续接。
 */
const deepseek: AgentAdapter = {
	kind: "deepseek",
	label: "DeepSeek",
	canResume: true,
	presetSession: false,
	buildArgs: () => [],
	progress: () => ({}),
	parse: (stdout) => ({ text: stdout, isError: false }),
};

export const ADAPTERS: Record<BuiltinAgentKind, AgentAdapter> = { claude, codex, gemini, deepseek };

export function agentAdapter(kind: AgentKind, config: AgentConfig): AgentAdapter {
	if (config.api) return { ...deepseek, kind, label: config.name ?? (kind === "deepseek" ? "DeepSeek" : kind) };
	const adapter = Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind as BuiltinAgentKind] : undefined;
	if (!adapter) throw new Error(`成员 ${kind} 没有可用的执行适配器。`);
	return config.name ? { ...adapter, label: config.name } : adapter;
}
