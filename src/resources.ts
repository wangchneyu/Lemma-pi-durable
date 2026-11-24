import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { AppConfig } from "./config.ts";

export type ResourceClaim = { id: string; member: string; service: string; runKey: string | null; status: "queued" | "running" | "released"; reservedUsd: number; at: number; reason?: string };
export const Resources = defineDoc<{ claims: Record<string, ResourceClaim> }>({ kind: "lemma.resources", version: 1, scope: "session", initial: () => ({ claims: {} }), checkpointWhen: () => false });
export const CostLedger = defineDoc<{ entries: Record<string, { member: string; category: "member" | "repair"; costUsd: number | null; at: number }> }>({ kind: "lemma.cost-ledger", version: 1, scope: "session", initial: () => ({ entries: {} }), checkpointWhen: () => false });
export const resourceService = (config: AppConfig, member: string) => config.agents[member]?.api ? new URL(config.agents[member]!.api!.baseUrl).origin : `cli:${member}`;

/** Admission runs in a Durable transaction; sleeping callers retain only queue metadata. */
export async function admit(tx: Tx, config: AppConfig, input: { id: string; member: string; runKey: string | null; spent: number; at: number }): Promise<{ state: "ready" | "queued" | "budget"; reason?: string }> {
	const claims = (await tx.doc(Resources)).claims;
	if (claims[input.id]?.status === "running") return { state: "ready" };
	const service = resourceService(config, input.member), reserve = config.budget.reservePerDispatchUsd ?? 0;
	const policy = config.execution ?? {}, live = Object.values(claims).filter((claim) => claim.status === "running");
	const queue = Object.values(claims).filter((claim) => claim.status === "queued").sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	const reason = live.length >= (policy.maxConcurrent ?? 8) ? "等待团队并发名额" : live.filter((claim) => claim.member === input.member).length >= (policy.perMember ?? 4) ? "等待成员并发名额" : live.filter((claim) => claim.service === service).length >= (policy.perService ?? 8) ? "等待服务并发名额" : undefined;
	const existing = claims[input.id];
	const reserved = live.filter((claim) => claim.runKey === input.runKey).reduce((sum, claim) => sum + claim.reservedUsd, 0);
	if (config.budget.perRunUsd !== null && (input.spent >= config.budget.perRunUsd || input.spent + reserved + reserve > config.budget.perRunUsd)) {
		claims[input.id] = { id: input.id, member: input.member, service, runKey: input.runKey, status: "released", reservedUsd: 0, at: existing?.at ?? input.at, reason: "预算不足（含并行预留）" };
		return { state: "budget", reason: "已花费与并行预留达到预算，未启动新派工。预留为用户估计，不是实际账单上限。" };
	}
	// FIFO for callers competing for the same member/service; unrelated queues may proceed.
	const ahead = queue.some((claim) => claim.id !== input.id && (claim.at < (existing?.at ?? input.at) || (claim.at === (existing?.at ?? input.at) && claim.id.localeCompare(input.id) < 0)) && (claim.member === input.member || claim.service === service));
	const waiting = reason ?? (ahead ? "等待同服务先到任务" : undefined);
	claims[input.id] = { id: input.id, member: input.member, service, runKey: input.runKey, status: waiting ? "queued" : "running", reservedUsd: waiting ? 0 : reserve, at: existing?.at ?? input.at, ...(waiting ? { reason: waiting } : {}) };
	return waiting ? { state: "queued", reason: waiting } : { state: "ready" };
}
export async function releaseClaim(tx: Tx, id: string): Promise<void> { const claim = (await tx.doc(Resources)).claims[id]; if (claim) { claim.status = "released"; claim.reservedUsd = 0; delete claim.reason; } }
export const resourceSnapshot = (state: { claims: Record<string, ResourceClaim> } | undefined) => { const claims = Object.values(state?.claims ?? {}); return { running: claims.filter((claim) => claim.status === "running"), queued: claims.filter((claim) => claim.status === "queued"), reservedUsd: claims.reduce((sum, claim) => sum + claim.reservedUsd, 0) }; };
