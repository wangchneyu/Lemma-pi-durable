// Same public coding-agent components used by the upstream Durable demo.
import {
	AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
	createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
	getMarkdownTheme, getSelectListTheme, initTheme, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";

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
