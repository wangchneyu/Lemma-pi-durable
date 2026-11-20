// 在终端里实时打印总调度和各 agent 的进度。
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

const c = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
export const colors = c;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text)
		.join("");
}

function clip(text: string, max: number): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function printEntry(entry: EntryRecord): void {
	const message = entry.model?.[0] as any;
	if (!message) return;
	if (entry.kind === "pi.assistant") {
		for (const block of message.content ?? []) {
			if (block.type === "text" && block.text?.trim()) console.log(`\n${c.green("总调度 ›")} ${block.text.trim()}`);
			if (block.type === "toolCall") {
				const args = block.arguments ?? {};
				const extra = args.session_id ? c.dim(` (续接 ${args.session_id})`) : "";
				console.log(`\n${c.cyan(`→ ${block.name}`)}${extra}\n${c.dim(clip(String(args.task ?? JSON.stringify(args)), 400))}`);
			}
		}
		if (message.stopReason === "error" && message.errorMessage) console.log(c.red(`\n模型出错：${message.errorMessage}`));
	} else if (entry.kind === "pi.tool-result") {
		const text = textOf(message.content);
		const label = message.isError ? c.red(`✗ ${message.toolName} 失败`) : c.yellow(`✓ ${message.toolName} 完成`);
		console.log(`\n${label}\n${c.dim(clip(text, 1200))}`);
	}
}

/** 订阅会话：打印新条目和工具的实时输出。返回停止函数。 */
export async function follow(root: Conversation, context: Context): Promise<() => Promise<void>> {
	const watch = await root.watch(context);
	const seen = new Set(watch.value.entries.map((e) => e.id));
	const printedOutput = new Map<string, number>();

	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const { value } = call;
		for (const entry of value.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			printEntry(entry);
		}
		const live = value.docs["pi.live"] as any;
		for (const slot of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
			const output: string | undefined = slot.output;
			if (!output) continue;
			const done = printedOutput.get(slot.callId) ?? 0;
			if (output.length > done) {
				const fresh = output.slice(done);
				printedOutput.set(slot.callId, output.length);
				for (const line of fresh.split("\n")) if (line.trim()) console.log(c.dim(`  [${slot.name}] ${line}`));
			} else if (output.length < done) {
				printedOutput.set(slot.callId, output.length); // 输出窗口滚动了
			}
		}
	});
	return async () => {
		await watch.stop();
	};
}
