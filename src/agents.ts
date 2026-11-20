// 三个本机 CLI 的适配器：怎么拼参数、怎么续接会话、怎么从输出里取最终答案和进度。
import type { AgentKind } from "./config.ts";

export interface Invocation {
	/** 新会话时预先指定的会话 ID（仅 Claude 支持） */
	newSessionId?: string;
	/** 要续接的会话 ID */
	resumeId?: string;
	extraArgs: string[];
}

export interface ParsedResult {
	text: string;
	sessionId?: string;
	isError: boolean;
	costUsd?: number;
}

export interface AgentAdapter {
	kind: AgentKind;
	label: string;
	canResume: boolean;
	/** 能否在新会话开始前指定会话 ID（--session-id）；不能的要等输出里出现 ID */
	presetSession?: boolean;
	buildArgs(inv: Invocation): string[];
	/** 解析一行实时输出：返回给人看的进度摘要，以及其中出现的会话 ID */
	progress(line: string): { summary?: string; sessionId?: string };
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
	buildArgs({ newSessionId, resumeId, extraArgs }) {
		const args = ["-p", "--output-format", "stream-json", "--verbose"];
		if (resumeId) args.push("--resume", resumeId);
		else if (newSessionId) args.push("--session-id", newSessionId);
		return [...args, ...extraArgs];
	},
	progress(line) {
		const ev = tryJson(line);
		if (!ev) return {};
		const sessionId = typeof ev.session_id === "string" ? ev.session_id : undefined;
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
		for (const line of stdout.split(/\r?\n/)) {
			const ev = tryJson(line);
			if (!ev) continue;
			if (typeof ev.session_id === "string") sessionId = ev.session_id;
			if (ev.type === "result") result = ev;
		}
		if (!result) {
			return { text: `Claude 没有返回结果（退出码 ${exitCode}）。\n${lastLines(stderr || stdout, 20)}`, sessionId, isError: true };
		}
		const isError = result.is_error === true || result.subtype !== "success";
		return {
			text: String(result.result ?? (isError ? `出错：${result.subtype ?? "unknown"}` : "")),
			sessionId,
			isError,
			costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
		};
	},
};

// ---------- Codex：codex exec --json ----------
const codex: AgentAdapter = {
	kind: "codex",
	label: "Codex (ChatGPT)",
	canResume: true,
	buildArgs({ resumeId, extraArgs }) {
		// 提示词通过 stdin 传入（"-"）
		return resumeId
			? ["exec", "resume", "--json", "--skip-git-repo-check", ...extraArgs, resumeId, "-"]
			: ["exec", "--json", "--skip-git-repo-check", ...extraArgs, "-"];
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
		for (const line of stdout.split(/\r?\n/)) {
			const ev = tryJson(line);
			if (!ev) continue;
			if (ev.type === "thread.started" && typeof ev.thread_id === "string") sessionId = ev.thread_id;
			if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = String(ev.item.text ?? "");
			if (ev.type === "turn.failed") error = String(ev.error?.message ?? "turn failed");
			if (ev.type === "error") error = String(ev.message ?? "error");
		}
		if (text !== undefined && !error) return { text, sessionId, isError: false };
		const detail = error ?? lastLines(stderr || stdout, 20);
		return { text: `Codex 执行失败（退出码 ${exitCode}）：${detail}`, sessionId, isError: true };
	},
};

// ---------- Gemini CLI：gemini --output-format json ----------
const gemini: AgentAdapter = {
	kind: "gemini",
	label: "Gemini CLI",
	canResume: true,
	presetSession: true,
	buildArgs({ newSessionId, resumeId, extraArgs }) {
		// 非交互模式：stdin 不是终端时 Gemini CLI 读取 stdin 作为提示词
		const args = ["--output-format", "json"];
		if (resumeId) args.push("--resume", resumeId);
		else if (newSessionId) args.push("--session-id", newSessionId);
		return [...args, ...extraArgs];
	},
	progress() {
		return {};
	},
	parse(stdout, stderr, exitCode) {
		const start = stdout.indexOf("{");
		const parsed = start >= 0 ? tryJson(stdout.slice(start)) : undefined;
		if (parsed && typeof parsed.response === "string" && !parsed.error) {
			return { text: parsed.response, sessionId: parsed.session_id, isError: false };
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

export const ADAPTERS: Record<AgentKind, AgentAdapter> = { claude, codex, gemini };
