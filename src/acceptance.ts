import { createHash } from "node:crypto";

export type AcceptanceCheck = { name: string; kind: "contains" | "json_exists" | "json_equals"; path?: string; value?: string };
export type TaskVerification = {
	resultId: string; contract: string; passed: boolean; at: number;
	checks: { name: string; passed: boolean; evidence: string }[];
};

export function validateAcceptanceChecks(checks: AcceptanceCheck[]): void {
	if (!Array.isArray(checks) || checks.length > 20) throw new Error("每项任务最多配置 20 条机器验收规则。");
	const names = new Set<string>();
	for (const check of checks) {
		if (!check || typeof check.name !== "string" || !check.name.trim() || names.has(check.name) || !["contains", "json_exists", "json_equals"].includes(check.kind)) throw new Error("验收规则名称或类型无效。");
		names.add(check.name);
		if (check.kind === "contains" && (typeof check.value !== "string" || !check.value.trim())) throw new Error("contains 需要非空 value。");
		if (check.kind !== "contains" && (typeof check.path !== "string" || !check.path || check.path.length > 500 || check.path.split(".").some((key) => !key || ["__proto__", "constructor", "prototype"].includes(key)))) throw new Error("JSON 规则需要有效的点分字段路径（数组可用数字下标）。");
		if (check.kind === "json_equals") { try { JSON.parse(check.value!); } catch { throw new Error("json_equals 的 value 需要 JSON 文本。"); } }
	}
}
export function acceptanceContract(acceptance: string | undefined, checks: AcceptanceCheck[] = []): string {
	return createHash("sha256").update(JSON.stringify([acceptance ?? "", checks])).digest("hex");
}
function field(value: unknown, path: string): { found: boolean; value: unknown } {
	for (const key of path.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return { found: false, value: undefined };
		value = (value as Record<string, unknown>)[key];
	}
	return { found: true, value };
}
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
	const left = Object.keys(a), right = Object.keys(b);
	return left.length === right.length && left.every((key) => Object.hasOwn(b, key) && same((a as any)[key], (b as any)[key]));
}
/** Evaluates the complete original report, never the shortened controller preview. */
export function verifyReport(resultId: string, text: string, acceptance: string | undefined, rules: AcceptanceCheck[], at: number): TaskVerification {
	validateAcceptanceChecks(rules);
	let parsed: unknown; let validJson = false;
	try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")); validJson = true; } catch {}
	const checks = rules.map((rule) => {
		if (rule.kind === "contains") { const passed = text.includes(rule.value!); return { name: rule.name, passed, evidence: passed ? "全文包含指定文本" : "全文缺少指定文本" }; }
		const item = validJson ? field(parsed, rule.path!) : { found: false, value: undefined };
		const passed = item.found && (rule.kind === "json_exists" || same(item.value, JSON.parse(rule.value!)));
		return { name: rule.name, passed, evidence: !validJson ? "结果不是完整 JSON 对象" : !item.found ? `缺少字段 ${rule.path}` : passed ? `字段 ${rule.path} 通过` : `字段 ${rule.path} 不符合预期` };
	});
	return { resultId, contract: acceptanceContract(acceptance, rules), passed: checks.length > 0 && checks.every((check) => check.passed), at, checks };
}
