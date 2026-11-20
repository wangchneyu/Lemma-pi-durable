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
