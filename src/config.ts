// 读取 pi-agent.config.json，并自动找到本机 CLI 的真实入口（避开 .cmd/.ps1 外壳）。
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateBusinessTools, type HttpBusinessTool } from "./business-tools.ts";

/** claude / codex / gemini 是本机 CLI；deepseek 是 Pi 原生的 API 成员（Pi Durable 子对话 + 内置读写工具） */
export type BuiltinAgentKind = "claude" | "codex" | "gemini" | "deepseek";
/** Stable member identity, independent of provider or execution transport. */
export type AgentId = string;
/** Compatibility alias for persisted records and existing adapters. */
export type AgentKind = AgentId;
/** 走本机 CLI 的成员 */
export const CLI_KINDS = ["claude", "codex", "gemini"] as const;

/**
 * API 成员：不需要本机装 CLI，pi-agent 直接调模型 API，在 Pi Durable 里开一个子对话，
 * 用内置的 read / write / edit / bash 工具在（隔离的）工作目录里干活。
 */
export interface ApiMemberConfig {
	httpTools?: HttpBusinessTool[];
	/** Reference into the local credential store; never the secret itself. */
	credential?: string;
	/** Explicit file/shell grants. Custom API members default to no tools. */
	tools?: ("read" | "write" | "edit" | "bash")[];
	/** openai-compatible：OpenAI Chat Completions 协议（DeepSeek 官方、各种中转站）；anthropic-compatible：Anthropic Messages 协议 */
	type: "openai-compatible" | "anthropic-compatible";
	baseUrl: string;
	/** 读取密钥的环境变量名，按顺序尝试 */
	apiKeyEnv: string[];
	contextWindow?: number;
	maxTokens?: number;
	/** 一次派工里最多几轮工具调用 */
	maxTurns?: number;
	/**
	 * bash 工具：allowlist 只放行 bashAllow 里开头的命令（不能用 ; && | > 等串接、重定向），
	 * all 全部放行，off 不给 bash（只能读写文件）
	 */
	bash: "allowlist" | "all" | "off";
	bashAllow: string[];
}

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
	name?: string;
	instructions?: string;
	/** code: existing worktree/check flow; none: conversation and results only. */
	workspace?: "code" | "none";
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
	/** API 成员的接入方式（只有 API 成员有） */
	api?: ApiMemberConfig;
}

