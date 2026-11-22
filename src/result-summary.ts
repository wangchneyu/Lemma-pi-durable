/** Shared by production dispatch and the context-cost ablation benchmark. */
export function summarizeResult(text: string, limit: number): string {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("摘要长度需要为正整数。");
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.floor(limit * 0.6))}\n…（中间已省略，原文 ${text.length} 字符）\n${text.slice(-Math.floor(limit * 0.4))}`;
}
