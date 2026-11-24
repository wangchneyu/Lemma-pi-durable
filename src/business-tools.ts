import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import { compile, unsafe, type Schema } from "@earendil-works/pi-schema";
import { readCredential } from "./credentials.ts";
import { Operations, unresolved, type BusinessFailure, type OperationResult } from "./operations.ts";

/** Fixed endpoints configured locally; models supply business arguments only. */
export interface HttpBusinessTool {
	id: string;
	description: string;
	url: string;
	method: "GET" | "POST";
	parameters: Record<string, unknown>;
	auth?: { env?: string; credential?: string };
	/** Only set when the remote service actually supports this header. */
	idempotencyHeader?: string;
	timeoutSeconds?: number;
	maxResultChars?: number;
}

export function validateBusinessTools(tools: HttpBusinessTool[] | undefined): void {
	if (tools === undefined) return;
	if (!Array.isArray(tools)) throw new Error("httpTools 需要工具数组。");
	const ids = new Set<string>();
	for (const tool of tools) {
		if (!tool || !/^[a-z][a-z0-9_]{0,47}$/.test(tool.id) || ["read", "write", "edit", "bash", "constructor", "prototype"].includes(tool.id) || ids.has(tool.id)) throw new Error("业务工具 ID 无效或重复。");
		ids.add(tool.id);
		if (typeof tool.description !== "string" || !tool.description.trim() || !["GET", "POST"].includes(tool.method)) throw new Error("业务工具需要说明与 GET/POST 方法。");
		let url: URL; try { url = new URL(tool.url); } catch { throw new Error("业务工具地址无效。"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("业务工具需要固定 HTTP(S) 地址，不含凭据、查询参数或片段。");
		if (!tool.parameters || tool.parameters.type !== "object") throw new Error("业务工具参数需要 object JSON Schema。");
		try { compile(tool.parameters); } catch { throw new Error("业务工具参数 JSON Schema 无效。"); }
		if (tool.auth && ((tool.auth.env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tool.auth.env)) || (tool.auth.credential !== undefined && !/^local-[a-f0-9-]{36}$/.test(tool.auth.credential)) || (!tool.auth.env && !tool.auth.credential))) throw new Error("业务工具凭据引用无效。");
		if (tool.idempotencyHeader !== undefined && (!/^[A-Za-z0-9-]{1,80}$/.test(tool.idempotencyHeader) || /^(authorization|cookie|host|content-type|content-length)$/i.test(tool.idempotencyHeader))) throw new Error("幂等请求头名称无效。");
		if (tool.timeoutSeconds !== undefined && (!Number.isFinite(tool.timeoutSeconds) || tool.timeoutSeconds <= 0 || tool.timeoutSeconds > 300)) throw new Error("业务工具超时需要在 0–300 秒内。");
		if (tool.maxResultChars !== undefined && (!Number.isSafeInteger(tool.maxResultChars) || tool.maxResultChars < 100 || tool.maxResultChars > 20000)) throw new Error("业务工具结果长度需要为 100–20000。");
	}
}

export async function callBusinessTool(tool: HttpBusinessTool, args: Record<string, unknown>, signal: AbortSignal, key: string): Promise<OperationResult> {
	const fail = (kind: BusinessFailure["kind"], message: string, retryable = false, retryAt?: number): OperationResult => ({ text: message, isError: true, failure: { kind, message, retryable, ...(retryAt !== undefined ? { retryAt } : {}) } });
	if (!compile(tool.parameters).check(args)) return fail("validation", "业务工具参数不符合已配置的 JSON Schema，未发送请求。");
	if (signal.aborted) return fail("cancelled", "业务请求已取消，未发送请求。");
	const secret = (tool.auth?.env ? process.env[tool.auth.env] : undefined) || readCredential(tool.auth?.credential);
	if (tool.auth && !secret) return fail("authentication", "业务工具缺少凭据；请在终端配置，未发送请求。");
	const redact = (value: string) => secret ? value.split(secret).join("[REDACTED]") : value;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (secret) headers.Authorization = `Bearer ${secret}`;
	if (tool.method === "POST") headers["Content-Type"] = "application/json";
	if (tool.method === "POST" && tool.idempotencyHeader) headers[tool.idempotencyHeader] = createHash("sha256").update(key).digest("hex");
	const url = new URL(tool.url);
	if (tool.method === "GET") for (const [name, value] of Object.entries(args)) {
		if (!["string", "number", "boolean"].includes(typeof value)) return fail("validation", "GET 查询参数只支持字符串、数字和布尔值。");
		url.searchParams.set(name, String(value));
	}
	try {
		const response = await fetch(url, { method: tool.method, headers, ...(tool.method === "POST" ? { body: JSON.stringify(args) } : {}), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout((tool.timeoutSeconds ?? 30) * 1000)]) });
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = []; let size = 0; let oversized = false;
		if (reader) try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 131072) { oversized = true; await reader.cancel(); break; } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
		if (oversized) return fail(tool.method === "POST" ? "outcome_unknown" : "response_invalid", "响应超过 128 KiB，未将不完整数据当作结果；POST 远端操作状态未知，请先核对。");
		const body = redact(Buffer.concat(chunks).toString("utf8"));
		const limit = tool.maxResultChars ?? 8000;
		const text = JSON.stringify({ status: response.status, body: body.slice(0, limit), truncated: body.length > limit });
		if (response.ok) return { text, isError: false };
		if ([401, 403].includes(response.status)) return { ...fail("authentication", "接口认证或权限失败，请修正凭据后再继续。"), text };
		if (tool.method === "POST" && (response.status >= 500 || response.status === 408)) return { ...fail("outcome_unknown", "外部操作返回服务端错误或超时，远端状态未知，请先核对。"), text };
		if (response.status === 429 || response.status === 503) {
			const header = response.headers.get("retry-after");
			const at = header ? /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header) : NaN;
			return { ...fail(response.status === 429 ? "rate_limit" : "temporary", "接口暂时不可用，等待后可重试查询；不自动重复外部写操作。", tool.method === "GET", Number.isFinite(at) ? Math.max(Date.now(), at) : undefined), text };
		}
		return { ...fail(response.status >= 500 || response.status === 408 ? "temporary" : "rejected", "接口拒绝请求，请按错误修正后继续。", tool.method === "GET" && response.status >= 500), text };
	} catch {
		return tool.method === "POST" ? fail("outcome_unknown", "业务请求失败、取消或超时，远端操作状态未知；请先核对，勿盲目重试。") : fail(signal.aborted ? "cancelled" : "temporary", signal.aborted ? "业务请求已取消。" : "业务请求失败或超时，可稍后重试查询。", !signal.aborted);
	}
}

