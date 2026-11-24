import { defineDoc } from "@earendil-works/pi-durable";

export type RepairEvent = { key: string; task: string; agent: string; attempt: number; status: string; at: number };
export type VerifiedLesson = { key: string; kind?: "repair" | "integration"; task: string; files?: string[]; checks: string[]; repairs: number; at: number; failure?: string; resolution?: string; changeId?: string; head?: string };
export const Learning = defineDoc<{ events: RepairEvent[]; lessons: VerifiedLesson[] }>({
	kind: "pi-agent.learning", version: 1, scope: "session",
	initial: () => ({ events: [], lessons: [] }), checkpointWhen: () => false,
});

function normFile(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").toLowerCase();
}

/** 按任务关键词与涉及文件路径检索经配置检查通过的经验记录；不会注入其他会话。 */
export function relevantLessons(lessons: VerifiedLesson[], task: string, targetFiles: string[] = []): string {
	const words = task.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
	const files = targetFiles.map(normFile).filter(Boolean);
	const scored = lessons
		.map((l) => {
			let score = 0;
			const lessonFiles = (l.files ?? []).map(normFile);
			for (const f of files) {
				if (lessonFiles.some((lf) => lf === f || lf.startsWith(`${f}/`) || f.startsWith(`${lf}/`))) score += 3;
			}
			const lowerTask = l.task.toLowerCase();
			for (const w of words) {
				if (lowerTask.includes(w)) score += 1;
			}
			return { lesson: l, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || b.lesson.at - a.lesson.at)
		.slice(0, 3)
		.map((entry) => entry.lesson);
	return scored
		.map((l) => `- ${l.kind === "integration" ? "[集成修复] " : ""}${l.task.slice(0, 100)}${l.files?.length ? `（涉及 ${l.files.slice(0, 4).join("、")}）` : ""}：${l.failure ? `失败：${l.failure.slice(0, 120)}；` : ""}${l.resolution ? `执行记录（仅参考）：${l.resolution.slice(0, 160)}；` : ""}修复 ${l.repairs} 次后通过 ${l.checks.join("、")}，改动 ${l.changeId ?? "未知"}；复用前需重新验证。`)
		.join("\n")
		.slice(0, 1200);
}
