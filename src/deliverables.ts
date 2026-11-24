import { compile } from "@earendil-works/pi-schema";
import type { JsonValue } from "@earendil-works/chord/json";

/** Optional, explicit member report envelope. Plain reports remain fully supported. */
export type Deliverable = {
	format: "lemma.delivery.v1"; conclusion: string; data?: JsonValue;
	evidence: { source: string; excerpt?: string }[];
	artifacts: { path: string; description?: string }[]; incomplete: string[];
}
export const deliverySchema = { type: "object", required: ["format", "conclusion", "evidence", "artifacts", "incomplete"], additionalProperties: false, properties: {
	format: { const: "lemma.delivery.v1" }, conclusion: { type: "string", minLength: 1 }, data: {},
	evidence: { type: "array", maxItems: 100, items: { type: "object", required: ["source"], additionalProperties: false, properties: { source: { type: "string", minLength: 1 }, excerpt: { type: "string" } } } },
	artifacts: { type: "array", maxItems: 100, items: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1 }, description: { type: "string" } } } },
	incomplete: { type: "array", maxItems: 100, items: { type: "string" } },
} };
const validator = compile(deliverySchema);
export function parseDeliverable(text: string): Deliverable | undefined {
	try { const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")); return validator.check(value) ? value as Deliverable : undefined; } catch { return; }
}
export function deliveryField(delivery: Deliverable, path: string): unknown {
	if (!path || path.length > 500) throw new Error("交接字段路径无效。");
	let value: unknown = delivery;
	for (const key of path.split(".")) {
		if (!key || ["__proto__", "constructor", "prototype"].includes(key) || !value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("交接字段不存在或不允许访问。");
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}
export function resultExcerpt(report: { text: string; deliverable?: Deliverable }, input: { field?: string; offset?: number; limit?: number }): { text: string; totalChars: number; offset: number; nextOffset: number | null } {
	let source = report.text;
	if (input.field) {
		const delivery = report.deliverable ?? parseDeliverable(report.text);
		if (!delivery) throw new Error("该结果没有结构化交付；可按原文片段读取。");
		const value = deliveryField(delivery, input.field); source = typeof value === "string" ? value : JSON.stringify(value);
	}
	const offset = input.offset ?? 0, limit = input.limit ?? 8000;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error("交接片段的 offset 或 limit 无效。");
	const end = Math.min(source.length, offset + limit);
	return { text: source.slice(offset, end), totalChars: source.length, offset, nextOffset: end < source.length ? end : null };
}
