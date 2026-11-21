// 打印 pi-agent.config.json 的顶层字段名，以及 agents 下每个成员的启用状态：node scripts/config-keys.mjs
// 只使用 Node 内置模块；项目根目录 = 本脚本所在目录的上一级（不依赖 cwd）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录 = 本脚本所在目录（scripts/）的上一级
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "pi-agent.config.json");

function fail(message) {
	console.error(`config-keys: ${message}`);
	process.exit(1);
}

// 是否是可当作「对象」处理的值（排除 null 和数组）
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 1. 读文件
let text;
try {
	text = readFileSync(configPath, "utf8");
} catch (err) {
	if (err?.code === "ENOENT") fail(`配置文件不存在：${configPath}`);
	fail(`读取配置文件失败：${configPath}（${err?.message ?? err}）`);
}

// 2. 解析 JSON
let config;
try {
	config = JSON.parse(text);
} catch (err) {
	fail(`配置文件 JSON 解析失败：${configPath}\n  ${err?.message ?? err}`);
}

// 3. 顶层必须是 JSON 对象
if (!isObject(config)) {
	const actual = Array.isArray(config) ? "数组" : config === null ? "null" : typeof config;
	fail(`配置文件顶层必须是 JSON 对象：${configPath}（实际是 ${actual}）`);
}

// 4. 顶层字段名
const keys = Object.keys(config);
console.log(keys.length > 0 ? `顶层字段: ${keys.join(", ")}` : "顶层字段: （空对象，没有字段）");

// 5. agents 成员状态
const agents = config.agents;
if (!isObject(agents)) {
	console.log("提示: 配置中没有 agents 字段");
} else {
	const names = Object.keys(agents);
	if (names.length === 0) {
		console.log("提示: agents 字段里没有任何成员");
	}
	for (const name of names) {
		// agent.enabled === false 才算 disabled；agent 不是对象也视为 disabled
		const enabled = isObject(agents[name]) && agents[name].enabled !== false;
		console.log(`${name}: ${enabled ? "enabled" : "disabled"}`);
	}
}
