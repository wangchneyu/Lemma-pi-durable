// 把 Pi Durable 的条目和 pi.live 文档转换成前端直接能渲染的简单 JSON。
import type { EntryRecord } from "@earendil-works/pi-durable";

export type ViewItem =
	| { id: number; type: "user"; text: string; at?: number }
	| {
			id: number;
			type: "assistant";
			text: string;
			toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
			error?: string;
			stopReason?: string;
			at?: number;
	  }
	| { id: number; type: "tool"; callId: string; name: string; text: string; isError: boolean; details?: unknown; at?: number }
	| { id: number; type: "divider"; label: string };

export interface ViewLive {
	busy: boolean;
	turns: number;
	partial: string;
	retry?: { at: number; error: string };
	tools: { callId: string; name: string; status: string; output: string; details?: unknown }[];
	runFailure?: { reason: string; detail?: string };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text ?? ""))
		.join("");
}

export function toViewItem(entry: EntryRecord): ViewItem | undefined {
	const id = Number(entry.id);
	const message = entry.model?.[0] as any;
	switch (entry.kind) {
		case "pi.user":
			return { id, type: "user", text: textOf(message?.content), at: message?.timestamp };
		case "pi.assistant": {
			const blocks: any[] = message?.content ?? [];
			const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
			return {
				id,
				type: "assistant",
				text: textOf(blocks),
				toolCalls: blocks
					.filter((b) => b.type === "toolCall")
					.map((b) => ({ id: String(b.id), name: String(b.name), args: (b.arguments ?? {}) as Record<string, unknown> })),
				error: failed ? (message?.errorMessage ?? (message?.stopReason === "aborted" ? "已中止" : "出错")) : undefined,
				stopReason: message?.stopReason,
				at: message?.timestamp,
			};
		}
		case "pi.tool-result":
			return {
				id,
				type: "tool",
				callId: String(message?.toolCallId ?? ""),
				name: String(message?.toolName ?? ""),
				text: textOf(message?.content),
				isError: !!message?.isError,
				details: message?.details,
				at: message?.timestamp,
			};
		case "pi.reset":
			return { id, type: "divider", label: "新的上下文" };
		case "pi.compaction":
			return { id, type: "divider", label: "较早的对话已压缩为摘要" };
		default:
			return undefined;
	}
}

/** 一次派工（一个 ask_* 工具调用）从发出到结束的汇总 */
export interface Dispatch {
	/** 唯一键：发出派工的消息 id + callId（callId 本身不保证跨运行唯一） */
	key: string;
	callId: string;
	agent: string;
	task: string;
	/** 调用时传入的 session_id（续接） */
	resume: string | null;
	at?: number;
	/** 发出派工的那条总调度消息 */
	entryId?: number;
	/** open：还没有结果（正在执行，或进程中断后还没续上） */
	status: "open" | "done" | "error" | "aborted" | "interrupted";
	endAt?: number;
	resultEntryId?: number;
	durationMs?: number;
	cost?: number;
	sessionId?: string;
	cwd?: string;
	exitCode?: number | null;
	preview?: string;
	/** 实际用的模型（CLI 报告的，或派工时选的） */
	model?: string;
	/** 花费是按单价估算的（CLI 没自报） */
	costEstimated?: boolean;
	/** 隔离派工的改动编号 */
	changeId?: string;
	/** 基于哪次改动开工 */
	basedOn?: string;
}

/** 解析工具结果：去掉末尾的 [agent: … | 耗时: … | 花费: …]，识别 Pi Durable 写入的 <harness> 说明 */
export function parseToolResult(text: string, isError: boolean, details: any) {
	let body = text;
	const meta: Record<string, string> = {};
	const footer = text.match(/\n*\[(agent: [^\]]+)\]\s*$/);
	if (footer) {
		body = text.slice(0, footer.index);
		for (const part of footer[1]!.split("|")) {
			const [k, ...v] = part.split(":");
			meta[k!.trim()] = v.join(":").trim();
		}
	}
	let status: Dispatch["status"] = isError ? "error" : "done";
	const harness = text.match(/<harness>([\s\S]*?)<\/harness>\s*$/);
	if (harness) {
		const note = harness[1]!;
		if (/aborted/i.test(note)) status = "aborted";
		else if (/interrupted/i.test(note)) status = "interrupted";
		body = note
			.split("\n")
			.map((l) => l.trim().replace(/^\[(error|info|warning)\]\s*/, ""))
			.filter(Boolean)
			.join("\n");
	}
	const seconds = meta["耗时"] ? Number.parseFloat(meta["耗时"]) : undefined;
	const cost = meta["花费"] ? Number.parseFloat(meta["花费"].replace("$", "")) : undefined;
	return {
		status,
		body: body.trim(),
		sessionId: (details?.sessionId as string | undefined) ?? meta["session_id"],
		durationMs: (details?.durationMs as number | undefined) ?? (seconds !== undefined ? seconds * 1000 : undefined),
		cost: Number.isFinite(cost) ? cost : undefined,
		cwd: details?.cwd as string | undefined,
		exitCode: details?.exitCode as number | null | undefined,
	};
}

export function toViewLive(live: any): ViewLive {
	const partialBlocks = live?.generation?.message?.content;
	return {
		busy: live?.run !== undefined,
		turns: Number(live?.run?.turns ?? 0),
		partial: textOf(partialBlocks),
		retry: live?.generation?.retry,
		tools: (live?.tools ?? []).map((t: any) => ({
			callId: String(t.callId),
			name: String(t.name),
			status: String(t.status),
			output: String(t.output ?? ""),
			details: t.details,
		})),
		runFailure: live?.runFailure ? { reason: String(live.runFailure.reason), detail: live.runFailure.detail } : undefined,
	};
}
