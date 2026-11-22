import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { normalizeConfig, type AppConfig } from "./config.ts";

export interface SettingsDraft {
	raw: Partial<AppConfig>;
	apply(change: (raw: Partial<AppConfig>) => void): AppConfig;
	save(): void;
}
/** Optimistic, atomic config update; preserve unknown fields and never overwrite external edits. */
export function editSettings(path: string): SettingsDraft {
	const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	let raw: Partial<AppConfig>;
	try { raw = before === undefined ? {} : JSON.parse(before); } catch { throw new Error("配置 JSON 无效，未修改原文件。"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("配置需要对象，未修改原文件。");
	return { raw, apply(change) { change(raw); return normalizeConfig(raw, path); }, save() {
		normalizeConfig(raw, path);
		const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		if (current !== before) throw new Error("配置在编辑期间已被其他操作修改，请重新执行命令；未覆盖外部改动。");
		const temporary = `${path}.${randomUUID()}.tmp`;
		try { writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" }); renameSync(temporary, path); }
		finally { rmSync(temporary, { force: true }); }
	} };
}
