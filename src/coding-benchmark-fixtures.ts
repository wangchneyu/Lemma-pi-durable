// P1 分层编码基准任务集（3 层 × 3 题 = 9 题）：
// - Tier 1：单文件小改（验证 Fast Path 单跳快路相对单 Agent 无额外协调税）
// - Tier 2：核心算法与隐藏边界缺陷（验证异构代码盲审的缺陷拦截与返工收益）
// - Tier 3：多模块并行实现/测试与联合集成（验证 Path Scope 防篡改与多 worktree 合流集成）

export type BenchmarkTier = 1 | 2 | 3;

export interface CodingBenchmarkTask {
	id: string;
	tier: BenchmarkTier;
	title: string;
	/** 交给执行方的需求说明（不含隐藏测试用例） */
	prompt: string;
	/** 初始仓库文件（含待修复 bug 或接口桩） */
	initialFiles: Record<string, string>;
	/** 目标实现文件路径 */
	implPath: string;
	/** Tier 3 独立测试文件路径 */
	testPath?: string;
	/** 隐藏测试脚本（node:test ESM），仅评测器在收尾时运行，不暴露给模型 */
	hiddenTest: string;
	/** 离线模拟用参考实现（含一版带典型缺陷的初稿，用于验证盲审返工链路） */
	reference: {
		files: Record<string, string>;
		/** Tier 2 离线模拟：首轮交付带隐藏缺陷，验证盲审抓缺陷并触发返工 */
		buggyFirstDraft?: Record<string, string>;
		/** Tier 3 离线模拟：独立测试文件 */
		testFiles?: Record<string, string>;
	};
}

