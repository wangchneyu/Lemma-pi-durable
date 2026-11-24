import { editSettings } from "./settings.ts";
import { applyLimitsDraft, type MemberSettingsHost } from "./member-settings.ts";

export const EXECUTION_HELP = "/limits  查看并发与预算；/limits edit 引导配置团队/成员/服务并发、每轮预算和每次派工预留";
export async function executionSettingsCommand(line: string, host: MemberSettingsHost): Promise<boolean> {
	const current = host.config();
	if (line.trim() === "/limits") { host.log(JSON.stringify({ execution: { maxConcurrent: 8, perMember: 4, perService: 8, ...current.execution }, budget: current.budget, note: "预留是用户估计；未知价格与用量不能当作零成本，非账单硬上限。并发与预留作用于当前工作会话数据库。" }, null, 2)); return true; }
	if (line.trim() !== "/limits edit") throw new Error(EXECUTION_HELP);
	await host.assertIdle(); const draft = editSettings(host.path);
	const askNumber = async (title: string, initial: number) => Number((await host.question({ title, value: String(initial) })).trim() || String(initial));
	const maxConcurrent = await askNumber("团队同时执行上限（1–64）", current.execution?.maxConcurrent ?? 8);
	const perMember = await askNumber("每个成员同时执行上限（1–64）", current.execution?.perMember ?? 4);
	const perService = await askNumber("同一服务地址同时执行上限（1–64）", current.execution?.perService ?? 8);
	const amount = (await host.question({ title: "每轮成员预算美元（unlimited 不限）", value: String(current.budget.perRunUsd ?? "unlimited") })).trim() || String(current.budget.perRunUsd ?? "unlimited");
	const reservePerDispatchUsd = await askNumber("每次成员派工预留美元（估计值，0 关闭预留）", current.budget.reservePerDispatchUsd ?? 0);
	const next = applyLimitsDraft(draft, current, { maxConcurrent, perMember, perService, perRunUsd: amount === "unlimited" ? null : Number(amount), reservePerDispatchUsd });
	await host.commit(draft, next, false); host.log("并发与预算配置已保存并生效；历史保持。"); return true;
}