export function createBusinessTools(member: string, tools: HttpBusinessTool[] = []) {
	return tools.map((tool) => defineTool({
		name: tool.id, description: `${tool.description}（${tool.method === "GET" ? "只读查询" : "会执行外部操作"}；失败不自动重试）`,
		parameters: unsafe<Record<string, unknown>>(tool.parameters as Schema),
		replay: tool.method === "GET" || tool.idempotencyHeader ? "safe" : "unsafe",
		execute: async (args, api, context) => {
			// Conversation/task IDs are only unique inside one database. Memoize a globally unique key.
			const requestKey = await api.memo("http-request-key", randomUUID(), context);
			const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
			const argumentsHash = createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
			const blocked = await api.commit(async (tx) => {
				const operations = (await tx.doc(Operations)).operations;
				const own = operations[requestKey];
				if (own?.result) return { result: JSON.parse(JSON.stringify(own.result)) as OperationResult };
				const uncertain = Object.values(operations).find((entry) => entry.method === "POST" && entry.endpoint === tool.url && ((unresolved(entry) && (entry.id !== requestKey || !tool.idempotencyHeader)) || (entry.argumentsHash === argumentsHash && entry.resolution?.outcome === "succeeded")));
				if (tool.method === "POST" && uncertain) return { result: { text: `外部操作 ${uncertain.id} 状态待核对或已确认成功，禁止重复提交。终端 /operations 查看并人工核对远端状态。`, isError: true, failure: { kind: "outcome_unknown", message: "外部操作需要先核对远端结果。", retryable: false } } as OperationResult };
				const cooldown = Object.values(operations).find((entry) => entry.endpoint === tool.url && entry.result?.failure?.retryAt && entry.result.failure.retryAt > api.now());
				if (cooldown) return { result: { text: `接口正在限流等待，请在 ${new Date(cooldown.result!.failure!.retryAt!).toISOString()} 后重试。`, isError: true, failure: JSON.parse(JSON.stringify(cooldown.result!.failure)) } as OperationResult };
				if (!own) operations[requestKey] = { id: requestKey, member, tool: tool.id, method: tool.method, endpoint: tool.url, argumentsHash, taskId: String(api.taskId), conversationId: String(api.conversationId), status: "pending", createdAt: api.now(), updatedAt: api.now() };
				return null;
			}, context);
			if (blocked) return { output: [{ type: "text" as const, text: JSON.stringify({ ...blocked.result, operationId: requestKey }) }], isError: blocked.result.isError };
			const result = await callBusinessTool(tool, args, context.abortSignal ?? new AbortController().signal, `${requestKey}:${member}:${tool.id}`);
			await api.commit(async (tx) => {
				const operation = (await tx.doc(Operations)).operations[requestKey]!;
				operation.status = result.failure?.kind === "outcome_unknown" ? "unknown" : result.isError ? "failed" : "succeeded";
				operation.result = result; operation.updatedAt = api.now();
			}, BACKGROUND_CONTEXT);
			return { output: [{ type: "text" as const, text: JSON.stringify({ ...result, operationId: requestKey }) }], isError: result.isError };
		},
	}));
}
