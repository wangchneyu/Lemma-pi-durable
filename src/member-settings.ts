import type { AgentConfig, AppConfig, OrchestratorConfig } from "./config.ts";
import { normalizeConfig } from "./config.ts";
import { editSettings, type SettingsDraft } from "./settings.ts";
import { saveCredential } from "./credentials.ts";
import { memberToolNames } from "./api-member.ts";
import { toolSettingsCommand, TOOL_HELP } from "./tool-settings.ts";
import { executionSettingsCommand, EXECUTION_HELP } from "./execution-settings.ts";
import { mcpSettingsCommand, MCP_HELP } from "./mcp-settings.ts";

export interface SettingQuestion { title: string; value?: string; secret?: boolean }
export interface MemberSettingsHost {
	path: string;
	config(): AppConfig;
	question(input: SettingQuestion): Promise<string>;
	assertIdle(): Promise<void>;
	commit(draft: SettingsDraft, next: AppConfig, controller: boolean): Promise<void>;
	log(message: string): void;
}
export const MEMBER_HELP = [
	"/agent add [ID]  添加 API 成员（引导配置）",
	"/agent edit <ID>  修改名称、职责、接口、模型与权限",
	"/agent show <ID>  查看配置与状态（不显示密钥）",
	"/agent enable|disable <ID>  启用或停用成员",
	"/agent model <ID> [模型ID]  修改默认模型",
	"/agent key <ID>  隐藏输入并保存本机凭据",
	"/setup  配置总控模型、API 地址与本机凭据",
	"/agents  查看全部成员；/members 查看已运行的成员会话",
	TOOL_HELP,
	EXECUTION_HELP,
	MCP_HELP,
].join("\n");

export interface ApiMemberInput {
	mode: "add" | "edit";
	id: string;
	name?: string;
	description?: string;
	instructions?: string;
	enabled?: boolean;
	workspace?: "none" | "code";
	type?: string;
	baseUrl?: string;
	defaultModel?: string;
	tools?: string[];
	bashAllow?: string[];
	secret?: string;
}

export interface QuickMemberPatch {
	enabled?: boolean;
	defaultModel?: string;
	secret?: string;
}

export interface LimitsInput {
	maxConcurrent?: number;
	perMember?: number;
	perService?: number;
	perRunUsd?: number | null;
	reservePerDispatchUsd?: number;
}

export interface OrchestratorInput {
	type: string;
	baseUrl: string;
	modelId: string;
	secret?: string;
}

const RESERVED_IDS = new Set(["constructor", "prototype", "lead", "all", "orchestrator"]);

export function validateMemberId(id: string): string {
	const trimmed = id.trim();
	if (!/^[a-z][a-z0-9_]{0,47}$/.test(trimmed) || RESERVED_IDS.has(trimmed)) {
		throw new Error("成员 ID 需要小写字母开头，只含小写字母、数字或下划线，且不是系统保留名。");
	}
	return trimmed;
}

