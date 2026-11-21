import { defineDoc } from "@earendil-works/pi-durable";

export type RepairEvent = { key: string; task: string; agent: string; attempt: number; status: string; at: number };
export type VerifiedLesson = { key: string; task: string; checks: string[]; repairs: number; at: number; failure?: string; resolution?: string; changeId?: string; head?: string };
export const Learning = defineDoc<{ events: RepairEvent[]; lessons: VerifiedLesson[] }>({
	kind: "pi-agent.learning", version: 1, scope: "session",
	initial: () => ({ events: [], lessons: [] }), checkpointWhen: () => false,
});

/** 只检索与当前任务相关、经配置中的检查通过的记录；不会注入其他会话。 */
export function relevantLessons(lessons: VerifiedLesson[], task: string): string {
	const words = task.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
	const related = lessons.filter((l) => words.some((w) => l.task.toLowerCase().includes(w))).slice(-3);
	return related.map((l) => `- ${l.task.slice(0, 100)}：${l.failure ? `失败：${l.failure.slice(0, 120)}；` : ""}${l.resolution ? `执行记录（仅参考）：${l.resolution.slice(0, 160)}；` : ""}修复 ${l.repairs} 次后通过 ${l.checks.join("、")}，改动 ${l.changeId ?? "未知"}；复用前需重新验证。`).join("\n").slice(0, 1000);
}
