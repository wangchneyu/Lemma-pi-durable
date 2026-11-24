import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { colors as c } from "./printer.ts";
import { cleanText } from "./native-terminal-components.ts";

/** Fit both ends without counting ANSI styling or splitting wide characters. */
export function terminalRow(left: string, right: string, width: number): string {
	const available = Math.max(1, width);
	if (!right || available < 54) return truncateToWidth(left, available);
	const tail = truncateToWidth(right, Math.min(Math.floor(available * 0.4), visibleWidth(right)));
	const head = truncateToWidth(left, Math.max(1, available - visibleWidth(tail) - 2));
	return head + " ".repeat(Math.max(1, available - visibleWidth(head) - visibleWidth(tail))) + tail;
}
export function conversationWelcome(width: number, readOnly: boolean): string[] {
	const lines = readOnly ? [
		c.cyan("  成员对话 · 只读"),
		"  这里展示成员自己的消息与执行记录。",
		c.dim("  /main 返回总控 · Ctrl+K 切换会话"),
	] : [
		c.cyan("  Lemma · 从一个目标开始"),
		"  直接提问，或描述需要团队协作完成的任务。",
		c.dim("  /agent 添加成员   /sessions 管理对话"),
		c.dim("  /tasks 查看成果   /task 恢复受阻任务"),
		c.dim("  Enter 发送 · Ctrl+J 换行 · /help 命令"),
	];
	return ["", ...lines.map((line) => truncateToWidth(line, Math.max(1, width))), ""];
}
export const terminalLabel = (value: unknown, limit = 100) => cleanText(String(value ?? "")).replace(/\s+/g, " ").slice(0, limit);