export function validateApiEndpoint(type: string, baseUrl: string): { type: "openai-compatible" | "anthropic-compatible"; baseUrl: string } {
	if (type !== "openai-compatible" && type !== "anthropic-compatible") throw new Error("协议需要 openai-compatible 或 anthropic-compatible。");
	let url: URL;
	try { url = new URL(baseUrl.trim()); } catch { throw new Error("需要有效的 API 服务地址。"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("API 地址需要 HTTP(S)，且不包含凭据。");
	return { type, baseUrl: baseUrl.trim() };
}

export function applyLimitsDraft(draft: SettingsDraft, current: AppConfig, input: LimitsInput): AppConfig {
	const execution = {
		maxConcurrent: input.maxConcurrent ?? current.execution?.maxConcurrent ?? 8,
		perMember: input.perMember ?? current.execution?.perMember ?? 4,
		perService: input.perService ?? current.execution?.perService ?? 8,
	};
	const perRunUsd = input.perRunUsd === undefined ? current.budget.perRunUsd : input.perRunUsd;
	const reservePerDispatchUsd = input.reservePerDispatchUsd ?? current.budget.reservePerDispatchUsd ?? 0;
	return draft.apply((raw) => {
		raw.execution = execution;
		raw.budget = { ...current.budget, perRunUsd, reservePerDispatchUsd };
	});
}

export function applyOrchestratorDraft(draft: SettingsDraft, current: AppConfig, input: OrchestratorInput): AppConfig {
	const api = validateApiEndpoint(input.type, input.baseUrl);
	const modelId = input.modelId.trim();
	if (!modelId) throw new Error("模型 ID 不能为空。");
	const secret = input.secret?.trim();
	const local = secret ? saveCredential(secret) : current.orchestrator.credential;
	return draft.apply((raw) => {
		raw.orchestrator = { ...current.orchestrator, ...api, modelId, credential: local, ...(local ? { apiKeyFromClaudeSettings: false, apiKeyEnv: [] } : {}) };
	});
}

export function applyApiMemberDraft(draft: SettingsDraft, path: string, current: AppConfig, input: ApiMemberInput): { next: AppConfig; member: AgentConfig; id: string } {
	const id = validateMemberId(input.id);
	const exists = Object.hasOwn(current.agents, id);
	if (input.mode === "add" && exists) throw new Error(`成员 ${id} 已存在，请使用 /agent edit ${id}。`);
	if (input.mode === "edit" && !exists) throw new Error(`没有成员 ${id}；/agents 查看成员。`);
	const previous = exists ? current.agents[id] : undefined;
	if (previous && !previous.api) throw new Error("CLI 成员可用 enable / disable / model 管理；edit 向导用于 API 成员。");

	const name = (input.name ?? previous?.name ?? id).trim() || id;
	const description = (input.description ?? previous?.description ?? name).trim() || name;
	const rawInstructions = input.instructions ?? previous?.instructions ?? "";
	const instructions = rawInstructions === "-" ? "" : rawInstructions;
	const api = validateApiEndpoint(input.type ?? (previous?.api?.type ?? "openai-compatible"), input.baseUrl ?? (previous?.api?.baseUrl ?? ""));
	const modelId = (input.defaultModel ?? previous?.defaultModel ?? "").trim();
	if (!modelId) throw new Error("模型 ID 不能为空。");
	const workspace = (input.workspace ?? previous?.workspace ?? "none") as "none" | "code";
	const rawTools = input.tools ?? (previous?.api ? memberToolNames(previous.api) : []);
	const tools = rawTools.map((value) => value.trim()).filter((value) => value && value !== "none");
	if (tools.some((tool) => !["read", "write", "edit", "bash"].includes(tool))) throw new Error("工具权限无效。");
	const bash = tools.includes("bash") ? "allowlist" : "off";
	const bashAllow = bash === "allowlist" ? (input.bashAllow ?? previous?.api?.bashAllow ?? []).map((value) => value.trim()).filter(Boolean) : [];
	const member: AgentConfig = {
		enabled: input.enabled ?? previous?.enabled ?? true,
		extraArgs: [],
		timeoutMinutes: 30,
		maxOutputChars: 4000,
		...previous,
		name,
		description,
		instructions,
		workspace,
		defaultModel: modelId,
		models: previous?.models.some((model) => model.id === modelId) ? previous.models : [...previous?.models ?? [], { id: modelId, tier: "standard" }],
		api: { apiKeyEnv: [], ...previous?.api, ...api, tools: tools as NonNullable<AgentConfig["api"]>["tools"], bash, bashAllow },
	};
	// Validate everything except optional credentials before writing a local secret.
	normalizeConfig({ ...current, agents: { ...current.agents, [id]: member } }, path);
	const secret = input.secret?.trim();
	member.api!.credential = secret ? saveCredential(secret) : previous?.api?.credential;
	if (member.api!.credential && secret) member.api!.apiKeyEnv = [];
	const next = draft.apply((raw) => { raw.agents = { ...raw.agents, [id]: member }; });
	return { next, member, id };
}

export function applyQuickMemberDraft(draft: SettingsDraft, current: AppConfig, id: string, patch: QuickMemberPatch): { next: AppConfig; member: AgentConfig } {
	validateMemberId(id);
	if (!Object.hasOwn(current.agents, id)) throw new Error(`没有成员 ${id}；/agents 查看成员。`);
	const member = structuredClone(current.agents[id]!);
	if (patch.enabled !== undefined) member.enabled = patch.enabled;
	if (patch.defaultModel !== undefined) {
		const modelId = patch.defaultModel.trim();
		if (!modelId) throw new Error("模型 ID 不能为空。");
		member.defaultModel = modelId;
		if (!member.models.some((model) => model.id === modelId)) member.models.push({ id: modelId, tier: "standard" });
	}
	if (patch.secret !== undefined && patch.secret.trim()) {
		if (!member.api) throw new Error("CLI 成员使用自己的登录；密钥配置仅用于 API 成员。");
		member.api.credential = saveCredential(patch.secret.trim());
		member.api.apiKeyEnv = [];
	}
	const next = draft.apply((raw) => { raw.agents = { ...raw.agents, [id]: member }; });
	return { next, member };
}

export async function memberSettingsCommand(line: string, host: MemberSettingsHost): Promise<boolean> {
	if (/^\/mcp(?:\s|$)/.test(line)) return mcpSettingsCommand(line, host);
	if (/^\/limits(?:\s|$)/.test(line)) return executionSettingsCommand(line, host);
	if (/^\/tool(?:\s|$)/.test(line)) return toolSettingsCommand(line, host);
	if (!/^\/(?:agent|setup)(?:\s|$)/.test(line)) return false;
	const [command, action = "help", suppliedId, ...extra] = line.trim().split(/\s+/);
	if (command === "/agent" && ["help", "list"].includes(action)) { host.log(MEMBER_HELP); return true; }
	if (command === "/setup" && line.trim() !== "/setup") throw new Error("用法：/setup（按引导配置总控）");
	const current = host.config();
	const exists = (id: string) => {
		if (!Object.hasOwn(current.agents, id)) throw new Error(`没有成员 ${id}；/agents 查看成员。`);
		return current.agents[id]!;
	};
	if (command === "/agent" && action === "show") {
		if (!suppliedId || extra.length) throw new Error("用法：/agent show <ID>");
		const member = exists(suppliedId);
		host.log(JSON.stringify({ id: suppliedId, name: member.name ?? suppliedId, enabled: member.enabled, description: member.description, instructions: member.instructions, workspace: member.workspace, model: member.defaultModel, models: member.models, api: member.api ? { type: member.api.type, baseUrl: member.api.baseUrl, tools: member.api.tools, apiKeyEnv: member.api.apiKeyEnv, localCredential: !!member.api.credential } : undefined }, null, 2));
		return true;
	}
	if (command === "/agent" && !["add", "edit", "enable", "disable", "model", "key"].includes(action)) throw new Error(MEMBER_HELP);
	await host.assertIdle();
	const draft = editSettings(host.path);
	const ask = async (title: string, value?: string, secret = false) => {
		const result = await host.question({ title, value, secret });
		return result.trim() || value || "";
	};
	const askEndpoint = async (previous?: OrchestratorConfig | AgentConfig["api"]) => validateApiEndpoint(
		await ask("API 协议：openai-compatible / anthropic-compatible", previous?.type === "builtin" ? "openai-compatible" : previous?.type ?? "openai-compatible"),
		await ask("API 服务地址", previous?.baseUrl),
	);
	const askSecret = async (hasExisting: boolean) => (await host.question({ title: hasExisting ? "API 密钥（隐藏输入；留空保留）" : "API 密钥（隐藏输入；留空使用环境变量）", secret: true })).trim();
	if (command === "/setup") {
		const api = await askEndpoint(current.orchestrator);
		const modelId = await ask("总控模型 ID", current.orchestrator.modelId);
		if (!modelId) throw new Error("模型 ID 不能为空。");
		const secret = await askSecret(!!current.orchestrator.credential);
		const next = applyOrchestratorDraft(draft, current, { ...api, modelId, secret });
		await host.commit(draft, next, true); host.log("总控配置已保存并生效，历史会话保留。"); return true;
	}
	if (!suppliedId && action !== "add") throw new Error(`/agent ${action} 需要成员 ID。`);
	const id = validateMemberId(suppliedId ?? await ask("成员 ID（小写字母、数字、下划线）"));
	if (extra.length && !(action === "model" && extra.length === 1)) throw new Error("参数过多；密钥请通过 /agent key <ID> 隐藏输入。");
	if (action === "add" && Object.hasOwn(current.agents, id)) throw new Error(`成员 ${id} 已存在，请使用 /agent edit ${id}。`);
	const previous = action === "add" ? undefined : exists(id);
	let result: { next: AppConfig; member: AgentConfig };
	if (action === "add" || action === "edit") {
		if (previous && !previous.api) throw new Error("CLI 成员可用 enable / disable / model 管理；edit 向导用于 API 成员。");
		const name = await ask("成员名称", previous?.name ?? id);
		const description = await ask("成员职责", previous?.description ?? name);
		const instructions = await ask("专属指令（- 清空）", previous?.instructions ?? "");
		const api = await askEndpoint(previous?.api);
		const modelId = await ask("默认模型 ID", previous?.defaultModel);
		if (!modelId) throw new Error("模型 ID 不能为空。");
		const workspace = await ask("工作区：none / code", previous?.workspace ?? "none") as "none" | "code";
		const tools = (await ask("工具权限：none 或 read,write,edit,bash", previous?.api ? memberToolNames(previous.api).join(",") || "none" : "none")).split(",").map((value) => value.trim()).filter((value) => value && value !== "none");
		if (tools.some((tool) => !["read", "write", "edit", "bash"].includes(tool))) throw new Error("工具权限无效。");
		const bashAllow = tools.includes("bash") ? (await ask("允许的命令前缀（逗号分隔）", previous?.api?.bashAllow.join(","))).split(",").map((value) => value.trim()).filter(Boolean) : [];
		// Validate everything before asking optional credential so invalid settings fail early.
		const probe = editSettings(host.path);
		applyApiMemberDraft(probe, host.path, current, { mode: action, id, name, description, instructions, workspace, ...api, defaultModel: modelId, tools, bashAllow });
		const secret = await askSecret(!!previous?.api?.credential);
		result = applyApiMemberDraft(draft, host.path, current, { mode: action, id, name, description, instructions, workspace, ...api, defaultModel: modelId, tools, bashAllow, secret });
	} else {
		if (action === "key" && !previous!.api) throw new Error("CLI 成员使用自己的登录；此命令用于 API 成员。");
		const patch: QuickMemberPatch = {};
		if (action === "enable" || action === "disable") patch.enabled = action === "enable";
		if (action === "model") patch.defaultModel = extra[0] ?? await ask("默认模型 ID", previous!.defaultModel);
		if (action === "key") patch.secret = await askSecret(!!previous!.api?.credential);
		result = applyQuickMemberDraft(draft, current, id, patch);
	}
	await host.commit(draft, result.next, false);
	host.log(`成员 ${result.member.name ?? id}（${id}）配置已保存并生效；已有会话和结果保留。`);
	return true;
}
