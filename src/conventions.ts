// Agent 规范文件的统一管理：扫描各家 CLI 的规范 / 配置文件（项目级 + 用户级），按"哪个成员会读到"归类，
// 做一致性检查，并把一份共同规则（.pi-agent/RULES.md）同步进各家的说明文件。
// 只读白名单里的文件；设置文件里的密钥一律打码。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export type Owner = "claude" | "codex" | "gemini" | "shared" | "pi-agent";
export type Kind = "instructions" | "settings" | "subagent" | "command" | "skill" | "mcp" | "project";

export interface ConventionFile {
	/** 稳定的编号（作用域 + 相对路径），网页按编号取内容，不接受任意路径 */
	id: string;
	scope: "project" | "user";
	owner: Owner;
	kind: Kind;
	/** 相对作用域根目录的路径，如 .claude/agents/reviewer.md */
	rel: string;
	path: string;
	size: number;
	mtime: number;
	/** 技能 / 子 agent / 命令的名字和说明（来自 frontmatter） */
	name?: string;
	description?: string;
	/** 这份说明文件里共同规则段落的状态 */
	rules?: "synced" | "stale" | "missing";
}

interface Pattern {
	owner: Owner;
	kind: Kind;
	/** 单个文件 */
	file?: string;
	/** 目录下按规则找文件 */
	dir?: string;
	match?: RegExp;
	depth?: number;
	scopes: ("project" | "user")[];
}

/** 各家约定的位置（用户级的路径相对用户目录） */
const PATTERNS: Pattern[] = [
	// Claude Code
	{ owner: "claude", kind: "instructions", file: "CLAUDE.md", scopes: ["project"] },
	{ owner: "claude", kind: "instructions", file: "CLAUDE.local.md", scopes: ["project"] },
	{ owner: "claude", kind: "instructions", file: ".claude/CLAUDE.md", scopes: ["project", "user"] },
	{ owner: "claude", kind: "settings", file: ".claude/settings.json", scopes: ["project", "user"] },
	{ owner: "claude", kind: "settings", file: ".claude/settings.local.json", scopes: ["project", "user"] },
	{ owner: "claude", kind: "subagent", dir: ".claude/agents", match: /\.md$/i, depth: 2, scopes: ["project", "user"] },
	{ owner: "claude", kind: "command", dir: ".claude/commands", match: /\.md$/i, depth: 3, scopes: ["project", "user"] },
	{ owner: "claude", kind: "skill", dir: ".claude/skills", match: /^SKILL\.md$/i, depth: 3, scopes: ["project", "user"] },
	{ owner: "claude", kind: "mcp", file: ".mcp.json", scopes: ["project"] },
	// Codex
	{ owner: "codex", kind: "instructions", file: "AGENTS.md", scopes: ["project"] },
	{ owner: "codex", kind: "instructions", file: "AGENTS.override.md", scopes: ["project"] },
	{ owner: "codex", kind: "instructions", file: ".codex/AGENTS.md", scopes: ["user"] },
	{ owner: "codex", kind: "settings", file: ".codex/config.toml", scopes: ["project", "user"] },
	{ owner: "codex", kind: "command", dir: ".codex/prompts", match: /\.md$/i, depth: 2, scopes: ["user"] },
	{ owner: "codex", kind: "skill", dir: ".codex/skills", match: /^SKILL\.md$/i, depth: 4, scopes: ["project", "user"] },
	// Gemini CLI
	{ owner: "gemini", kind: "instructions", file: "GEMINI.md", scopes: ["project"] },
	{ owner: "gemini", kind: "instructions", file: ".gemini/GEMINI.md", scopes: ["user"] },
	{ owner: "gemini", kind: "settings", file: ".gemini/settings.json", scopes: ["project", "user"] },
	{ owner: "gemini", kind: "command", dir: ".gemini/commands", match: /\.toml$/i, depth: 3, scopes: ["project", "user"] },
	// 通用 / 其他工具
	{ owner: "shared", kind: "skill", dir: ".agents/skills", match: /^SKILL\.md$/i, depth: 3, scopes: ["project", "user"] },
	{ owner: "shared", kind: "instructions", dir: ".agent", match: /\.md$/i, depth: 2, scopes: ["project"] },
	{ owner: "shared", kind: "instructions", dir: ".cursor/rules", match: /\.(md|mdc)$/i, depth: 2, scopes: ["project"] },
	{ owner: "shared", kind: "instructions", file: ".github/copilot-instructions.md", scopes: ["project"] },
	// pi-agent 自己
	{ owner: "pi-agent", kind: "project", file: ".pi-agent/RULES.md", scopes: ["project"] },
	{ owner: "pi-agent", kind: "project", file: ".pi-agent/GOAL.md", scopes: ["project"] },
	{ owner: "pi-agent", kind: "project", file: ".pi-agent/ASSIGN.md", scopes: ["project"] },
];

