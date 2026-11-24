import { defineDocFamily, defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { parseDeliverable, resultExcerpt, type Deliverable } from "./deliverables.ts";

export type MemberResult = {
	id: string; member: string; conversationId: string; submissionId: string | null; taskId: string;
	status: "done" | "unanswered"; text: string; createdAt: number;
	deliverable?: Deliverable;
	/** Durable dispatch receipt: return it on replay instead of invoking the member again. */
	dispatch?: import("./dispatch.ts").DispatchResult;
};
export const Results = defineDocFamily<{ result: MemberResult | null }, null>({
	kind: "lemma.result", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
	initial: () => ({ result: null }), checkpointWhen: () => false,
});

export interface ResultPage {
	id: string; member: string; conversationId: string; status: "done" | "unanswered";
	text: string; offset: number; nextOffset: number | null; totalChars: number;
}
export function resultPage(result: MemberResult, offset = 0, limit = 2000): ResultPage {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a nonnegative integer.");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new RangeError("limit must be between 1 and 8000.");
	const end = Math.min(result.text.length, offset + limit);
	return { id: result.id, member: result.member, conversationId: result.conversationId, status: result.status,
		text: result.text.slice(offset, end), offset, nextOffset: end < result.text.length ? end : null, totalChars: result.text.length };
}

export async function storeResult(tx: Tx, controllerId: ConversationId, result: MemberResult): Promise<void> {
	const delivery = parseDeliverable(result.text);
	if (delivery) result = { ...result, deliverable: delivery };
	const doc = await tx.doc(Results, controllerId, result.id, null);
	doc.result = result;
}

/** Retrieve full reports within the calling controller's scope. */
export function createReadResultTool() {
	return defineTool({
		name: "read_result", description: "Read a stored member result by result_id. Paginate with nextOffset; at most 8000 characters per call. Only results from this controller are accessible.",
		parameters: obj({ result_id: str(), field: opt(str({ description: "可选结构化字段，如 conclusion、data.total、evidence、artifacts、incomplete" })), offset: opt(int({ minimum: 0 })), limit: opt(int({ minimum: 1, maximum: 8000 })) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const result = (await api.snapshot(Results, api.conversationId, args.result_id, context))?.result;
			return { output: [{ type: "text" as const, text: result ? JSON.stringify({ ...resultPage(result, args.offset, args.limit), ...(args.field ? { field: args.field, ...resultExcerpt(result, args) } : {}), availableFields: result.deliverable ? Object.keys(result.deliverable) : [] }) : "Result not found in this controller." }], isError: !result };
		},
	});
}
