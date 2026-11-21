// 在终端里实时打印总调度和各 agent 的进度。
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { JOB_REPORT_ENTRY } from "./jobs.ts";

const c = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
export const colors = c;

let sink: ((text: string) => void) | undefined;

export function setOutputSink(next: ((text: string) => void) | undefined): void { sink = next; }

export function writeLine(text = ""): void {
	if (sink) sink(text);
	else console.log(text);
}

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
	if (entry.kind === JOB_REPORT_ENTRY) {
		// 后台派工的结果发回总调度：标题行醒目，正文截一段
		const [head = "", ...body] = textOf(message.content).split("\n");
		const failed = /· (失败|已取消)】/.test(head);
		writeLine(`\n${failed ? c.red(`◆ ${head}`) : c.yellow(`◆ ${head}`)}\n${c.dim(clip(body.join("\n").replace(/\n*（这是后台派工的结果[\s\S]*$/, ""), 800))}`);
		return;
	}
	if (entry.kind === "pi.assistant") {
		for (const block of message.content ?? []) {
			if (block.type === "text" && block.text?.trim()) writeLine(`\n${c.green("总调度 ›")} ${block.text.trim()}`);
			if (block.type === "toolCall") {
				const args = block.arguments ?? {};
				const extra = c.dim(`${args.background ? " (后台)" : ""}${args.session_id ? ` (续接 ${args.session_id})` : ""}`);
				writeLine(`\n${c.cyan(`→ ${block.name}`)}${extra}\n${c.dim(clip(String(args.task ?? JSON.stringify(args)), 400))}`);
			}
		}
		if (message.stopReason === "error" && message.errorMessage) writeLine(c.red(`\n模型出错：${message.errorMessage}`));
	} else if (entry.kind === "pi.tool-result") {
		const text = textOf(message.content);
		const label = message.isError ? c.red(`✗ ${message.toolName} 失败`) : c.yellow(`✓ ${message.toolName} 完成`);
		writeLine(`\n${label}\n${c.dim(clip(text, 1200))}`);
	}
}

/** 订阅会话：打印新条目和工具的实时输出。返回停止函数。 */
export async function follow(
	root: Conversation, context: Context,
	options: { replay?: boolean; onLive?: (live: any) => void } = {},
): Promise<() => Promise<void>> {
	const watch = await root.watch(context);
	const seen = new Set(watch.value.entries.map((e) => e.id));
	const printedOutput = new Map<string, number>();
	if (options.replay) for (const entry of watch.value.entries) {
		if (entry.kind === "pi.user") writeLine(`你 › ${textOf((entry.model?.[0] as any)?.content)}`);
		else printEntry(entry);
	}
	options.onLive?.(watch.value.docs["pi.live"]);

	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const { value } = call;
		for (const entry of value.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			printEntry(entry);
		}
		const live = value.docs["pi.live"] as any;
		options.onLive?.(live);
		for (const slot of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
			const output: string | undefined = slot.output;
			if (!output) continue;
			const done = printedOutput.get(slot.callId) ?? 0;
			if (output.length > done) {
				const fresh = output.slice(done);
				printedOutput.set(slot.callId, output.length);
				for (const line of fresh.split("\n")) if (line.trim()) writeLine(c.dim(`  [${slot.name}] ${line}`));
			} else if (output.length < done) {
				printedOutput.set(slot.callId, output.length); // 输出窗口滚动了
			}
		}
	});
	return async () => {
		await watch.stop();
	};
}