/** 共同规则要同步进的项目级说明文件：每个成员读的那一份 */
export const SYNC_TARGETS: { owner: Exclude<Owner, "shared" | "pi-agent">; file: string }[] = [
	{ owner: "claude", file: "CLAUDE.md" },
	{ owner: "codex", file: "AGENTS.md" },
	{ owner: "gemini", file: "GEMINI.md" },
];
/** 建 worktree 时要带过去的规范文件（新建、还没提交的也要让成员看到） */
export const WORKTREE_CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".pi-agent/RULES.md"];

const BEGIN = /<!-- pi-agent:rules hash=([0-9a-f]+) -->/;
const END = "<!-- /pi-agent:rules -->";
const MAX_READ = 200_000;

function walk(dir: string, match: RegExp, depth: number, out: string[] = []): string[] {
	if (depth < 0 || !existsSync(dir)) return out;
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, match, depth - 1, out);
		else if (match.test(e.name)) out.push(p);
	}
	return out;
}

/** frontmatter 里的 name / description（技能、子 agent、命令） */
function frontmatter(path: string): { name?: string; description?: string } {
	try {
		const head = readFileSync(path, "utf8").slice(0, 4000);
		const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1];
		return { name: get("name"), description: get("description")?.slice(0, 200) };
	} catch {
		return {};
	}
}

function rulesHash(rules: string): string {
	return createHash("sha1").update(rules.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 10);
}

export interface Scan {
	project: string;
	home: string;
	files: ConventionFile[];
	rules: { path: string; exists: boolean; hash?: string };
	members: Record<"claude" | "codex" | "gemini", { instructions: ConventionFile[]; settings: ConventionFile[]; subagents: number; commands: number; skills: number }>;
	checks: Check[];
}

export interface Check {
	level: "warn" | "info" | "ok";
	title: string;
	detail?: string;
	files?: string[];
}

export function scanConventions(project: string, home = homedir()): Scan {
	const files: ConventionFile[] = [];
	const seen = new Set<string>();
	for (const p of PATTERNS) {
		for (const scope of p.scopes) {
			const root = scope === "project" ? project : home;
			const paths = p.file ? [join(root, p.file)].filter((f) => existsSync(f) && statSync(f).isFile()) : walk(join(root, p.dir!), p.match!, p.depth ?? 2);
			for (const path of paths) {
				const key = path.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				const st = statSync(path);
				const rel = relative(root, path).replace(/\\/g, "/");
				const meta = p.kind === "skill" || p.kind === "subagent" || p.kind === "command" ? frontmatter(path) : {};
				files.push({
					id: `${scope}:${rel}`,
					scope,
					owner: p.owner,
					kind: p.kind,
					rel,
					path,
					size: st.size,
					mtime: st.mtimeMs,
					name: meta.name ?? (p.kind === "skill" ? basename(dirname(path)) : p.kind === "subagent" || p.kind === "command" ? basename(path).replace(/\.(md|toml)$/i, "") : undefined),
					description: meta.description,
				});
			}
		}
	}

	// 共同规则：各成员项目级说明文件里的同步状态
	const rulesPath = join(project, ".pi-agent", "RULES.md");
	const rulesText = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : undefined;
	const hash = rulesText?.trim() ? rulesHash(rulesText) : undefined;
	for (const t of SYNC_TARGETS) {
		const f = files.find((x) => x.scope === "project" && x.rel === t.file);
		if (!f || !hash) continue;
		const m = readFileSync(f.path, "utf8").match(BEGIN);
		f.rules = !m ? "missing" : m[1] === hash ? "synced" : "stale";
	}

	const members = Object.fromEntries(
		(["claude", "codex", "gemini"] as const).map((k) => {
			const mine = files.filter((f) => f.owner === k || (f.owner === "shared" && f.kind === "skill" && k === "codex"));
			return [
				k,
				{
					instructions: files.filter((f) => f.owner === k && f.kind === "instructions"),
					settings: files.filter((f) => f.owner === k && (f.kind === "settings" || f.kind === "mcp")),
					subagents: mine.filter((f) => f.kind === "subagent").length,
					commands: mine.filter((f) => f.kind === "command").length,
					skills: files.filter((f) => f.owner === k && f.kind === "skill").length,
				},
			];
		}),
	) as Scan["members"];

	return { project, home, files, rules: { path: rulesPath, exists: !!rulesText, hash }, members, checks: runChecks(files, members, hash) };
}

