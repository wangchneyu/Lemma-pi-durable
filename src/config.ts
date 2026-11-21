// 读取 pi-agent.config.json，并自动找到本机 CLI 的真实入口（避开 .cmd/.ps1 外壳）。
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AgentKind = "claude" | "codex" | "gemini";

export interface AgentConfig {
	enabled: boolean;
	/** 给总调度看的角色说明 */
	description: string;
	/** 手动指定启动命令，例如 ["node", "C:/.../codex.js"]；不填则自动探测 */
	command?: string[];
	/** 追加到 CLI 的参数，例如权限/沙箱模式、模型 */
	extraArgs: string[];
	timeoutMinutes: number;
	/** 返回给总调度的最大字符数，超出截断 */
	maxOutputChars: number;
}

export interface OrchestratorConfig {
	/**
	 * anthropic-compatible：Anthropic Messages 协议（官方或中转站）
	 * openai-compatible：OpenAI Chat Completions 协议（中转站、Ollama、DeepSeek 等）
	 * builtin：pi-ai 内置 provider（如 anthropic / openai / google），读对应环境变量
	 */
	type: "anthropic-compatible" | "openai-compatible" | "builtin";
	provider?: string;
	modelId: string;
	baseUrl?: string;
	/** 读取密钥的环境变量名，按顺序尝试 */
	apiKeyEnv?: string[];
	/** 若环境变量里没有，从 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN 读取 */
	apiKeyFromClaudeSettings?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	maxTurns?: number;
}

export interface AppConfig {
	orchestrator: OrchestratorConfig;
	workdir: string;
	storage: string;
	/** 启动子 CLI 前要去掉的环境变量（正则） */
	stripEnv: string[];
	agents: Record<AgentKind, AgentConfig>;
	/** 终端进程内嵌的后台网页（只监听 127.0.0.1） */
	web: { enabled: boolean; port: number };
}

const DEFAULTS: AppConfig = {
	orchestrator: {
		type: "anthropic-compatible",
		modelId: "claude-sonnet-5-5",
		apiKeyEnv: ["PI_ORCHESTRATOR_API_KEY"],
		apiKeyFromClaudeSettings: true,
		maxTurns: 40,
	},
	workdir: ".",
	storage: "./data/session.sqlite",
	stripEnv: ["^CLAUDECODE$", "^CLAUDE_CODE_", "^ANTHROPIC_"],
	agents: {
		claude: {
			enabled: true,
			description: "Claude Code：擅长读懂代码库、重构、写代码和文档、细致的代码审查。",
			extraArgs: ["--permission-mode", "acceptEdits"],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
		codex: {
			enabled: true,
			description: "OpenAI Codex（ChatGPT）：擅长实现功能、跑命令和测试、调试报错。",
			extraArgs: ["-c", 'sandbox_mode="workspace-write"'],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
		gemini: {
			enabled: true,
			description: "Google Gemini CLI：上下文窗口大，适合通读大量文件、资料调研、给第二意见。",
			// --skip-trust：无头模式下 Gemini 拒绝在未信任的目录运行；只对本次调用生效
			extraArgs: ["--approval-mode", "auto_edit", "--skip-trust", "-m", "gemini-3.5-flash-lite"],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
	},
	web: { enabled: true, port: 8787 },
};

export function loadConfig(path = "pi-agent.config.json"): AppConfig {
	const file = resolve(path);
	const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>) : {};
	const base = dirname(file);
	const agents = { ...DEFAULTS.agents };
	for (const kind of Object.keys(agents) as AgentKind[]) {
		agents[kind] = { ...DEFAULTS.agents[kind], ...(raw.agents?.[kind] ?? {}) };
	}
	const config: AppConfig = {
		...DEFAULTS,
		...raw,
		orchestrator: { ...DEFAULTS.orchestrator, ...(raw.orchestrator ?? {}) },
		agents,
		web: { ...DEFAULTS.web, ...(raw.web ?? {}) },
	};
	config.workdir = isAbsolute(config.workdir) ? config.workdir : resolve(base, config.workdir);
	config.storage = isAbsolute(config.storage) ? config.storage : resolve(base, config.storage);
	return config;
}

let npmRootCache: string | undefined;
function npmGlobalRoot(): string | undefined {
	if (npmRootCache !== undefined) return npmRootCache;
	const guess = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : undefined;
	if (guess && existsSync(guess)) return (npmRootCache = guess);
	try {
		npmRootCache = execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim();
	} catch {
		npmRootCache = "";
	}
	return npmRootCache || undefined;
}

const NPM_PACKAGES: Record<AgentKind, { pkg: string; bin: string }> = {
	claude: { pkg: "@anthropic-ai/claude-code", bin: "claude" },
	codex: { pkg: "@openai/codex", bin: "codex" },
	gemini: { pkg: "@google/gemini-cli", bin: "gemini" },
};

/** 返回 [可执行文件, ...前置参数]；找不到返回 undefined */
export function resolveCommand(kind: AgentKind, agent: AgentConfig): string[] | undefined {
	if (agent.command && agent.command.length > 0) return agent.command;
	const root = npmGlobalRoot();
	if (!root) return undefined;
	const { pkg, bin } = NPM_PACKAGES[kind];
	const pkgDir = join(root, ...pkg.split("/"));
	const pkgJson = join(pkgDir, "package.json");
	if (!existsSync(pkgJson)) return undefined;
	const meta = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
	const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[bin];
	if (!rel) return undefined;
	const entry = join(pkgDir, rel);
	if (!existsSync(entry)) return undefined;
	return /\.(c|m)?js$/i.test(entry) ? [process.execPath, entry] : [entry];
}

/** 读取 ~/.claude/settings.json 里 Claude CLI 用的中转站地址和 token（不打印） */
export function claudeSettingsEnv(): { baseUrl?: string; token?: string } {
	const file = join(homedir(), ".claude", "settings.json");
	if (!existsSync(file)) return {};
	try {
		const env = (JSON.parse(readFileSync(file, "utf8")) as { env?: Record<string, string> }).env ?? {};
		return { baseUrl: env.ANTHROPIC_BASE_URL, token: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY };
	} catch {
		return {};
	}
}
