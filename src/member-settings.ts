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
	const apiFields = async (previous?: OrchestratorConfig | AgentConfig["api"]) => {
		const type = await ask("API 协议：openai-compatible / anthropic-compatible", previous?.type === "builtin" ? "openai-compatible" : previous?.type ?? "openai-compatible");
		if (type !== "openai-compatible" && type !== "anthropic-compatible") throw new Error("协议需要 openai-compatible 或 anthropic-compatible。");
		const baseUrl = await ask("API 服务地址", previous?.baseUrl);
		let url: URL; try { url = new URL(baseUrl); } catch { throw new Error("需要有效的 API 服务地址。"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("API 地址需要 HTTP(S)，且不包含凭据。");
		return { type: type as "openai-compatible" | "anthropic-compatible", baseUrl };
	};
	const credential = async (previous?: string) => {
		const secret = await host.question({ title: previous ? "API 密钥（隐藏输入；留空保留）" : "API 密钥（隐藏输入；留空使用环境变量）", secret: true });
		return secret.trim() ? saveCredential(secret) : previous;
	};
	if (command === "/setup") {
		const api = await apiFields(current.orchestrator);
		const modelId = await ask("总控模型 ID", current.orchestrator.modelId);
		if (!modelId) throw new Error("模型 ID 不能为空。");
		const local = await credential(current.orchestrator.credential);
		const next = draft.apply((raw) => { raw.orchestrator = { ...current.orchestrator, ...api, modelId, credential: local, ...(local ? { apiKeyFromClaudeSettings: false, apiKeyEnv: [] } : {}) }; });
		await host.commit(draft, next, true); host.log("总控配置已保存并生效，历史会话保留。"); return true;
	}
	if (!suppliedId && action !== "add") throw new Error(`/agent ${action} 需要成员 ID。`);
	const id = suppliedId ?? await ask("成员 ID（小写字母、数字、下划线）");
	if (!/^[a-z][a-z0-9_]{0,47}$/.test(id) || ["constructor", "prototype", "lead", "all", "orchestrator"].includes(id)) throw new Error("成员 ID 需要小写字母开头，只含小写字母、数字或下划线，且不是系统保留名。");
	if (extra.length && !(action === "model" && extra.length === 1)) throw new Error("参数过多；密钥请通过 /agent key <ID> 隐藏输入。");
	if (action === "add" && Object.hasOwn(current.agents, id)) throw new Error(`成员 ${id} 已存在，请使用 /agent edit ${id}。`);
	const previous = action === "add" ? undefined : exists(id);
	let member: AgentConfig;
	if (action === "add" || action === "edit") {
		if (previous && !previous.api) throw new Error("CLI 成员可用 enable / disable / model 管理；edit 向导用于 API 成员。");
		const name = await ask("成员名称", previous?.name ?? id);
		const description = await ask("成员职责", previous?.description ?? name);
		const instructions = await ask("专属指令（- 清空）", previous?.instructions ?? "");
		const api = await apiFields(previous?.api);
		const modelId = await ask("默认模型 ID", previous?.defaultModel);
		if (!modelId) throw new Error("模型 ID 不能为空。");
		const workspace = await ask("工作区：none / code", previous?.workspace ?? "none");
		const tools = (await ask("工具权限：none 或 read,write,edit,bash", previous?.api ? memberToolNames(previous.api).join(",") || "none" : "none")).split(",").map((value) => value.trim()).filter((value) => value && value !== "none");
		if (tools.some((tool) => !["read", "write", "edit", "bash"].includes(tool))) throw new Error("工具权限无效。");
		const bash = tools.includes("bash") ? "allowlist" : "off";
		const bashAllow = bash === "allowlist" ? (await ask("允许的命令前缀（逗号分隔）", previous?.api?.bashAllow.join(","))).split(",").map((value) => value.trim()).filter(Boolean) : [];
		member = { enabled: previous?.enabled ?? true, extraArgs: [], timeoutMinutes: 30, maxOutputChars: 4000, ...previous, name, description, instructions: instructions === "-" ? "" : instructions, workspace: workspace as "none" | "code", defaultModel: modelId, models: previous?.models.some((model) => model.id === modelId) ? previous.models : [...previous?.models ?? [], { id: modelId, tier: "standard" }],
			api: { apiKeyEnv: [], ...previous?.api, ...api, tools: tools as NonNullable<AgentConfig["api"]>["tools"], bash, bashAllow } };
		// Validate everything except optional credentials before writing a local secret.
		normalizeConfig({ ...current, agents: { ...current.agents, [id]: member } }, host.path);
		member.api!.credential = await credential(previous?.api?.credential);
		if (member.api!.credential) member.api!.apiKeyEnv = [];
	} else {
		member = structuredClone(previous!);
		if (action === "enable" || action === "disable") member.enabled = action === "enable";
		if (action === "model") {
			const id = extra[0] ?? await ask("默认模型 ID", member.defaultModel);
			if (!id) throw new Error("模型 ID 不能为空。"); member.defaultModel = id;
			if (!member.models.some((model) => model.id === id)) member.models.push({ id, tier: "standard" });
		}
		if (action === "key") {
			if (!member.api) throw new Error("CLI 成员使用自己的登录；此命令用于 API 成员。");
			member.api.credential = await credential(member.api.credential);
			if (member.api.credential) member.api.apiKeyEnv = [];
		}
	}
	const next = draft.apply((raw) => { raw.agents = { ...raw.agents, [id]: member }; });
	await host.commit(draft, next, false);
	host.log(`成员 ${member.name ?? id}（${id}）配置已保存并生效；已有会话和结果保留。`);
	return true;
}