const PKG_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

function runChecks(files: ConventionFile[], members: Scan["members"], rulesHashValue: string | undefined): Check[] {
	const checks: Check[] = [];
	const label = { claude: "Claude", codex: "Codex", gemini: "Gemini" } as const;
	// 1. 成员缺少项目级说明
	for (const t of SYNC_TARGETS) {
		const has = members[t.owner].instructions.some((f) => f.scope === "project" && f.size > 0);
		if (!has) checks.push({ level: "warn", title: `${label[t.owner]} 没有项目级说明（${t.file}）`, detail: `${label[t.owner]} 在这个项目里不知道项目的约定。写好 .pi-agent/RULES.md 后执行 /rules sync，会生成 ${t.file}。` });
	}
	// 2. 共同规则
	if (!rulesHashValue) {
		checks.push({ level: "info", title: "还没有共同规则（.pi-agent/RULES.md）", detail: "把三位成员都该遵守的约定（编码规范、测试命令、提交规范、禁止事项）写进 RULES.md，再用 /rules sync 同步到各家的说明文件。终端 /rules init 生成模板。" });
	} else {
		const stale = files.filter((f) => f.rules === "stale" || f.rules === "missing");
		if (stale.length) checks.push({ level: "warn", title: "共同规则没有同步到所有成员", detail: "RULES.md 改过之后还没同步，或者有成员的说明文件里没有规则段落。执行 /rules sync。", files: stale.map((f) => f.id) });
		else checks.push({ level: "ok", title: "共同规则已同步到所有成员" });
	}
	// 3. 空文件
	const emptyFiles = files.filter((f) => f.kind === "instructions" && f.size === 0);
	if (emptyFiles.length) checks.push({ level: "info", title: "有空的说明文件", detail: "空文件不起作用，可以删掉或写上内容。", files: emptyFiles.map((f) => f.id) });
	// 4. 说明文件之间可能矛盾：包管理器
	const mentions = new Map<string, string[]>();
	for (const f of files.filter((x) => x.kind === "instructions" && x.size > 0 && x.size < MAX_READ)) {
		const text = readFileSync(f.path, "utf8");
		for (const pm of PKG_MANAGERS) {
			if (new RegExp(`(^|[^\\w-])${pm} (install|i|add|run|test)\\b`, "m").test(text)) mentions.set(pm, [...(mentions.get(pm) ?? []), f.id]);
		}
	}
	if (mentions.size > 1) {
		checks.push({
			level: "warn",
			title: `说明文件里的包管理器不一致：${[...mentions.keys()].join(" / ")}`,
			detail: [...mentions.entries()].map(([pm, ids]) => `${pm}：${ids.join("、")}`).join("；"),
			files: [...mentions.values()].flat(),
		});
	}
	// 5. 设置文件里的明文密钥
	const secrets = files.filter((f) => (f.kind === "settings" || f.kind === "mcp") && f.size < MAX_READ && SECRET_VALUE.test(readFileSync(f.path, "utf8")));
	if (secrets.length) checks.push({ level: "info", title: "设置文件里有明文密钥", detail: "这些文件里有 token / key（页面上已打码）。不要把它们提交进 git；项目级的设置文件应该加进 .gitignore。", files: secrets.map((f) => f.id) });
	return checks;
}

// ---------- 读取（打码） ----------
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|auth|credential|cookie|bearer)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|"(?:[^"]*(?:token|key|secret|auth)[^"]*)"\s*:\s*"[^"]{12,}")/i;

