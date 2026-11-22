import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** Local machine secrets, outside conversation storage and versioned project config. */
export const credentialPath = () => process.env.LEMMA_CREDENTIALS_FILE ?? join(homedir(), ".lemma", "credentials.json");
function read(): Record<string, string> {
	const path = credentialPath();
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((secret) => typeof secret !== "string")) throw new Error();
		return value as Record<string, string>;
	} catch { throw new Error("本机凭据文件无法读取，请检查文件内容与权限；原文件未改动。"); }
}
export function readCredential(id?: string): string | undefined {
	if (!id) return undefined;
	const credentials = read();
	return Object.hasOwn(credentials, id) ? credentials[id] : undefined;
}
export function saveCredential(secret: string): string {
	if (!secret.trim() || /[\r\n]/.test(secret)) throw new Error("API 密钥需要为非空单行文本。");
	const credentials = read();
	const id = `local-${randomUUID()}`; credentials[id] = secret.trim();
	const path = credentialPath(), temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, 0o600); renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); }
	return id;
}
