import { defineDoc, type Tx } from "@earendil-works/pi-durable";

export type BusinessFailure = { kind: "validation" | "authentication" | "rate_limit" | "temporary" | "rejected" | "cancelled" | "outcome_unknown" | "response_invalid"; message: string; retryable: boolean; retryAt?: number };
export type OperationResult = { text: string; isError: boolean; failure?: BusinessFailure };
export type BusinessOperation = {
	id: string; member: string; tool: string; method: "GET" | "POST"; endpoint: string; argumentsHash: string; taskId: string; conversationId: string;
	status: "pending" | "unknown" | "succeeded" | "failed" | "resolved";
	createdAt: number; updatedAt: number; result?: OperationResult;
	resolution?: { outcome: "succeeded" | "not_applied"; evidence: string; at: number };
};
/** Intent and reconciliation are Durable documents, shared by members in this work session. */
export const Operations = defineDoc<{ operations: Record<string, BusinessOperation> }>({
	kind: "lemma.business-operations", version: 1, scope: "session", initial: () => ({ operations: {} }), checkpointWhen: () => false,
});
export const operationList = (state: { operations: Record<string, BusinessOperation> } | undefined) => Object.values(state?.operations ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
export const unresolved = (operation: BusinessOperation) => operation.status === "pending" || operation.status === "unknown";

export async function resolveOperation(tx: Tx, id: string, outcome: "succeeded" | "not_applied", evidence: string, at: number): Promise<string> {
	const operation = (await tx.doc(Operations)).operations[id];
	if (!operation || !unresolved(operation)) throw new Error("操作不存在或已完成核对。");
	if (!evidence.trim()) throw new Error("需要填写人工查询远端状态的依据。");
	const task = await tx.task(Number(operation.taskId) as any);
	if (task && !["terminal", "completing"].includes(task.state.status)) throw new Error("操作任务仍在运行，请先等待结束或取消后再核对。");
	operation.status = "resolved"; operation.updatedAt = at;
	operation.resolution = { outcome, evidence: evidence.trim().slice(0, 3000), at };
	return outcome === "succeeded" ? "已记录远端成功，原失败交付仍保留；请基于远端凭证继续核对，勿重复提交。" : "已记录远端未执行，可在明确原因后重新派工。";
}
