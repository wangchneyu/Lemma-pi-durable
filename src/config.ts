// 读取 pi-agent.config.json，并自动找到本机 CLI 的真实入口（避开 .cmd/.ps1 外壳）。
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AgentKind = "claude" | "codex" | "gemini";

/** 每 100 万 tokens 的美元单价，用来估算不自报花费的 CLI（Codex、Gemini）和总调度的花费 */
export interface Price {
	input: number;
	output: number;
	cacheRead?: number;
}

/** 成员可用的一个模型：总调度按任务难度从清单里挑 */
export interface ModelOption {
	id: string;
	/** economy：简单、机械的活；standard：日常默认；premium：复杂设计、疑难问题 */
	tier: "economy" | "standard" | "premium";
	/** 给总调度看的说明：适合什么任务 */
	note?: string;
	price?: Price;
}

export interface AgentConfig {
	enabled: boolean;
	/** 给总调度看的角色说明 */
	description: string;
	/** 手动指定启动命令，例如 ["node", "C:/.../codex.js"]；不填则自动探测 */
	command?: string[];
	/** 追加到 CLI 的参数，例如权限/沙箱模式（模型不要写在这里，用 models / defaultModel） */
	extraArgs: string[];
	/** 总调度可以选的模型；为空时不传模型参数，用 CLI 自己的默认 */
	models: ModelOption[];
	/** 总调度没指定时用的模型；不填就用 CLI 自己的默认 */
	defaultModel?: string;
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
	/** 总调度模型的单价（中转站模型没有内置定价，配上才能算出总调度花了多少） */
	price?: Price;
}

export interface IsolationConfig {
	/** 每次派工在独立的 git worktree 里干活（工作目录是 git 仓库时生效） */
	enabled: boolean;
	/** 主目录里被 git 忽略、但干活需要的目录（依赖等），用目录联接挂到 worktree 里，不复制 */
	linkDirs: string[];
}

export interface BudgetConfig {
	/** 一次运行（你的一次输入）里成员花费的上限，美元；超过后不再派工。null 表示不限 */
	perRunUsd: number | null;
}

export interface AppConfig {
	orchestrator: OrchestratorConfig;
	workdir: string;
	storage: string;
	/** 启动子 CLI 前要去掉的环境变量（正则） */
	stripEnv: string[];
	agents: Record<AgentKind, AgentConfig>;
	isolation: IsolationConfig;
	budget: BudgetConfig;
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
			models: [],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
		codex: {
			enabled: true,
			description: "OpenAI Codex（ChatGPT）：擅长实现功能、跑命令和测试、调试报错。",
			extraArgs: ["-c", 'sandbox_mode="workspace-write"'],
			models: [],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
		gemini: {
			enabled: true,
			description: "Google Gemini CLI：上下文窗口大，适合通读大量文件、资料调研、给第二意见。",
			// --skip-trust：无头模式下 Gemini 拒绝在未信任的目录运行；只对本次调用生效
			extraArgs: ["--approval-mode", "auto_edit", "--skip-trust"],
			models: [],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
		},
	},
	isolation: { enabled: true, linkDirs: ["node_modules", ".venv", "venv"] },
	budget: { perRunUsd: 3 },
	web: { enabled: true, port: 8787 },
};

/** 各 CLI 指定模型的参数 */
export const MODEL_FLAGS: Record<AgentKind, string[]> = {
	claude: ["--model"],
	codex: ["-m", "--model"],
	gemini: ["-m", "--model"],
};

/** 去掉 extraArgs 里写死的模型参数，返回剩下的参数和其中的模型 */
export function splitModelArgs(kind: AgentKind, args: string[]): { rest: string[]; model?: string } {
	const flags = MODEL_FLAGS[kind];
	const rest: string[] = [];
	let model: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const eq = flags.find((f) => a.startsWith(`${f}=`));
		if (eq) model = a.slice(eq.length + 1);
		else if (flags.includes(a) && i + 1 < args.length) model = args[++i];
		else rest.push(a);
	}
	return { rest, model };
}

export function loadConfig(path = "pi-agent.config.json"): AppConfig {
	const file = resolve(path);
	const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>) : {};
	const base = dirname(file);
	const agents = { ...DEFAULTS.agents };
	for (const kind of Object.keys(agents) as AgentKind[]) {
		const merged = { ...DEFAULTS.agents[kind], ...(raw.agents?.[kind] ?? {}) };
		// 兼容旧配置：extraArgs 里写死的 -m/--model 当作默认模型
		const { rest, model } = splitModelArgs(kind, merged.extraArgs);
		merged.extraArgs = rest;
		merged.defaultModel ??= model;
		if (merged.defaultModel && !merged.models.some((m) => m.id === merged.defaultModel)) {
			merged.models = [{ id: merged.defaultModel, tier: "standard" }, ...merged.models];
		}
		agents[kind] = merged;
	}
	const config: AppConfig = {
		...DEFAULTS,
		...raw,
		orchestrator: { ...DEFAULTS.orchestrator, ...(raw.orchestrator ?? {}) },
		agents,
		isolation: { ...DEFAULTS.isolation, ...(raw.isolation ?? {}) },
		budget: { ...DEFAULTS.budget, ...(raw.budget ?? {}) },
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
