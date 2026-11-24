import type { HttpBusinessTool } from "./business-tools.ts";
import { normalizeConfig } from "./config.ts";
import { saveCredential } from "./credentials.ts";
import type { MemberSettingsHost } from "./member-settings.ts";
import { editSettings } from "./settings.ts";
import { callBusinessTool } from "./business-tools.ts";
import { randomUUID } from "node:crypto";

export const TOOL_HELP = [
	"/tool list <成员ID>  查看该成员的业务工具",
	"/tool add <成员ID> [工具ID]  引导接入 HTTP 业务工具",
	"/tool edit <成员ID> <工具ID>  修改业务工具",
	"/tool key <成员ID> <工具ID>  隐藏配置 Bearer 凭据",
	"/tool remove <成员ID> <工具ID>  移除工具授权，保留历史",
	"/tool test <成员ID> <工具ID>  填写参数并测试 GET 查询（真实请求，无模型调用）",
].join("\n");
export async function toolSettingsCommand(line: string, host: MemberSettingsHost): Promise<boolean> {
	const [, action = "help", memberId, suppliedId, ...extra] = line.trim().split(/\s+/);
	if (action === "help") { host.log(TOOL_HELP); return true; }
	const current = host.config();
	const member = memberId && Object.hasOwn(current.agents, memberId) ? current.agents[memberId] : undefined;
	if (!member?.api) throw new Error("请选择已配置的 API 成员：/tool add <成员ID>。");
	if (extra.length) throw new Error("参数过多；密钥需要在隐藏输入框填写。");
	const tools = structuredClone(member.api.httpTools ?? []);
	if (action === "list") {
		if (suppliedId) throw new Error("用法：/tool list <成员ID>");
		host.log(tools.length ? JSON.stringify(tools.map(({ auth, ...tool }) => ({ ...tool, auth: auth ? { env: auth.env, localCredential: !!auth.credential } : undefined })), null, 2) : "该成员尚未接入业务工具。"); return true;
	}
	if (action === "test") {
		const tool = tools.find((entry) => entry.id === suppliedId); if (!tool) throw new Error("工具不存在。");
		if (tool.method !== "GET") throw new Error("测试命令只运行 GET；POST 由正式派工记录操作意图并执行，避免测试产生重复业务操作。");
		await host.assertIdle();
		const args = JSON.parse(await host.question({ title: "GET 查询参数 JSON（将真实访问已配置接口，可能按服务规则计费）", value: "{}" }) || "{}");
		const result = await callBusinessTool(tool, args, AbortSignal.timeout(30000), randomUUID());
		host.log(JSON.stringify(result)); return true;
	}
	if (!["add", "edit", "remove", "key"].includes(action)) throw new Error(TOOL_HELP);
	await host.assertIdle();
	const draft = editSettings(host.path);
	const ask = async (title: string, value = "") => (await host.question({ title, value })).trim() || value;
	const id = suppliedId ?? (action === "add" ? await ask("工具 ID（小写字母、数字、下划线）") : "");
	const previous = tools.find((tool) => tool.id === id);
	if (action === "add" && previous) throw new Error("工具已存在，请用 /tool edit。");
	if (action !== "add" && !previous) throw new Error("找不到该成员的业务工具。");
	let tool: HttpBusinessTool | undefined;
	if (action === "add" || action === "edit") {
		const description = await ask("工具用途（供成员选择）", previous?.description);
		const url = await ask("固定 HTTP(S) 地址（不含查询参数或凭据）", previous?.url);
		const method = (await ask("方法：GET（查询）/ POST（外部操作）", previous?.method ?? "GET")).toUpperCase() as HttpBusinessTool["method"];
		let parameters: Record<string, unknown>;
		const schema = await ask("参数 JSON Schema（或填 fields 逐字段配置）", JSON.stringify(previous?.parameters ?? { type: "object", properties: {}, additionalProperties: false }));
		if (schema === "fields") {
			const properties: Record<string, unknown> = {}, required: string[] = [];
			for (let index = 0; index < 40; index++) {
				const name = await ask("字段名称（- 结束）", "-"); if (name === "-") break;
				if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || ["constructor", "prototype"].includes(name) || Object.hasOwn(properties, name)) throw new Error("字段名称无效或重复。");
				const type = await ask("字段类型 string / number / integer / boolean", "string"); if (!["string", "number", "integer", "boolean"].includes(type)) throw new Error("字段类型无效。");
				const description = await ask("字段说明", name); const mandatory = await ask("必填 yes / no", "yes"); if (!["yes", "no"].includes(mandatory)) throw new Error("请填写 yes 或 no。");
				properties[name] = { type, description }; if (mandatory === "yes") required.push(name);
			}
			parameters = { type: "object", properties, required, additionalProperties: false };
		} else try { parameters = JSON.parse(schema); } catch { throw new Error("参数需要有效的 JSON Schema 或 fields。"); }
		const header = method === "POST" ? await ask("服务支持的幂等请求头（不支持则填 -，不会自动重放）", previous?.idempotencyHeader ?? "-") : "-";
		tool = { ...previous, id, description, url, method, parameters };
		if (header === "-") delete tool.idempotencyHeader; else tool.idempotencyHeader = header;
	} else if (action === "key") tool = { ...previous! };
	if (tool) {
		const candidate = { ...member, api: { ...member.api, httpTools: [...tools.filter((item) => item.id !== id), tool] } };
		normalizeConfig({ ...current, agents: { ...current.agents, [memberId!]: candidate } }, host.path);
		const secret = await host.question({ title: "Bearer 密钥（隐藏输入；留空保留，无认证接口可留空）", secret: true });
		if (secret.trim()) tool.auth = { credential: saveCredential(secret) };
	}
	const next = draft.apply((raw) => { raw.agents = { ...raw.agents, [memberId!]: { ...member, api: { ...member.api!, httpTools: [...tools.filter((item) => item.id !== id), ...(tool ? [tool] : [])] } } }; });
	await host.commit(draft, next, false);
	host.log(`业务工具 ${id} 已${action === "remove" ? "移除" : "保存并授权给 " + memberId}；已有历史保留。`);
	return true;
}