export const CODING_BENCHMARK_TASKS: CodingBenchmarkTask[] = [
	// ==================== Tier 1：单文件小改（Fast Path） ====================
	{
		id: "t1-slugify-fix",
		tier: 1,
		title: "修复 slugify 连续连字符与首尾符号边界",
		implPath: "src/slug.js",
		prompt: "修复 src/slug.js 中的 slugify(input) 函数：转小写、将非字母数字字符替换为单个 '-'、去除首尾多余 '-'，且空值/非字符串返回空字符串 ''。仅修改 src/slug.js。",
		initialFiles: {
			"src/slug.js": `export function slugify(input) {
	return String(input).toLowerCase().replace(/[^a-z0-9]/g, "-");
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./src/slug.js";

test("collapses repeated punctuation and trims edges", () => {
	assert.equal(slugify("  Hello,   World!!  "), "hello-world");
	assert.equal(slugify("---Foo___Bar---"), "foo-bar");
});
test("handles numbers and empty/nullish inputs", () => {
	assert.equal(slugify("Release v2.0.1"), "release-v2-0-1");
	assert.equal(slugify(""), "");
	assert.equal(slugify(null), "");
	assert.equal(slugify(undefined), "");
});
`,
		reference: {
			files: {
				"src/slug.js": `export function slugify(input) {
	if (typeof input !== "string" || !input) return "";
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`,
			},
		},
	},
	{
		id: "t1-parse-env",
		tier: 1,
		title: "修复 parseEnv 带引号值与多等号截断",
		implPath: "src/env.js",
		prompt: "修复 src/env.js 中的 parseEnv(text) 函数：忽略空行和 # 注释行，仅按第一个 '=' 拆分键值（保留值中的 '='），去掉键值两端空白，并剥离成对单/双引号。仅修改 src/env.js。",
		initialFiles: {
			"src/env.js": `export function parseEnv(text) {
	const out = {};
	for (const line of String(text ?? "").split("\\n")) {
		const [k, v] = line.split("=");
		if (k) out[k.trim()] = (v ?? "").trim();
	}
	return out;
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "./src/env.js";

test("preserves equals signs in values and skips comments", () => {
	const raw = "# comment\\n\\nAPI_URL=https://a.test/x?a=1&b=2\\nTOKEN = abc==\\r\\n";
	assert.deepEqual(parseEnv(raw), { API_URL: "https://a.test/x?a=1&b=2", TOKEN: "abc==" });
});
test("strips matching quotes only", () => {
	const raw = 'A="hello world"\\nB=\\'single\\'\\nC="unmatched';
	assert.deepEqual(parseEnv(raw), { A: "hello world", B: "single", C: '"unmatched' });
});
`,
		reference: {
			files: {
				"src/env.js": `export function parseEnv(text) {
	const out = {};
	for (const raw of String(text ?? "").split(/\\r?\\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}
`,
			},
		},
	},
	{
		id: "t1-lru-peek",
		tier: 1,
		title: "为 LRU 缓存补齐 peek() 与零容量边界",
		implPath: "src/cache.js",
		prompt: "修复 src/cache.js 中的 LRUCache：新增 peek(key) 返回值但不刷新最近使用顺序；当 capacity <= 0 时 set() 不存储任何项。仅修改 src/cache.js。",
		initialFiles: {
			"src/cache.js": `export class LRUCache {
	constructor(capacity) {
		this.capacity = capacity;
		this.map = new Map();
	}
	get(key) {
		if (!this.map.has(key)) return undefined;
		const val = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, val);
		return val;
	}
	set(key, value) {
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.capacity) {
			const first = this.map.keys().next().value;
			this.map.delete(first);
		}
		this.map.set(key, value);
	}
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./src/cache.js";

test("peek does not refresh recency", () => {
	const c = new LRUCache(2);
	c.set("a", 1);
	c.set("b", 2);
	assert.equal(c.peek("a"), 1);
	c.set("c", 3);
	assert.equal(c.get("a"), undefined);
	assert.equal(c.get("b"), 2);
	assert.equal(c.get("c"), 3);
});
test("capacity <= 0 stores nothing", () => {
	const c = new LRUCache(0);
	c.set("x", 9);
	assert.equal(c.peek("x"), undefined);
	assert.equal(c.get("x"), undefined);
});
`,
		reference: {
			files: {
				"src/cache.js": `export class LRUCache {
	constructor(capacity) {
		this.capacity = capacity;
		this.map = new Map();
	}
	peek(key) {
		return this.map.get(key);
	}
	get(key) {
		if (!this.map.has(key)) return undefined;
		const val = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, val);
		return val;
	}
	set(key, value) {
		if (this.capacity <= 0) return;
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.capacity) {
			const first = this.map.keys().next().value;
			this.map.delete(first);
		}
		this.map.set(key, value);
	}
}
`,
			},
		},
	},

	// ==================== Tier 2：核心算法与隐藏边界（盲审价值） ====================
	{
		id: "t2-rate-limiter",
		tier: 2,
		title: "实现带内存清理与时钟回拨保护的滑动窗口限流器",
		implPath: "src/limiter.js",
		prompt: "在 src/limiter.js 中实现 SlidingWindowLimiter({ limit, windowMs, maxKeys = 1000 })：allow(key, nowMs) 返回 { allowed: boolean, remaining: number }；需处理同毫秒并发请求、时钟回拨（nowMs 小于历史记录不误删有效记录），以及超过 maxKeys 时清理已过期或最久未活跃 key 防止高基数内存泄漏（暴露 size() 返回当前跟踪 key 数）。",
		initialFiles: {
			"src/limiter.js": `export class SlidingWindowLimiter {
	constructor({ limit, windowMs, maxKeys = 1000 }) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.maxKeys = maxKeys;
	}
	allow(_key, _nowMs) {
		throw new Error("not implemented");
	}
	size() {
		return 0;
	}
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter } from "./src/limiter.js";

test("enforces sliding window and same-ms requests", () => {
	const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
	assert.deepEqual(lim.allow("u1", 100), { allowed: true, remaining: 1 });
	assert.deepEqual(lim.allow("u1", 100), { allowed: true, remaining: 0 });
	assert.deepEqual(lim.allow("u1", 500), { allowed: false, remaining: 0 });
	assert.deepEqual(lim.allow("u1", 1100), { allowed: true, remaining: 1 });
});
test("handles clock skew and bounds high-cardinality keys", () => {
	const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 50 });
	assert.equal(lim.allow("k0", 5000).allowed, true);
	assert.equal(lim.allow("k0", 4900).allowed, true);
	assert.equal(lim.allow("k0", 4950).allowed, false);
	for (let i = 1; i <= 200; i++) lim.allow("user-" + i, 5000 + i * 20);
	assert.ok(lim.size() <= 50, "key table must stay bounded <= maxKeys");
});
`,
		reference: {
			buggyFirstDraft: {
				"src/limiter.js": `export class SlidingWindowLimiter {
	constructor({ limit, windowMs, maxKeys = 1000 }) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.maxKeys = maxKeys;
		this.buckets = new Map();
	}
	allow(key, nowMs) {
		const list = (this.buckets.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
		if (list.length >= this.limit) {
			this.buckets.set(key, list);
			return { allowed: false, remaining: 0 };
		}
		list.push(nowMs);
		this.buckets.set(key, list);
		return { allowed: true, remaining: this.limit - list.length };
	}
	size() {
		return this.buckets.size;
	}
}
`,
			},
			files: {
				"src/limiter.js": `export class SlidingWindowLimiter {
	constructor({ limit, windowMs, maxKeys = 1000 }) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.maxKeys = maxKeys;
		this.buckets = new Map();
	}
	_pruneExpired(nowMs) {
		for (const [k, list] of this.buckets) {
			const kept = list.filter((t) => t > nowMs - this.windowMs);
			if (!kept.length) this.buckets.delete(k);
			else if (kept.length !== list.length) this.buckets.set(k, kept);
		}
		while (this.buckets.size > this.maxKeys) {
			const oldest = this.buckets.keys().next().value;
			this.buckets.delete(oldest);
		}
	}
	allow(key, nowMs) {
		const prev = this.buckets.get(key) ?? [];
		const cutoff = nowMs - this.windowMs;
		const kept = prev.filter((t) => t > cutoff);
		this.buckets.delete(key);
		if (kept.length >= this.limit) {
			this.buckets.set(key, kept);
			return { allowed: false, remaining: 0 };
		}
		kept.push(nowMs);
		this.buckets.set(key, kept);
		if (this.buckets.size > this.maxKeys) this._pruneExpired(nowMs);
		return { allowed: true, remaining: this.limit - kept.length };
	}
	size() {
		return this.buckets.size;
	}
}
`,
			},
		},
	},
	{
		id: "t2-semver-sort",
		tier: 2,
		title: "实现 SemVer 2.0 比较与排序（含预发布与 build 元数据）",
		implPath: "src/semver.js",
		prompt: "在 src/semver.js 中实现 compareSemver(a, b)（返回 -1/0/1）和 sortSemver(list)（返回升序新数组）：严格遵循 SemVer 2.0，忽略 +build 元数据，正式版高于同号预发布版，预发布分段按数字优先数值比较、数字小于字母、长度较长者更高。",
		initialFiles: {
			"src/semver.js": `export function compareSemver(_a, _b) {
	throw new Error("not implemented");
}
export function sortSemver(list) {
	return [...list].sort(compareSemver);
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { compareSemver, sortSemver } from "./src/semver.js";

test("handles prerelease precedence and numeric identifiers", () => {
	const input = ["1.0.0", "1.0.0-beta.11", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-alpha", "1.0.0-alpha.beta"];
	assert.deepEqual(sortSemver(input), [
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0",
	]);
});
test("ignores build metadata in precedence", () => {
	assert.equal(compareSemver("1.2.3+build.1", "1.2.3+build.99"), 0);
	assert.equal(compareSemver("1.2.10", "1.2.2"), 1);
});
`,
		reference: {
			buggyFirstDraft: {
				"src/semver.js": `export function compareSemver(a, b) {
	const pa = a.split(".").map((n) => parseInt(n, 10));
	const pb = b.split(".").map((n) => parseInt(n, 10));
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}
export function sortSemver(list) {
	return [...list].sort(compareSemver);
}
`,
			},
			files: {
				"src/semver.js": `function parse(v) {
	const noBuild = String(v).split("+")[0];
	const dash = noBuild.indexOf("-");
	const main = (dash === -1 ? noBuild : noBuild.slice(0, dash)).split(".").map(Number);
	const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split(".");
	return { main, pre };
}
export function compareSemver(a, b) {
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
	}
	if (!pa.pre.length && !pb.pre.length) return 0;
	if (!pa.pre.length) return 1;
	if (!pb.pre.length) return -1;
	const len = Math.max(pa.pre.length, pb.pre.length);
	for (let i = 0; i < len; i++) {
		if (i >= pa.pre.length) return -1;
		if (i >= pb.pre.length) return 1;
		const xa = pa.pre[i];
		const xb = pb.pre[i];
		if (xa === xb) continue;
		const na = /^\\d+$/.test(xa);
		const nb = /^\\d+$/.test(xb);
		if (na && nb) return Number(xa) < Number(xb) ? -1 : 1;
		if (na !== nb) return na ? -1 : 1;
		return xa < xb ? -1 : 1;
	}
	return 0;
}
export function sortSemver(list) {
	return [...list].sort(compareSemver);
}
`,
			},
		},
	},
	{
		id: "t2-csv-parser",
		tier: 2,
		title: "实现 RFC-4180 CSV 解析器（引号转义与字段内换行）",
		implPath: "src/csv.js",
		prompt: "在 src/csv.js 中实现 parseCsv(text) 返回二维字符串数组 string[][]：支持引号内逗号、双引号转义 \"\"、引号内换行（LF/CRLF）、尾部空行忽略与空字段。",
		initialFiles: {
			"src/csv.js": `export function parseCsv(_text) {
	throw new Error("not implemented");
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./src/csv.js";

test("parses quoted commas, escaped quotes, and embedded newlines", () => {
	const raw = 'name,note,qty\\r\\n"Alice, A.","line1\\n""quoted"" line2",3\\r\\nBob,,0\\r\\n';
	assert.deepEqual(parseCsv(raw), [
		["name", "note", "qty"],
		["Alice, A.", 'line1\\n"quoted" line2', "3"],
		["Bob", "", "0"],
	]);
});
test("handles empty input", () => {
	assert.deepEqual(parseCsv(""), []);
});
`,
		reference: {
			buggyFirstDraft: {
				"src/csv.js": `export function parseCsv(text) {
	if (!text) return [];
	return text.trim().split(/\\r?\\n/).map((line) => line.split(","));
}
`,
			},
			files: {
				"src/csv.js": `export function parseCsv(text) {
	if (!text) return [];
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\\r" || ch === "\\n") {
			if (ch === "\\r" && text[i + 1] === "\\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}
`,
			},
		},
	},

	// ==================== Tier 3：多模块并行 + 路径契约 + 多分支联合集成 ====================
	{
		id: "t3-event-bus",
		tier: 3,
		title: "并行实现事件总线（src/bus.js）与独立测试（test/bus.test.js）并联合集成",
		implPath: "src/bus.js",
		testPath: "test/bus.test.js",
		prompt: "在 src/bus.js 实现 EventBus（on/off/once/emit，支持 '*' 通配符监听并传入 (event, payload)，某个监听器抛错时不中断后续监听器并收集错误数组返回 { delivered, errors }）；在 test/bus.test.js 编写 node:test 单元测试覆盖全部行为。并行开发时实现方仅改 src/、测试方仅改 test/，最后联合集成验证。",
		initialFiles: {
			"src/bus.js": `export class EventBus {
	on(_event, _fn) { throw new Error("not implemented"); }
	off(_event, _fn) { throw new Error("not implemented"); }
	once(_event, _fn) { throw new Error("not implemented"); }
	emit(_event, _payload) { throw new Error("not implemented"); }
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./src/bus.js";

test("supports on, once, off, wildcard, and error isolation", () => {
	const bus = new EventBus();
	const seen = [];
	const fn = (p) => seen.push("on:" + p);
	bus.on("ping", fn);
	bus.once("ping", (p) => seen.push("once:" + p));
	bus.on("ping", () => { throw new Error("boom"); });
	bus.on("*", (ev, p) => seen.push("wild:" + ev + ":" + p));
	const r1 = bus.emit("ping", 1);
	assert.equal(r1.delivered, 3);
	assert.equal(r1.errors.length, 1);
	assert.deepEqual(seen, ["on:1", "once:1", "wild:ping:1"]);
	bus.off("ping", fn);
	const r2 = bus.emit("ping", 2);
	assert.equal(r2.delivered, 1);
	assert.equal(r2.errors.length, 1);
});
`,
		reference: {
			files: {
				"src/bus.js": `export class EventBus {
	constructor() {
		this.handlers = new Map();
	}
	on(event, fn) {
		const set = this.handlers.get(event) ?? new Set();
		set.add(fn);
		this.handlers.set(event, set);
		return () => this.off(event, fn);
	}
	off(event, fn) {
		this.handlers.get(event)?.delete(fn);
	}
	once(event, fn) {
		const wrap = (...args) => {
			this.off(event, wrap);
			return fn(...args);
		};
		return this.on(event, wrap);
	}
	emit(event, payload) {
		const errors = [];
		let delivered = 0;
		for (const fn of [...(this.handlers.get(event) ?? [])]) {
			try {
				fn(payload);
				delivered++;
			} catch (err) {
				errors.push(err);
			}
		}
		if (event !== "*") {
			for (const fn of [...(this.handlers.get("*") ?? [])]) {
				try {
					fn(event, payload);
					delivered++;
				} catch (err) {
					errors.push(err);
				}
			}
		}
		return { delivered, errors };
	}
}
`,
			},
			testFiles: {
				"test/bus.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/bus.js";

test("event bus basic delivery", () => {
	const bus = new EventBus();
	const hits = [];
	bus.on("a", (x) => hits.push(x));
	bus.once("a", (x) => hits.push(x * 10));
	const res = bus.emit("a", 2);
	assert.equal(res.delivered, 2);
	assert.deepEqual(hits, [2, 20]);
});
`,
			},
		},
	},
	{
		id: "t3-ledger-engine",
		tier: 3,
		title: "并行实现双录账本（src/ledger.js）与独立测试（test/ledger.test.js）并联合集成",
		implPath: "src/ledger.js",
		testPath: "test/ledger.test.js",
		prompt: "在 src/ledger.js 实现 Ledger：支持 post({ id, from, to, cents })（整数分，<=0 或 from===to 抛错；相同 id 幂等忽略重复入账不重复扣款）和 balance(account)（所有账户净余额之和恒为 0）。在 test/ledger.test.js 编写 node:test 测试。实现限 src/、测试限 test/ 并联合集成。",
		initialFiles: {
			"src/ledger.js": `export class Ledger {
	post(_entry) { throw new Error("not implemented"); }
	balance(_account) { throw new Error("not implemented"); }
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "./src/ledger.js";

test("enforces integer cents, idempotency, and zero-sum balances", () => {
	const l = new Ledger();
	l.post({ id: "tx1", from: "bank", to: "alice", cents: 500 });
	l.post({ id: "tx1", from: "bank", to: "alice", cents: 500 });
	l.post({ id: "tx2", from: "alice", to: "bob", cents: 175 });
	assert.equal(l.balance("bank"), -500);
	assert.equal(l.balance("alice"), 325);
	assert.equal(l.balance("bob"), 175);
	assert.throws(() => l.post({ id: "tx3", from: "a", to: "a", cents: 10 }));
	assert.throws(() => l.post({ id: "tx4", from: "a", to: "b", cents: 1.5 }));
	assert.throws(() => l.post({ id: "tx5", from: "a", to: "b", cents: 0 }));
});
`,
		reference: {
			files: {
				"src/ledger.js": `export class Ledger {
	constructor() {
		this.seen = new Set();
		this.balances = new Map();
	}
	post({ id, from, to, cents }) {
		if (!id || !from || !to || from === to) throw new Error("invalid accounts or id");
		if (!Number.isInteger(cents) || cents <= 0) throw new Error("cents must be positive integer");
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		this.balances.set(from, (this.balances.get(from) ?? 0) - cents);
		this.balances.set(to, (this.balances.get(to) ?? 0) + cents);
		return true;
	}
	balance(account) {
		return this.balances.get(account) ?? 0;
	}
}
`,
			},
			testFiles: {
				"test/ledger.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";

test("ledger idempotency and balances", () => {
	const l = new Ledger();
	l.post({ id: "1", from: "cash", to: "user", cents: 100 });
	l.post({ id: "1", from: "cash", to: "user", cents: 100 });
	assert.equal(l.balance("user"), 100);
	assert.equal(l.balance("cash"), -100);
});
`,
			},
		},
	},
	{
		id: "t3-task-dag",
		tier: 3,
		title: "并行实现 DAG 拓扑分层器（src/dag.js）与独立测试（test/dag.test.js）并联合集成",
		implPath: "src/dag.js",
		testPath: "test/dag.test.js",
		prompt: "在 src/dag.js 实现 scheduleLayers(tasks)（每项 { id, deps: string[] }）：按依赖计算可并行执行的阶段数组 string[][]（每层按 id 字典序排序）；若存在缺失依赖或环则抛错。在 test/dag.test.js 编写 node:test 测试。实现限 src/、测试限 test/ 并联合集成。",
		initialFiles: {
			"src/dag.js": `export function scheduleLayers(_tasks) {
	throw new Error("not implemented");
}
`,
		},
		hiddenTest: `import test from "node:test";
import assert from "node:assert/strict";
import { scheduleLayers } from "./src/dag.js";

test("groups independent tasks into sorted parallel layers", () => {
	const layers = scheduleLayers([
		{ id: "T4", deps: ["T2", "T3"] },
		{ id: "T2", deps: ["T1"] },
		{ id: "T3", deps: ["T1"] },
		{ id: "T1", deps: [] },
	]);
	assert.deepEqual(layers, [["T1"], ["T2", "T3"], ["T4"]]);
});
test("rejects cycles and missing dependencies", () => {
	assert.throws(() => scheduleLayers([{ id: "A", deps: ["B"] }, { id: "B", deps: ["A"] }]));
	assert.throws(() => scheduleLayers([{ id: "A", deps: ["NOPE"] }]));
});
`,
		reference: {
			files: {
				"src/dag.js": `export function scheduleLayers(tasks) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const indeg = new Map();
	const next = new Map();
	for (const t of tasks) {
		indeg.set(t.id, 0);
		next.set(t.id, []);
	}
	for (const t of tasks) {
		for (const dep of t.deps ?? []) {
			if (!byId.has(dep)) throw new Error("missing dependency: " + dep);
			indeg.set(t.id, indeg.get(t.id) + 1);
			next.get(dep).push(t.id);
		}
	}
	const layers = [];
	let ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
	let visited = 0;
	while (ready.length) {
		layers.push(ready);
		visited += ready.length;
		const nextReady = [];
		for (const id of ready) {
			for (const child of next.get(id)) {
				const rem = indeg.get(child) - 1;
				indeg.set(child, rem);
				if (rem === 0) nextReady.push(child);
			}
		}
		ready = nextReady.sort();
	}
	if (visited !== tasks.length) throw new Error("cycle detected");
	return layers;
}
`,
			},
			testFiles: {
				"test/dag.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { scheduleLayers } from "../src/dag.js";

test("schedules diamond DAG", () => {
	assert.deepEqual(scheduleLayers([
		{ id: "A", deps: [] },
		{ id: "B", deps: ["A"] },
		{ id: "C", deps: ["A"] },
		{ id: "D", deps: ["B", "C"] },
	]), [["A"], ["B", "C"], ["D"]]);
});
`,
			},
		},
	},
];