export interface OrchestratorConfig {
	credential?: string;
	/**
	 * anthropic-compatible：Anthropic Messages 协议（官方或中转站）
	 * openai-compatible：OpenAI Chat Completions 协议（中转站、Ollama、DeepSeek 等）
	 * builtin：pi-ai 内置 provider（如 anthropic / openai / google），读对应环境变量
	 */
	type: "anthropic-compatible" | "openai-compatible" | "builtin";
	provider?: string;
	modelId: string;
	/** 可供总控原生选择器切换的额外模型 ID；使用同一 provider、地址和凭据。 */
	modelIds?: string[];
	/** 打开总控选择器时读取当前服务的 /models 目录，不发送聊天请求。 */
	discoverModels?: boolean;
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

/** 角色：总调度拆任务时给每项任务定角色，派工时按角色找成员（像真人团队按岗位分工） */
export interface RoleConfig {
	name: string;
	/** 首选成员 */
	agent: AgentKind;
	/** 首选成员用的模型（不填用成员的默认） */
	model?: string;
	/** 首选成员不可用时依次尝试 */
	fallback?: AgentKind[];
	/** 这个角色负责什么 */
	note?: string;
}

export interface BudgetConfig {
	/** 一次运行（你的一次输入）里成员花费的上限，美元；超过后不再派工。null 表示不限 */
	perRunUsd: number | null;
}

export interface AppConfig {
	/** Domain/controller guidance, shared by the terminal and web application. */
	collaboration?: { instructions: string };
	/** 命名会话的分工表目录；项目目标与规则仍从工作目录读取。 */
	projectStateDir?: string;
	autonomy: {
		enabled: boolean;
		maxRepairAttempts: number;
		resultMaxChars: number;
		checks: { name: string; command: string; args: string[]; timeoutSeconds?: number }[];
	};
	/** 子调度：总调度把较大的子目标整块交给子负责人（Pi Durable 子对话，同模型、同派工工具，只有一层） */
	lead: { enabled: boolean };
	orchestrator: OrchestratorConfig;
	workdir: string;
	storage: string;
	/** 启动子 CLI 前要去掉的环境变量（正则） */
	stripEnv: string[];
	agents: Record<AgentKind, AgentConfig>;
	isolation: IsolationConfig;
	budget: BudgetConfig;
	roles: RoleConfig[];
	/** 终端进程内嵌的后台网页（只监听 127.0.0.1） */
	web: { enabled: boolean; port: number };
}

const DEFAULTS: AppConfig = {
	lead: { enabled: true },
	autonomy: { enabled: false, maxRepairAttempts: 2, resultMaxChars: 4000, checks: [] },
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
			// acceptEdits 只放行改文件；跑测试是 Bash 命令，单独放开这几类（其他命令仍会被拒绝）
			extraArgs: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(npm test:*)", "Bash(npm run test:*)", "Bash(node --test:*)"],
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
		deepseek: {
			enabled: true,
			description: "DeepSeek（API 成员，Pi 原生）：便宜，适合按清楚的设计写代码、写测试、改小 bug。",
			extraArgs: [],
			// 模型名不写死：DeepSeek 的模型名会变，在配置里填实际可用的（见 api-docs.deepseek.com）
			models: [],
			timeoutMinutes: 30,
			maxOutputChars: 20000,
			api: {
				type: "openai-compatible",
				baseUrl: "https://api.deepseek.com",
				apiKeyEnv: ["DEEPSEEK_API_KEY"],
				contextWindow: 128_000,
				maxTokens: 8192,
				maxTurns: 40,
				bash: "allowlist",
				bashAllow: [
					"npm test",
					"npm run test",
					"npm run lint",
					"npm run typecheck",
					"npm run build",
					"npx tsc",
					"node --test",
					"pnpm test",
					"yarn test",
					"pytest",
					"python -m pytest",
					"cargo test",
					"go test",
					"git status",
					"git diff",
					"git log",
					"ls",
					"pwd",
					"cat",
					"head",
					"tail",
					"wc",
					"grep",
					"rg",
				],
			},
		},
	},
	isolation: { enabled: true, linkDirs: ["node_modules", ".venv", "venv"] },
	budget: { perRunUsd: 3 },
	roles: [
		{ name: "架构", agent: "claude", model: "claude-opus-5-5", note: "整体方案、模块划分、跨模块的复杂改动" },
		{ name: "设计", agent: "codex", note: "接口和实现方案设计" },
		{ name: "编码", agent: "deepseek", fallback: ["gemini", "codex"], note: "按设计实现功能、写测试（DeepSeek 便宜；没配密钥时由 Gemini / Codex 顶上）" },
		{ name: "审查", agent: "claude", model: "claude-sonnet-5-5", note: "代码审查、找问题、核对验收标准" },
	],
	web: { enabled: true, port: 8787 },
};

/** 各 CLI 指定模型的参数 */
export const MODEL_FLAGS: Record<AgentKind, string[]> = {
	claude: ["--model"],
	codex: ["-m", "--model"],
	gemini: ["-m", "--model"],
	deepseek: [],
};

/** 去掉 extraArgs 里写死的模型参数，返回剩下的参数和其中的模型 */
export function splitModelArgs(kind: AgentKind, args: string[]): { rest: string[]; model?: string } {
	const flags = MODEL_FLAGS[kind] ?? [];
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
	return normalizeConfig(raw, file);
}

