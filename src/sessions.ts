// 每个顶层会话独占 SQLite、分工表和改动登记；项目源码通过已有 worktree 隔离。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "./config.ts";

export interface SessionInfo {
	id: string;
	title: string;
	workdir: string;
	storage: string;
	createdAt: number;
}

export class SessionCatalog {
	readonly directory: string;
	private readonly base: AppConfig;
	constructor(base: AppConfig) {
		this.base = base;
		this.directory = `${base.storage}.sessions`;
	}

	get(id: string): SessionInfo {
		this.validate(id);
		if (id === "default") {
			let title = "默认会话";
			try { title = (JSON.parse(readFileSync(join(this.directory, "default.json"), "utf8")) as { title: string }).title || title; } catch {}
			const createdAt = existsSync(this.base.storage) ? statSync(this.base.storage).birthtimeMs : 0;
			return { id, title, workdir: this.base.workdir, storage: this.base.storage, createdAt };
		}
		const file = join(this.directory, id, "session.json");
		if (!existsSync(file)) throw new Error(`没有会话 ${id}；用 /session new ${id} 新建。`);
		const info = JSON.parse(readFileSync(file, "utf8")) as SessionInfo;
		return { ...info, id, storage: join(this.directory, id, "session.sqlite") };
	}

	list(): SessionInfo[] {
		const result = [this.get("default")];
		if (!existsSync(this.directory)) return result;
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try { result.push(this.get(entry.name)); } catch { /* 忽略损坏或半写入的目录。 */ }
		}
		return result.sort((a, b) => a.createdAt - b.createdAt);
	}

	create(id: string, workdir = this.base.workdir): SessionInfo {
		this.validate(id);
		if (id === "default" || existsSync(join(this.directory, id))) throw new Error(`会话 ${id} 已存在。`);
		const cwd = isAbsolute(workdir) ? resolve(workdir) : resolve(this.base.workdir, workdir);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`项目目录不存在：${cwd}`);
		mkdirSync(this.directory, { recursive: true });
		const directory = join(this.directory, id);
		mkdirSync(directory);
		const info = { id, title: id, workdir: cwd, storage: join(directory, "session.sqlite"), createdAt: Date.now() };
		writeFileSync(join(directory, "session.json"), JSON.stringify(info, null, 2));
		return info;
	}

	rename(id: string, title: string): void {
		if (!title.trim() || title.length > 120) throw new Error("标题需要 1–120 个字符。");
		const info = this.get(id);
		mkdirSync(this.directory, { recursive: true });
		const file = id === "default" ? join(this.directory, "default.json") : join(this.directory, id, "session.json");
		writeFileSync(`${file}.tmp`, JSON.stringify({ ...info, title: title.trim() }, null, 2));
		renameSync(`${file}.tmp`, file);
	}

	/** 只保存选中编号；不会 reset、覆盖或删除任何对话存储。 */
	select(id: string): void {
		this.get(id);
		mkdirSync(this.directory, { recursive: true });
		const file = join(this.directory, "selected.json");
		writeFileSync(`${file}.tmp`, JSON.stringify({ id }));
		renameSync(`${file}.tmp`, file);
	}

	selected(): string {
		try {
			const { id } = JSON.parse(readFileSync(join(this.directory, "selected.json"), "utf8")) as { id: string };
			return this.get(id).id;
		} catch { return "default"; }
	}

	config(id: string): AppConfig {
		const info = this.get(id);
		return {
			...structuredClone(this.base), workdir: info.workdir, storage: info.storage,
			...((process.platform === "win32" ? resolve(info.workdir).toLowerCase() !== resolve(this.base.workdir).toLowerCase() : resolve(info.workdir) !== resolve(this.base.workdir)) ? { autonomy: { ...structuredClone(this.base.autonomy), checks: [] } } : {}),
			...(id === "default" ? {} : { projectStateDir: join(dirname(info.storage), "project") }),
		};
	}

	private validate(id: string): void {
		if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)) {
			throw new Error("会话编号用 1–48 位小写字母、数字、短横线或下划线，且以字母或数字开头。");
		}
	}
}