export function redact(text: string, path: string): string {
	let out = text
		.replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{12,}/g, "$1••••")
		.replace(/(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1••••")
		.replace(/(AIza)[0-9A-Za-z_-]{20,}/g, "$1••••");
	if (/\.json$/i.test(path)) {
		out = out.replace(/("([^"]+)"\s*:\s*)"([^"]*)"/g, (all, prefix, key, value) => (SECRET_KEY.test(key) && value.length >= 6 ? `${prefix}"••••（已隐藏）"` : all));
	} else if (/\.toml$/i.test(path)) {
		out = out.replace(/^(\s*([\w.-]+)\s*=\s*)"([^"]*)"/gm, (all, prefix, key, value) => (SECRET_KEY.test(key) && !/_env$|env_key/i.test(key) && value.length >= 6 ? `${prefix}"••••（已隐藏）"` : all));
	}
	return out;
}

/** 按编号读取（只认扫描结果里的文件），内容打码、限制大小 */
export function readConvention(scan: Scan, id: string): { file: ConventionFile; text: string; truncated: boolean } | undefined {
	const file = scan.files.find((f) => f.id === id);
	if (!file) return undefined;
	const raw = readFileSync(file.path, "utf8");
	const truncated = raw.length > MAX_READ;
	return { file, text: redact(truncated ? raw.slice(0, MAX_READ) : raw, file.path), truncated };
}

// ---------- 共同规则：模板与同步（只在终端执行） ----------
export const RULES_TEMPLATE = `# 共同规则（.pi-agent/RULES.md）

这份规则会被 \`/rules sync\` 同步进 CLAUDE.md、AGENTS.md、GEMINI.md，三位成员（Claude / Codex / Gemini）都会读到。
只写所有成员都该遵守的约定；某个成员特有的内容写在它自己的说明文件里规则段落之外。

## 项目协作
- 项目的最终目标在 .pi-agent/GOAL.md，分工表在 .pi-agent/ASSIGN.md（由总调度维护，不要修改）。
- 只做派给你的那项任务；发现超出范围的问题，在回答里说明，不要顺手改。
- 完成后说明改了哪些文件、怎么验证的、还有什么风险。

## 编码规范
- （例如：TypeScript 严格模式；缩进用 tab；命名用驼峰）

## 测试
- （例如：用 npm test 跑测试；提交前测试必须通过）

## 禁止事项
- 不要提交密钥和本地配置
- 不要引入新的依赖，除非任务明确要求
`;

export function initRules(project: string): { ok: boolean; path: string; message: string } {
	const path = join(project, ".pi-agent", "RULES.md");
	if (existsSync(path)) return { ok: false, path, message: `已经有 ${path}，直接编辑它，然后 /rules sync。` };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, RULES_TEMPLATE);
	return { ok: true, path, message: `已生成模板 ${path}。改成你的约定后执行 /rules sync。` };
}

/**
 * 把 RULES.md 同步进各成员的项目级说明文件：只替换带标记的规则段落，段落外的内容原样保留；
 * 文件不存在就新建。返回每个文件的结果。
 */
export function syncRules(project: string): { ok: boolean; message: string; results: { file: string; action: "created" | "updated" | "unchanged" }[] } {
	const rulesPath = join(project, ".pi-agent", "RULES.md");
	if (!existsSync(rulesPath)) return { ok: false, message: "还没有 .pi-agent/RULES.md。先执行 /rules init 生成模板。", results: [] };
	const rules = readFileSync(rulesPath, "utf8").trim();
	if (!rules) return { ok: false, message: "RULES.md 是空的。", results: [] };
	const hash = rulesHash(rules);
	const block = `<!-- pi-agent:rules hash=${hash} -->\n<!-- 下面这一段由 pi-agent 从 .pi-agent/RULES.md 同步，请改 RULES.md 再执行 /rules sync，不要直接改这里 -->\n\n${rules}\n\n${END}`;
	const results: { file: string; action: "created" | "updated" | "unchanged" }[] = [];
	for (const t of SYNC_TARGETS) {
		const path = join(project, t.file);
		if (!existsSync(path)) {
			writeFileSync(path, `${block}\n`);
			results.push({ file: t.file, action: "created" });
			continue;
		}
		const text = readFileSync(path, "utf8");
		const start = text.search(BEGIN);
		const end = text.indexOf(END);
		let next: string;
		if (start >= 0 && end > start) next = `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
		else next = `${block}\n\n${text}`;
		if (next === text) results.push({ file: t.file, action: "unchanged" });
		else {
			writeFileSync(path, next);
			results.push({ file: t.file, action: "updated" });
		}
	}
	return { ok: true, message: `已同步共同规则（${hash}）`, results };
}