/** Validate an in-memory candidate before writing any configuration file. */
export function normalizeConfig(raw: Partial<AppConfig>, path = "pi-agent.config.json"): AppConfig {
	const file = resolve(path);
	const base = dirname(file);
	const agents: Record<AgentKind, AgentConfig> = {};
	for (const kind of new Set([...Object.keys(DEFAULTS.agents), ...Object.keys(raw.agents ?? {})])) {
		if (!/^[a-z][a-z0-9_]{0,47}$/.test(kind) || ["__proto__", "constructor", "prototype", "lead", "all", "orchestrator"].includes(kind)) throw new Error(`无效成员 ID：${kind}（使用小写字母、数字和下划线，避开系统保留名）`);
		const builtin = Object.hasOwn(DEFAULTS.agents, kind) ? DEFAULTS.agents[kind] : undefined;
		const supplied = raw.agents?.[kind];
		if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) throw new Error(`成员 ${kind} 需要配置对象。`);
		const merged: AgentConfig = { enabled: true, description: kind, extraArgs: [], models: [], timeoutMinutes: 30, maxOutputChars: 4000, workspace: builtin ? "code" : "none", ...builtin, ...supplied };
		if (builtin?.api || supplied?.api) {
			merged.api = { type: "openai-compatible", baseUrl: "", apiKeyEnv: [], bash: "off", bashAllow: [], ...builtin?.api, ...supplied?.api };
			if (!builtin) merged.api.tools ??= [];
		}
		if (!builtin && !merged.api) throw new Error(`自定义成员 ${kind} 需要 api 配置。`);
		if (merged.workspace === "none" && !merged.api) throw new Error(`成员 ${kind} 的 workspace=none 只适用于 API 执行方式。`);
		if (merged.api && merged.workspace === "none") merged.api.tools ??= [];
		if (!["code", "none"].includes(merged.workspace!)) throw new Error(`成员 ${kind} 的 workspace 需要 code 或 none。`);
		if (!Array.isArray(merged.models) || merged.models.some((m) => !m || typeof m.id !== "string" || !m.id.trim() || !["economy", "standard", "premium"].includes(m.tier))) throw new Error(`成员 ${kind} 的 models 需要有效模型 ID 和 tier。`);
		if (typeof merged.enabled !== "boolean" || typeof merged.description !== "string" || !Array.isArray(merged.extraArgs) || merged.extraArgs.some((arg) => typeof arg !== "string")) throw new Error(`成员 ${kind} 的开关、说明或附加参数无效。`);
		if (merged.defaultModel !== undefined && (typeof merged.defaultModel !== "string" || !merged.defaultModel.trim())) throw new Error(`成员 ${kind} 需要有效 defaultModel。`);
		if (!Number.isFinite(merged.timeoutMinutes) || merged.timeoutMinutes <= 0 || !Number.isSafeInteger(merged.maxOutputChars) || merged.maxOutputChars < 1) throw new Error(`成员 ${kind} 的超时和结果长度需要为正数。`);
		if (merged.api) {
			const api = merged.api;
			validateBusinessTools(api.httpTools);
			if (api.credential !== undefined && (typeof api.credential !== "string" || !/^local-[a-f0-9-]{36}$/.test(api.credential))) throw new Error(`成员 ${kind} 的本机凭据引用无效。`);
			if (!["openai-compatible", "anthropic-compatible"].includes(api.type) || !["off", "allowlist", "all"].includes(api.bash)) throw new Error(`成员 ${kind} 的 API 协议或 bash 配置无效。`);
			if (!Array.isArray(api.apiKeyEnv) || api.apiKeyEnv.some((key) => typeof key !== "string" || !key.trim()) || !Array.isArray(api.bashAllow) || api.bashAllow.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`成员 ${kind} 的 API 凭据与命令白名单需要字符串数组。`);
			for (const [name, value] of [["maxTurns", api.maxTurns], ["maxTokens", api.maxTokens], ["contextWindow", api.contextWindow]] as const) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`成员 ${kind} 的 api.${name} 需要正整数。`);
			if (api.tools !== undefined && (!Array.isArray(api.tools) || api.tools.some((name) => !["read", "write", "edit", "bash"].includes(name)))) throw new Error(`成员 ${kind} 的 api.tools 无效。`);
			let url: URL; try { url = new URL(api.baseUrl); } catch { throw new Error(`成员 ${kind} 需要有效的 api.baseUrl。`); }
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`成员 ${kind} 的 api.baseUrl 需要 HTTP(S) 地址且不包含凭据。`);
		}
		// 兼容旧配置：extraArgs 里写死的 -m/--model 当作默认模型
		const { rest, model } = splitModelArgs(kind, merged.extraArgs);
		merged.extraArgs = rest;
		merged.defaultModel ??= model;
		if (merged.api) merged.defaultModel ??= merged.models[0]?.id;
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
		autonomy: { ...DEFAULTS.autonomy, ...(raw.autonomy ?? {}) },
		lead: { ...DEFAULTS.lead, ...(raw.lead ?? {}) },
		roles: raw.roles ?? (Object.values(agents).some((member) => member.enabled && member.workspace !== "none") ? DEFAULTS.roles : []),
		web: { ...DEFAULTS.web, ...(raw.web ?? {}) },
	};
	if (config.collaboration && typeof config.collaboration.instructions !== "string") throw new Error("collaboration.instructions 需要为字符串。");
	for (const [id, member] of Object.entries(agents)) {
		if ((member.name !== undefined && (typeof member.name !== "string" || !member.name.trim())) || (member.instructions !== undefined && typeof member.instructions !== "string")) throw new Error(`成员 ${id} 的名称与指令需要为有效字符串。`);
	}
	if (!Array.isArray(config.roles) || config.roles.some((role) => !role || !role.name || !Object.hasOwn(agents, role.agent) || (role.fallback !== undefined && (!Array.isArray(role.fallback) || role.fallback.some((id) => !Object.hasOwn(agents, id)))))) throw new Error("roles 必须引用已配置的成员 ID。");
	config.workdir = isAbsolute(config.workdir) ? config.workdir : resolve(base, config.workdir);
	if (config.orchestrator.credential !== undefined && (typeof config.orchestrator.credential !== "string" || !/^local-[a-f0-9-]{36}$/.test(config.orchestrator.credential))) throw new Error("总控的本机凭据引用无效。");
	if (config.orchestrator.modelIds !== undefined && (!Array.isArray(config.orchestrator.modelIds) || config.orchestrator.modelIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200))) throw new Error("orchestrator.modelIds 需要是非空模型 ID 的数组。");
	if (config.orchestrator.discoverModels !== undefined && typeof config.orchestrator.discoverModels !== "boolean") throw new Error("orchestrator.discoverModels 需要为布尔值。");
	config.storage = isAbsolute(config.storage) ? config.storage : resolve(base, config.storage);
	if (!Number.isInteger(config.autonomy.maxRepairAttempts) || config.autonomy.maxRepairAttempts < 0 || config.autonomy.maxRepairAttempts > 3) throw new Error("autonomy.maxRepairAttempts 需要是 0–3 的整数。");
	if (!Number.isInteger(config.autonomy.resultMaxChars) || config.autonomy.resultMaxChars < 500 || config.autonomy.resultMaxChars > 20_000) throw new Error("autonomy.resultMaxChars 需要是 500–20000 的整数。");
	for (const check of config.autonomy.checks) {
		if (!check.name || !check.command || !Array.isArray(check.args) || check.args.some((a) => typeof a !== "string")) throw new Error("autonomy.checks 需要 name、command 和 args 字符串数组。");
		if (check.timeoutSeconds !== undefined && (!Number.isFinite(check.timeoutSeconds) || check.timeoutSeconds <= 0 || check.timeoutSeconds > 1800)) throw new Error("验收超时需要大于 0 且不超过 1800 秒。");
	}
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

const NPM_PACKAGES: Partial<Record<AgentKind, { pkg: string; bin: string }>> = {
	claude: { pkg: "@anthropic-ai/claude-code", bin: "claude" },
	codex: { pkg: "@openai/codex", bin: "codex" },
	gemini: { pkg: "@google/gemini-cli", bin: "gemini" },
};

/** 返回 [可执行文件, ...前置参数]；找不到返回 undefined */
export function resolveCommand(kind: AgentKind, agent: AgentConfig): string[] | undefined {
	if (agent.api) return undefined; // API 成员不需要 CLI
	if (agent.command && agent.command.length > 0) return agent.command;
	const npm = NPM_PACKAGES[kind];
	if (!npm) return undefined;
	const root = npmGlobalRoot();
	if (!root) return undefined;
	const { pkg, bin } = npm;
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
