// Same public coding-agent components used by the upstream Durable demo.
import {
	AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
	createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
	getMarkdownTheme, getSelectListTheme, initTheme, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

initTheme("dark", false);
// Native tool renderers read this action to display the configured expansion shortcut.
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
	"app.tools.expand": { defaultKeys: "ctrl+e", description: "Expand tool output" },
	"app.interrupt": { defaultKeys: "escape", description: "Cancel" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Select controller model" },
	"app.session.toggleNamedFilter": { defaultKeys: "ctrl+n", description: "Filter named sessions" },
	"app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Change session sorting" },
	"app.session.togglePath": { defaultKeys: "ctrl+p", description: "Show session identifiers" },
	"app.tree.foldOrUp": { defaultKeys: ["ctrl+left", "alt+left"], description: "Fold branch" },
	"app.tree.unfoldOrDown": { defaultKeys: ["ctrl+right", "alt+right"], description: "Unfold branch" },
	"app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t", description: "Show timestamps" },
}, getKeybindings().getUserBindings()));

export { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme, getSelectListTheme };

/** Keep only presentation hooks: tool execution is always owned by Pi Durable. */
export function nativeToolRenderers(name: string, cwd: string): ToolRenderers {
	const factory = { read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition, bash: createBashToolDefinition }[name];
	if (name.startsWith("ask_") || ["plan_tasks", "update_task", "review_task", "recover_task", "read_result", "wait_jobs"].includes(name)) return {
		renderCall(rawArgs, theme, context) {
			const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
			const label = name.startsWith("ask_") ? `派工 → ${name.slice(4)}` : ({ plan_tasks: "任务规划", update_task: "更新任务", review_task: "验收任务", recover_task: "恢复任务", read_result: "读取成果", wait_jobs: "等待后台" }[name] ?? name);
			const detail = args.task ?? args.id ?? args.result_id ?? (Array.isArray(args.tasks) ? `${args.tasks.length} 项任务` : "");
			const summary = cleanText(String(detail)).replace(/\s+/g, " ");
			const metadata = [args.task_id, args.model, args.background ? "后台" : undefined, args.session_id ? "续接" : undefined, args.action, args.field].filter(Boolean).map((value) => cleanText(String(value)).replace(/\s+/g, " "));
			const text = theme.fg("toolTitle", label) + (metadata.length ? theme.fg("muted", ` · ${metadata.join(" · ")}`) : "");
			return { render: (width) => [truncateToWidth(text, Math.max(1, width)), ...(summary ? [truncateToWidth(theme.fg("muted", summary), Math.max(1, width))] : []), ...(context.expanded ? new Text(cleanText(JSON.stringify(args, null, 2)), 0, 0).render(width) : [])], invalidate() {} };
		},
		renderResult(result, options, theme, context) {
			const raw = result.content.filter((block) => block.type === "text").map((block) => "text" in block ? block.text : "").join("\n"), text = cleanText(raw);
			if (options.expanded) return new Text(text, 0, 0);
			let preview = text;
			if (["recover_task", "review_task", "read_result"].includes(name)) try {
				const value = JSON.parse(text);
				if (name === "review_task") preview = `${value.task} · ${value.action}${value.verification ? ` · 机器检查${value.verification.passed ? "通过" : "未通过"}` : ""}\n${value.evidence ?? ""}`;
				if (name === "recover_task" && value.recovery) preview = `${value.task} · ${value.recovery.action} → ${value.recovery.member} · ${value.recovery.status}\n${value.recovery.note}`;
				if (name === "read_result" && typeof value.text === "string") preview = `${value.id}${value.field ? ` · ${value.field}` : ""} · ${value.offset}/${value.totalChars} 字符\n${value.text}`;
			} catch { /* Plain failures remain visible. */ }
			const lines = preview.split("\n"), shown = lines.slice(0, 10);
			const changed = preview !== text || lines.length > shown.length;
			const body = shown.join("\n") + (changed ? `\n${context.keyHint("app.tools.expand", "查看完整参数与结果")}` : "");
			return new Text(theme.fg(context.isError ? "error" : "toolOutput", body), 0, 0);
		},
	};
	if (!["read", "write", "edit", "bash"].includes(name) || !factory) return {};
	const { renderCall, renderResult, renderShell } = factory(cwd);
	return { renderCall, renderResult, renderShell } as ToolRenderers;
}

export function cleanText(text: string): string {
	return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Filter after Markdown decodes entities; retain upstream styles and semantic prompt zones. */
export function safeNativeComponent<T extends Component>(component: T, preserveCursor = false): T {
	const render = component.render.bind(component);
	let previous: readonly string[] | undefined;
	let sanitized: string[] = [];
	component.render = (width: number) => {
		const lines = render(Math.max(1, width));
		if (lines === previous) return sanitized;
		previous = lines;
		sanitized = lines.map((line) => {
			const styles: string[] = [];
			const protectedLine = (preserveCursor ? line.split(CURSOR_MARKER).join("\ue002") : line).replace(/\x1b\[[0-9;:]*m|\x1b\]133;[ABC]\x07/g, (style) => {
				styles.push(style);
				return `\ue000${styles.length - 1}\ue001`;
			});
			const safe = cleanText(protectedLine).replace(/\ue000([0-9]+)\ue001/g, (_, index) => styles[Number(index)] ?? "");
			return preserveCursor ? safe.replace(/\ue002/g, CURSOR_MARKER) : safe;
		});
		return sanitized;
	};
	return component;
}

/** Legacy display-only callers can provide text; Durable callers retain the complete model message. */
export function assistantMessage(text: string, message?: AssistantMessage, error?: string): AssistantMessage {
	if (message) return { ...message, content: message.content.map((block) => {
		if (block.type === "text") return { ...block, text: cleanText(block.text) };
		if (block.type === "thinking") return { ...block, thinking: cleanText(block.thinking) };
		return block;
	}), errorMessage: message.errorMessage ? cleanText(message.errorMessage) : undefined };
	return { role: "assistant", content: text ? [{ type: "text", text: cleanText(text) }] : [],
		api: "openai-completions", provider: "lemma", model: "display",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: error ? "error" : "stop", errorMessage: error ? cleanText(error) : undefined, timestamp: 0 };
}
