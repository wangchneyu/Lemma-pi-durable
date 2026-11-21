// 统计 src 下每个 .ts 文件的行数：node scripts/count-lines.mjs
// 每行输出「<行数> <相对路径>」，按行数从多到少排列（行数相同按路径字母序），最后一行是「total <总行数>」。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录 = 本脚本所在目录的上一级
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function fail(message) {
	console.error(`count-lines: ${message}`);
	process.exit(1);
}

// 递归收集 src 下所有 .ts 文件（跟随文件软链，目录软链不展开，避免环）
function collect(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...collect(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			found.push(full);
		} else if (entry.isSymbolicLink()) {
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

// 行数：换行符个数，最后一行没有换行结尾也算一行；空文件为 0
function countLines(file) {
	const text = readFileSync(file, "utf8");
	if (text === "") return 0;
	let lines = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lines += 1;
	}
	return text.endsWith("\n") ? lines : lines + 1;
}

let stats;
try {
	if (!statSync(srcDir).isDirectory()) fail(`src 不是目录：${srcDir}`);
	stats = collect(srcDir);
} catch (err) {
	if (err?.code === "ENOENT") fail(`找不到 src 目录：${srcDir}（请在项目根目录下运行本脚本）`);
	fail(`读取 src 目录失败：${err?.message ?? err}`);
}

const rows = stats.map((file) => ({
	lines: countLines(file),
	path: file.slice(root.length + 1).split(sep).join("/"),
}));
// 行数从多到少；行数相同按路径字母序
rows.sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const total = rows.reduce((sum, row) => sum + row.lines, 0);
for (const row of rows) console.log(`${row.lines} ${row.path}`);
console.log(`total ${total}`);
