// 工作区只读代码感知工具：目录浏览（list_files）、代码检索（search_code）、改动差异（git_diff）。
// 仅对编码工作区（workspace !== "none"）且具备 read 权限的 API 成员开放；严格限制在子对话 cwd 内，不修改任何文件或 Git 状态。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import vm from "node:vm";
import { AgentDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { ChangeStore } from "./changes.ts";
import { git } from "./git.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".pi-agent", "worktrees"]);
const MAX_FILE_BYTES = 1_048_576; // 1 MB

function normalizeRel(cwd: string, target: string): string {
	const rel = relative(cwd, target);
	return rel ? rel.split(sep).join(posix.sep) : ".";
}

function resolveInside(cwd: string, rawPath: string | undefined, checkPath: (path: unknown, cwd: string) => string | undefined): { target?: string; rel?: string; refusal?: string } {
	const requested = rawPath?.trim() ? rawPath.trim() : ".";
	const refusal = checkPath(requested, cwd);
	if (refusal) return { refusal };
	const target = resolve(cwd, requested);
	return { target, rel: normalizeRel(cwd, target) };
}

function walkFiles(root: string, start: string, maxDepth: number, maxEntries: number, includeDirs: boolean): { items: string[]; truncated: boolean } {
	const items: string[] = [];
	let truncated = false;
	function visit(dir: string, depth: number) {
		if (truncated || depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (IGNORED_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
			const full = join(dir, entry.name);
			const rel = normalizeRel(root, full);
			if (entry.isDirectory()) {
				if (includeDirs) {
					if (items.length >= maxEntries) { truncated = true; return; }
					items.push(`${rel}/`);
				}
				if (depth < maxDepth) visit(full, depth + 1);
			} else if (entry.isFile()) {
				if (items.length >= maxEntries) { truncated = true; return; }
				items.push(rel);
			}
		}
	}
	let st;
	try {
		st = statSync(start);
	} catch {
		return { items: [], truncated: false };
	}
	if (st.isFile()) return { items: [normalizeRel(root, start)], truncated: false };
	if (st.isDirectory()) visit(start, 1);
	return { items, truncated };
}

export function createCodeReadTools(
	checkPath: (path: unknown, cwd: string) => string | undefined,
	changes?: ChangeStore,
): ToolRegistration[] {
	const listFiles = defineTool({
		name: "list_files",
		description: "只读列出当前工作目录（或指定子目录）下的文件与目录结构，自动跳过 .git 和 node_modules。",
		parameters: obj({
			path: opt(str({ description: "相对工作目录的子路径，默认 ." })),
			max_depth: opt(int({ minimum: 1, maximum: 6, description: "最大目录深度（1–6，默认 3）" })),
			limit: opt(int({ minimum: 1, maximum: 500, description: "最多返回条数（默认 200）" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = (await api.snapshot(AgentDoc, api.conversationId, context)) as { cwd?: string } | undefined;
			if (!agent?.cwd) return { output: [{ type: "text" as const, text: "没有确定的工作目录，不能列出文件。" }], isError: true };
			const resolved = resolveInside(agent.cwd, args.path, checkPath);
			if (resolved.refusal) return { output: [{ type: "text" as const, text: resolved.refusal }], isError: true };
			try {
				statSync(resolved.target!);
			} catch {
				return { output: [{ type: "text" as const, text: `路径不存在：${args.path ?? "."}` }], isError: true };
			}
			const { items, truncated } = walkFiles(agent.cwd, resolved.target!, args.max_depth ?? 3, args.limit ?? 200, true);
			const body = items.length ? items.join("\n") : "（空目录或无可显示文件）";
			const note = truncated ? `\n…（已达 ${args.limit ?? 200} 条上限，请指定子目录 path 继续查看）` : "";
			return { output: [{ type: "text" as const, text: `${body}${note}` }] };
		},
	});

	const searchCode = defineTool({
		name: "search_code",
		description: "只读在当前工作目录的代码文件中搜索关键字或正则表达式，返回匹配的文件路径、行号与内容。",
		parameters: obj({
			query: str({ description: "要搜索的关键字或正则表达式" }),
			path: opt(str({ description: "限定搜索的相对子目录或文件路径，默认 ." })),
			regex: opt(bool({ description: "是否按正则表达式匹配，默认 false（字面量匹配）" })),
			case_sensitive: opt(bool({ description: "是否区分大小写，默认 true" })),
			limit: opt(int({ minimum: 1, maximum: 200, description: "最多返回匹配行数（默认 80）" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = (await api.snapshot(AgentDoc, api.conversationId, context)) as { cwd?: string } | undefined;
			if (!agent?.cwd) return { output: [{ type: "text" as const, text: "没有确定的工作目录，不能搜索代码。" }], isError: true };
			if (!args.query.trim()) return { output: [{ type: "text" as const, text: "query 不能为空。" }], isError: true };
			if (args.query.length > 240) return { output: [{ type: "text" as const, text: "query 长度不能超过 240 个字符。" }], isError: true };
			const resolved = resolveInside(agent.cwd, args.path, checkPath);
			if (resolved.refusal) return { output: [{ type: "text" as const, text: resolved.refusal }], isError: true };
			let matcher: (line: string) => boolean;
			const sensitive = args.case_sensitive !== false;
			if (args.regex) {
				try {
					const re = new RegExp(args.query, sensitive ? "" : "i");
					matcher = (line) => re.test(line);
				} catch (error) {
					return { output: [{ type: "text" as const, text: `无效的正则表达式：${error instanceof Error ? error.message : String(error)}` }], isError: true };
				}
			} else {
				const needle = sensitive ? args.query : args.query.toLowerCase();
				matcher = (line) => (sensitive ? line : line.toLowerCase()).includes(needle);
			}
			const { items: files } = walkFiles(agent.cwd, resolved.target!, 8, 2000, false);
			const maxMatches = args.limit ?? 80;
			const matches: string[] = [];
			let hitLimit = false;
			for (const rel of files) {
				if (hitLimit) break;
				const full = join(agent.cwd, rel);
				let stat;
				try {
					stat = statSync(full);
				} catch {
					continue;
				}
				if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
				let buf: Buffer;
				try {
					buf = readFileSync(full);
				} catch {
					continue;
				}
				if (buf.includes(0)) continue; // 跳过二进制文件
				const lines = buf.toString("utf8").split(/\r?\n/);
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index]!;
					if (!matcher(line)) continue;
					const snippet = line.length > 240 ? `${line.slice(0, 240)}…` : line;
					matches.push(`${rel}:${index + 1}: ${snippet}`);
					if (matches.length >= maxMatches) { hitLimit = true; break; }
				}
			}
			if (!matches.length) return { output: [{ type: "text" as const, text: `未找到匹配项：${args.query}` }] };
			const suffix = hitLimit ? `\n…（已达 ${maxMatches} 条上限，请缩小 path 或细化 query）` : "";
			return { output: [{ type: "text" as const, text: `${matches.join("\n")}${suffix}` }] };
		},
	});

	const gitDiff = defineTool({
		name: "git_diff",
		description: "只读查看当前工作副本相对于起始基线（base）的代码改动统计或补丁差异，不会修改任何 Git 状态。",
		parameters: obj({
			path: opt(str({ description: "可选相对文件或目录路径，仅查看该路径下的改动" })),
			stat_only: opt(bool({ description: "为 true 时仅输出变更文件与增删行数统计" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = (await api.snapshot(AgentDoc, api.conversationId, context)) as { cwd?: string } | undefined;
			if (!agent?.cwd) return { output: [{ type: "text" as const, text: "没有确定的工作目录，不能读取差异。" }], isError: true };
			const resolved = resolveInside(agent.cwd, args.path, checkPath);
			if (resolved.refusal) return { output: [{ type: "text" as const, text: resolved.refusal }], isError: true };
			const change = changes?.byPath(agent.cwd);
			let baseRef = change ? changes!.range(change)[0] : "HEAD";
			let upstreamNote = "";
			const pathArgs = args.path?.trim() && resolved.rel && resolved.rel !== "." ? [resolved.rel] : [];
			let out = await git(agent.cwd, ["diff", "--no-color", ...(args.stat_only ? ["--stat"] : ["--unified=3"]), baseRef, "--", ...pathArgs]);
			if (out.code === 0 && !out.stdout.trim() && change?.basedOn && change.head === change.base) {
				const upstream = changes?.get(change.basedOn);
				if (upstream) {
					baseRef = changes!.range(upstream)[0];
					upstreamNote = `[上游改动 #${upstream.id}（${baseRef.slice(0, 12)}..${upstream.head.slice(0, 12)}）]\n`;
					out = await git(agent.cwd, ["diff", "--no-color", ...(args.stat_only ? ["--stat"] : ["--unified=3"]), baseRef, "--", ...pathArgs]);
				}
			}
			if (out.code !== 0) return { output: [{ type: "text" as const, text: `无法读取 Git 差异：${(out.stderr || out.stdout).trim()}` }], isError: true };
			const text = out.stdout.trim();
			if (!text) return { output: [{ type: "text" as const, text: `相对于基线 ${baseRef.slice(0, 12)} 暂无已跟踪文件差异。` }] };
			const full = `${upstreamNote}${text}`;
			const limit = 16000;
			const clipped = full.length > limit ? `${full.slice(0, limit)}\n…（差异共 ${full.length} 字符，可传 path 查看单个文件或 stat_only:true 查看概览）` : full;
			return { output: [{ type: "text" as const, text: clipped }] };
		},
	});

	const OUTLINE_RE = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+[A-Za-z0-9_$]+|class\s+[A-Za-z0-9_$]+|interface\s+[A-Za-z0-9_$]+|type\s+[A-Za-z0-9_$]+|enum\s+[A-Za-z0-9_$]+|(?:const|let|var)\s+[A-Za-z0-9_$]+|def\s+[A-Za-z0-9_]+|func\s+(?:\([^)]+\)\s*)?[A-Za-z0-9_]+|struct\s+[A-Za-z0-9_]+|#{1,6}\s+.+)/;
	const METHOD_RE = /^(?:\t| {2,8})(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b)[A-Za-z_$][A-Za-z0-9_$]*\s*\([^;]*\)\s*(?::\s*[^{=]+)?\{/;

	const outlineFile = defineTool({
		name: "outline_file",
		description: "只读提取代码或文档文件的结构大纲（导出的函数、类、接口、类型、常量及行号），便于先定位行号区间再用 read 分段读取。",
		parameters: obj({
			path: str({ description: "相对当前工作目录的文件路径" }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = (await api.snapshot(AgentDoc, api.conversationId, context)) as { cwd?: string } | undefined;
			if (!agent?.cwd) return { output: [{ type: "text" as const, text: "没有确定的工作目录，不能读取文件大纲。" }], isError: true };
			const resolved = resolveInside(agent.cwd, args.path, checkPath);
			if (resolved.refusal) return { output: [{ type: "text" as const, text: resolved.refusal }], isError: true };
			let st;
			try {
				st = statSync(resolved.target!);
			} catch {
				return { output: [{ type: "text" as const, text: `文件不存在：${args.path}` }], isError: true };
			}
			if (!st.isFile()) return { output: [{ type: "text" as const, text: `路径不是文件：${args.path}` }], isError: true };
			if (st.size > MAX_FILE_BYTES) return { output: [{ type: "text" as const, text: `文件过大（>${MAX_FILE_BYTES} 字节），请使用 search_code 搜索。` }], isError: true };
			const buf = readFileSync(resolved.target!);
			if (buf.includes(0)) return { output: [{ type: "text" as const, text: `二进制文件无法提取代码大纲：${args.path}` }], isError: true };
			const lines = buf.toString("utf8").split(/\r?\n/);
			const items: string[] = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (OUTLINE_RE.test(line) || METHOD_RE.test(line)) {
					const cleaned = line.replace(/\s+$/, "").slice(0, 160);
					items.push(`L${i + 1}: ${cleaned}`);
					if (items.length >= 200) break;
				}
			}
			const header = `${resolved.rel}（共 ${lines.length} 行）`;
			if (!items.length) return { output: [{ type: "text" as const, text: `${header}\n（未识别到顶层符号声明，可直接用 read 读取）` }] };
			return { output: [{ type: "text" as const, text: `${header}\n${items.join("\n")}` }] };
		},
	});

	const findSymbol = defineTool({
		name: "find_symbol",
		description: "只读在工作区中按符号名称定位其【定义处 (Definitions)】与【引用处 (References)】（精确匹配标识符边界）。",
		parameters: obj({
			symbol: str({ description: "要定位的函数、类、接口、类型或变量标识符名称" }),
			path: opt(str({ description: "可选限定的相对子目录或文件路径，默认 ." })),
			kind: opt(oneOf(["all", "definition", "reference"], { description: "筛选范围：all（默认，定义+引用）、definition（仅定义）、reference（仅引用）" })),
			limit: opt(int({ minimum: 1, maximum: 200, description: "最多返回条数（默认 80）" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = (await api.snapshot(AgentDoc, api.conversationId, context)) as { cwd?: string } | undefined;
			if (!agent?.cwd) return { output: [{ type: "text" as const, text: "没有确定的工作目录，不能定位符号。" }], isError: true };
			const sym = args.symbol.trim();
			if (!sym || sym.length > 120) return { output: [{ type: "text" as const, text: "symbol 需要 1–120 个字符的有效名称。" }], isError: true };
			const resolved = resolveInside(agent.cwd, args.path, checkPath);
			if (resolved.refusal) return { output: [{ type: "text" as const, text: resolved.refusal }], isError: true };
			const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const tokenRe = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
			const defRe = new RegExp(`(?:\\b(?:export|function\\*?|class|interface|type|enum|const|let|var|def|func|struct)\\s+(?:async\\s+)?${escaped}(?![A-Za-z0-9_$])|^\\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\\s+)*${escaped}\\s*\\([^;]*\\)\\s*(?::\\s*[^{=]+)?\\{)`);
			const mode = args.kind ?? "all";
			const maxItems = args.limit ?? 80;
			const { items: files } = walkFiles(agent.cwd, resolved.target!, 8, 2000, false);
			const defs: string[] = [];
			const refs: string[] = [];
			for (const rel of files) {
				if (defs.length + refs.length >= maxItems) break;
				const full = join(agent.cwd, rel);
				let st;
				try {
					st = statSync(full);
				} catch {
					continue;
				}
				if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
				let buf: Buffer;
				try {
					buf = readFileSync(full);
				} catch {
					continue;
				}
				if (buf.includes(0)) continue;
				const lines = buf.toString("utf8").split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]!;
					if (!tokenRe.test(line)) continue;
					const isDef = defRe.test(line);
					if (isDef && mode === "reference") continue;
					if (!isDef && mode === "definition") continue;
					const entry = `${rel}:${i + 1}: ${line.trim().slice(0, 220)}`;
					if (isDef) defs.push(entry);
					else refs.push(entry);
					if (defs.length + refs.length >= maxItems) break;
				}
			}
			if (!defs.length && !refs.length) return { output: [{ type: "text" as const, text: `未找到符号：${sym}` }] };
			const sections: string[] = [];
			if (defs.length) sections.push(`【定义处 (${defs.length})】\n${defs.join("\n")}`);
			if (refs.length) sections.push(`【引用处 (${refs.length})】\n${refs.join("\n")}`);
			return { output: [{ type: "text" as const, text: sections.join("\n\n") }] };
		},
	});

	return [listFiles, searchCode, gitDiff, outlineFile, findSymbol];
}

/**
 * 编辑后即时零成本语法/JSON 诊断：在 write/edit 刚落盘时立即捕获语法错误，
 * 避免 API 成员直到派工结束跑 autonomy.checks 才发现低级语法问题而浪费整轮返工。
 */
export function checkFileSyntax(cwd: string, rawPath: string): string | undefined {
	const full = resolve(cwd, rawPath.trim());
	const ext = extname(full).toLowerCase();
	if (![".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".json"].includes(ext)) return undefined;
	let content: string;
	try {
		const st = statSync(full);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
		content = readFileSync(full, "utf8");
	} catch {
		return undefined;
	}
	if (ext === ".json") {
		try {
			JSON.parse(content);
			return undefined;
		} catch (error) {
			return `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`;
		}
	}
	try {
		if (ext === ".tsx") {
			// stripTypeScriptTypes 支持 ts/mts/cts；tsx 跳过 JSX 误报仅做基础校验
			return undefined;
		}
		const js = [".ts", ".mts", ".cts"].includes(ext) ? stripTypeScriptTypes(content, { mode: "strip" }) : content;
		// 用 vm.Script 校验普通 JS 语法；若含 import/export（ESM）则跳过 vm.Script（stripTypeScriptTypes 已校验 TS 语法）
		if (!/^\s*(?:import|export)\b/m.test(js)) {
			new vm.Script(js, { filename: rawPath });
		}
		return undefined;
	} catch (error) {
		return `语法检查未通过：${error instanceof Error ? error.message : String(error)}`;
	}
}
