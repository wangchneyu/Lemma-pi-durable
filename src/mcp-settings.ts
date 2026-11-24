import { discoverMcp, validateMcpGrants } from "./mcp-tools.ts";
import type { MemberSettingsHost } from "./member-settings.ts";
import { editSettings } from "./settings.ts";
import { saveCredential } from "./credentials.ts";

export const MCP_HELP = "/mcp add|refresh|remove|list <成员ID> [连接ID] 发现并明确授权 MCP Streamable HTTP 只读工具（可选本机 Bearer 凭据）";
export async function mcpSettingsCommand(line: string, host: MemberSettingsHost): Promise<boolean> {
	const [, action, memberId, id, ...extra] = line.trim().split(/\s+/), current = host.config();
	if (!action) { host.log(MCP_HELP); return true; }
	const member = memberId && Object.hasOwn(current.agents, memberId) ? current.agents[memberId] : undefined; if (!member?.api || extra.length) throw new Error(MCP_HELP);
	const grants = structuredClone(member.api.mcpServers ?? []);
	if (action === "list") { host.log(JSON.stringify(grants.map(({ credential, ...grant }) => ({ ...grant, localCredential: !!credential })), null, 2)); return true; }
	if (!id || !["add", "refresh", "remove"].includes(action)) throw new Error(MCP_HELP);
	await host.assertIdle(); const draft = editSettings(host.path), old = grants.find((grant) => grant.id === id);
	if (action === "add" ? !!old : !old) throw new Error("连接已存在或找不到连接，请检查 ID。");
	let nextGrant = old;
	if (action !== "remove") {
		const url = old?.url ?? (await host.question({ title: "MCP Streamable HTTP 地址" })).trim();
		const secret = await host.question({ title: "MCP Bearer 密钥（隐藏输入；留空保留或无认证）", secret: true });
		const credential = secret.trim() ? saveCredential(secret) : old?.credential;
		const candidate = { id, url, ...(credential ? { credential } : {}), tools: [{ name: "validation", inputSchema: { type: "object", properties: {} } }] }; validateMcpGrants([candidate]);
		const catalog = await discoverMcp(candidate);
		host.log(catalog.map((tool) => `${tool.name} · ${tool.readOnly ? "只读" : "未声明只读，当前不支持授权"} · ${tool.description ?? ""}`).join("\n"));
		const selected = (await host.question({ title: "授权工具名（逗号分隔；仅选择可信的只读工具）", value: old?.tools.map((tool) => tool.name).join(",") })).trim() || old?.tools.map((tool) => tool.name).join(",") || "";
		const names = [...new Set(selected.split(",").map((name) => name.trim()).filter(Boolean))];
		const tools = names.map((name) => { const tool = catalog.find((tool) => tool.name === name); if (!tool?.readOnly) throw new Error("只能授权目录中明确声明只读的工具；声明本身不替代对服务的信任。"); const { readOnly, ...definition } = tool; return definition; });
		nextGrant = { id, url, ...(credential ? { credential } : {}), tools }; validateMcpGrants([nextGrant]);
	}
	const next = draft.apply((raw) => { raw.agents = { ...raw.agents, [memberId!]: { ...member, api: { ...member.api!, mcpServers: [...grants.filter((grant) => grant.id !== id), ...(action === "remove" ? [] : [nextGrant!])] } } }; });
	await host.commit(draft, next, false); host.log("MCP 成员授权已保存并生效，历史保持。"); return true;
}
