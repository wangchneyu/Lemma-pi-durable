// 扫描 src 下所有 .ts 文件里的 TODO / FIXME 注释：node scripts/todo-scan.mjs
// 每命中一行输出一条「<相对项目根的路径>:<行号> <注释内容>」，例如 `src/foo/bar.ts:12 // TODO: 修复`。
// 输出按文件路径排序、行号升序；一条都没有时只输出「没有 TODO」。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录 = 本脚本所在目录的上一级（与运行时的 cwd 无关）
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

// 单词匹配：TODO 或 FIXME
const MARKER = /\b(?:TODO|FIXME)\b/;

// 递归收集 src 下所有 .ts 文件，跳过 node_modules；src 不存在时返回空数组
function collect(dir, found = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return found; // 没有 src
		throw err;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collect(full, found);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			found.push(full);
		} else if (entry.isSymbolicLink()) {
			// 跟随文件软链，目录软链不展开，避免环
			let stat;
			try {
				stat = statSync(full);
			} catch {
				continue; // 断链，跳过
			}
			if (stat.isFile() && entry.name.endsWith(".ts")) found.push(full);
		}
	}
	return found;
}

// 找该行注释的起始下标（跳过字符串字面量里的 // 与 /*），没有注释返回 -1
function commentStart(line) {
	let quote = null;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) return i;
	}
	return -1;
}

// 逐行提取注释文本并匹配 TODO / FIXME
function scanFile(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		console.error(`todo-scan: 读取失败，已跳过 ${file}：${err?.message ?? err}`);
		return [];
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM

	const hits = [];
	const lines = text.split(/\r\n|\r|\n/);
	let inBlockComment = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		let comment = null;
		if (inBlockComment) {
			// 块注释内部：整行都算注释
			comment = line;
			if (line.includes("*/")) inBlockComment = false;
		} else {
			const start = commentStart(line);
			if (start >= 0) {
				comment = line.slice(start);
				const isBlockStart = line[start + 1] === "*";
				if (isBlockStart && !line.includes("*/", start + 2)) inBlockComment = true;
			} else if (line.trimStart().startsWith("*")) {
				// 形如 ` * TODO: ...` 的块注释续行
				comment = line;
			}
		}
		if (comment === null) continue;

		// 注释内容：从 // 或 /* 或 * 起（trim 后即该行注释文本）
		const content = comment.trim();
		if (!MARKER.test(content)) continue;
		hits.push({ line: i + 1, content });
	}
	return hits;
}

const rows = [];
for (const file of collect(srcDir)) {
	const relative = file.slice(root.length + 1).split(sep).join("/");
	for (const hit of scanFile(file)) {
		rows.push({ path: relative, line: hit.line, content: hit.content });
	}
}

// 按路径升序，路径相同按行号升序
rows.sort((a, b) => {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.line - b.line;
});

if (rows.length === 0) {
	console.log("没有 TODO");
} else {
	for (const row of rows) console.log(`${row.path}:${row.line} ${row.content}`);
}
