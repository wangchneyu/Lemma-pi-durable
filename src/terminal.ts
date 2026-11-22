// Pi TUI renders committed Durable views; runtime owns dispatch and persistence.
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Input,
	getKeybindings,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	truncateToWidth,
	TuiAltScreen,
	VStack,
	type Component,
	type OverlayHandle,
	type Terminal,
} from "@earendil-works/pi-tui";
import { colors as c } from "./printer.ts";
import { CustomEditor, ModelSelectorComponent, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { nativeSessions, nativeConversationTree, type ConversationChoice } from "./native-selectors.ts";
import type { Model } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
	getMarkdownTheme, getSelectListTheme, nativeToolRenderers, safeNativeComponent, assistantMessage, cleanText,
} from "./native-terminal-components.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TerminalConversationView, TerminalItem, TerminalTool } from "./terminal-state.ts";
import type { NativeModelCatalog } from "./model-selection.ts";
export const TERMINAL_COMMANDS = [
	["agents", "成员和模型"],
	["agent", "add / edit / show / enable / disable / model / key 成员配置"],
	["setup", "引导配置总控模型、接口与凭据"],
	["tool", "list / add / edit / key / remove 成员业务工具"],
	["help", "终端操作与成员配置命令"],
	["web", "后台网页"],
	["usage", "用量"],
	["goal", "项目目标"],
	["tasks", "分工表"],
	["result", "按 result_id 分页查看完整成员结果，不调用模型"],
	["rules", "共同规则"],
	["jobs", "后台任务"],
	["queue", "排到下一轮"],
	["continue", "续跑"],
	["compact", "压缩上下文"],
	["abort", "中止本轮；all 连后台一起停"],
	["changes", "待合并改动"],
	["diff", "查看改动"],
	["apply", "应用改动"],
	["drop", "丢弃改动"],
	["clean", "清理工作副本"],
	["new", "新上下文"],
	["exit", "退出"],
	["quit", "退出"],
	["sessions", "列出隔离会话"],
	["session", "new / use / rename 会话"],
	["conversations", "搜索会话与子对话"],
	["taskgraph", "原生任务面板"],
	["tree", "原生对话关系树"],
	["model", "原生总控模型选择"],
	["main", "返回总控"],
	["members", "成员上下文"],
	["learn", "已验证的修复记录"],
	["repair", "自动修复状态"],
	["conversation", "总控对话 ID 与隔离边界"],
	["id", "当前对话 ID"],
].map(([name, description]) => ({ name: name!, description: description! }));
/** Untrusted output cannot change cursor position, title or terminal modes. */
export const terminalText = cleanText;
const plain = (text: unknown, limit = 20_000) => terminalText(String(text ?? "")).slice(0, limit);
const selectTheme = getSelectListTheme();
/** Reuse native editing/paste behavior; credentials never enter the rendered screen. */
class SettingsInput extends Input {
	secret = false;
	override render(width: number): string[] {
		return this.secret ? ["•".repeat(Math.min(Math.max(0, width - 2), this.getValue().length)) + "▏"] : super.render(width);
	}
}
class Line implements Component {
	private readonly value: () => string;
	constructor(value: () => string) {
		this.value = value;
	}
	render(width: number): string[] {
		return [truncateToWidth(this.value(), Math.max(1, width))];
	}
	invalidate(): void {}
}
/** Isolate input history without replacing Editor or using private framework fields. */
class ConversationEditor extends CustomEditor {
	private histories = new Map<string, string[]>();
	private key = "";
	private browsing = -1;
	private draft = "";
	private killedText = "";
	bindHistory(key: string): void {
		this.key = key;
		this.browsing = -1;
		this.draft = "";
		this.killedText = "";
		// A blank native submit resets undo, paste and navigation state without sending input.
		const submit = this.onSubmit,
			change = this.onChange;
		this.onSubmit = undefined;
		this.onChange = undefined;
		try {
			super.setText("");
			super.handleInput("\r");
		} finally {
			this.onSubmit = submit;
			this.onChange = change;
		}
	}
	override addToHistory(text: string): void {
		const values = this.histories.get(this.key) ?? [];
		if (text.trim() && values.at(-1) !== text) values.push(text);
		this.histories.set(this.key, values.slice(-100));
		this.browsing = -1;
	}
	override handleInput(data: string): void {
		const keys = getKeybindings();
		// The public Editor has no kill-ring reset; keep yank in this binding too.
		if (keys.matches(data, "tui.editor.yank")) {
			if (this.killedText) this.insertTextAtCursor(this.killedText);
			return;
		}
		if (keys.matches(data, "tui.editor.yankPop")) return;
		const history = this.histories.get(this.key) ?? [];
		if (matchesKey(data, "up") && history.length && (this.browsing >= 0 || !this.getText())) {
			if (this.browsing < 0) this.draft = this.getExpandedText();
			this.browsing = Math.min(history.length - 1, this.browsing + 1);
			super.setText(history[history.length - 1 - this.browsing]!);
			return;
		}
		if (matchesKey(data, "down") && this.browsing >= 0) {
			this.browsing--;
			super.setText(this.browsing < 0 ? this.draft : history[history.length - 1 - this.browsing]!);
			return;
		}
		if (!matchesKey(data, "up") && !matchesKey(data, "down")) this.browsing = -1;
		const cutting = [
			"tui.editor.deleteWordBackward",
			"tui.editor.deleteWordForward",
			"tui.editor.deleteToLineStart",
			"tui.editor.deleteToLineEnd",
		].some((action) => keys.matches(data, action as "tui.editor.deleteWordBackward"));
		const before = cutting ? this.getExpandedText() : "";
		super.handleInput(data);
		if (cutting) {
			const after = this.getExpandedText();
			let left = 0;
			while (left < after.length && before[left] === after[left]) left++;
			let right = 0;
			while (right < after.length - left && before[before.length - right - 1] === after[after.length - right - 1])
				right++;
			this.killedText = before.slice(left, before.length - right);
		}
	}
}
const TOOL_STATUS: Record<string, string> = {
	running: "执行中",
	pending: "排队",
	waiting: "等待中",
	sleeping: "等待中",
	done: "完成",
	error: "失败",
	aborted: "已中止",
	interrupted: "已中断",
	completing: "收尾中",
	open: "等待结果",
};
export interface TerminalStatus {
	busy: boolean;
	jobs: string[];
	spent: number;
	budget: number | null;
	pending: number;
}
export interface TerminalBinding {
	workdir: string;
	model: string;
	demo: boolean;
	web?: string;
	session?: string;
	conversationId?: string;
	conversationLabel?: string;
}
export interface TerminalTask {
	id: string;
	kind: string;
	status: string;
	conversationId: string;
	owner?: string;
	label?: string;
}
export interface TerminalConversation extends ConversationChoice {}
export interface AgentTerminalOptions extends TerminalBinding {
	onSubmit(text: string): void;
	onInterrupt(): void;
	onExit(): void;
	onSessionNext?(): void;
	onSessionNew?(): void;
	onConversations?(): void;
	onTree?(): void;
	onModels?(): void;
	onConversationSelect?(id: string): void;
	terminal?: Terminal;
}
export class AgentTerminal {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	private binding: TerminalBinding;
	private options: AgentTerminalOptions;
	private readonly transcript = new Container();
	private readonly notices = new Container();
	private readonly partial = safeNativeComponent(new AssistantMessageComponent(undefined, true));
	private readonly liveTools = new Container();
	private readonly taskPanel = new Text("", 1, 0);
	private readonly scroll: ScrollView;
	private status: TerminalStatus = { busy: false, jobs: [], spent: 0, budget: null, pending: 0 };
	private blocks: { component: Text; size: number }[] = [];
	private cards = new Map<string, AssistantMessageComponent | UserMessageComponent | ToolExecutionComponent | Text>();
	private liveCards = new Map<string, ToolExecutionComponent>();
	private renderedItems = new WeakMap<Component, TerminalItem>();
	private renderedTools = new WeakMap<ToolExecutionComponent, string>();
	private view?: TerminalConversationView;
	private tasks: TerminalTask[] = [];
	private tasksVisible = false;
	private toolsExpanded = false;
	private thinkingHidden = true;
	private picker?: OverlayHandle;
	private disposePicker?: () => void;
	private size = 0;
	private stopped = false;
	private started = false;
	private lastUser?: number;
	constructor(options: AgentTerminalOptions) {
		this.options = options;
		this.binding = { ...options };
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: false });
		this.editor = new ConversationEditor(
			this.tui,
			{ borderColor: c.cyan, selectList: selectTheme },
			getKeybindings() as ConstructorParameters<typeof CustomEditor>[2],
			{ paddingX: 1, autocompleteMaxVisible: 5 },
		);
		(this.editor as CustomEditor).onAction("app.model.select", () => options.onModels?.());
		this.editor.onSubmit = (text) => {
			if (this.stopped || !text.trim()) return;
			this.editor.addToHistory(text);
			this.scroll.scrollToEnd();
			options.onSubmit(text);
		};
		const document = new Container();
		document.addChild(this.transcript);
		document.addChild(this.partial);
		document.addChild(this.liveTools);
		document.addChild(this.notices);
		this.scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
		this.tui.setLayoutRoot(
			new VStack([
				{
					component: new Line(() => {
						const b = this.binding;
						return (
							c.cyan(
								` Lemma${b.demo ? " · 演示模式" : ""}${b.session ? ` · ${plain(b.session)}` : ""}${b.conversationId ? ` · ${plain(b.conversationLabel ?? "总控 CID")}:${plain(b.conversationId)}` : ""}`,
							) + c.dim(`  ${plain(b.model)}`)
						);
					}),
					shrink: 0,
				},
				{
					component: new Line(() =>
						c.dim(
							` ${plain(this.binding.workdir)}${this.binding.web ? `  后台：${plain(this.binding.web)}` : ""}`,
						),
					),
					shrink: 0,
					visible: ({ height }) => height >= 10,
				},
				{ component: this.scroll, basis: 0, grow: 1, minSize: 1 },
				{
					component: this.taskPanel,
					maxSize: 7,
					shrink: 1,
					visible: ({ height }) => this.tasksVisible && height >= 14,
				},
				{ component: new Line(() => this.statusLine()), shrink: 0 },
				{ component: this.editor, maxSize: 9, minSize: 3 },
				{
					component: new Line(() =>
						c.dim(
							" Enter 发送 · Ctrl+K 会话 · Alt+C 树 · Ctrl+L 模型 · Ctrl+T 任务 · Ctrl+E 工具 · Alt+T 思考",
						),
					),
					shrink: 0,
					visible: ({ height }) => height >= 10,
				},
			]),
		);
		this.bind(options);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (this.picker) {
				if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+k")) {
					this.closePicker();
					return { consume: true };
				}
				return undefined;
			}
			if (matchesKey(data, "ctrl+k") && options.onConversations) {
				options.onConversations();
				return { consume: true };
			}
			if (matchesKey(data, "alt+c") && options.onTree) { options.onTree(); return { consume: true }; }
			if (matchesKey(data, "ctrl+t")) {
				this.toggleTasks();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+e")) {
				this.toolsExpanded = !this.toolsExpanded;
				if (this.view) this.applyConversation(this.view);
				return { consume: true };
			}
			if (matchesKey(data, "alt+t")) {
				this.thinkingHidden = !this.thinkingHidden;
				this.partial.setHideThinkingBlock(this.thinkingHidden);
				for (const card of this.cards.values()) if (card instanceof AssistantMessageComponent) card.setHideThinkingBlock(this.thinkingHidden);
				this.tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+o") && options.onSessionNext) {
				options.onSessionNext();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+n") && options.onSessionNew) {
				options.onSessionNew();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				options.onInterrupt();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d") && !this.editor.getExpandedText()) {
				options.onExit();
				return { consume: true };
			}
			return undefined;
		});
	}
	bind(binding: TerminalBinding, draft = ""): void {
		if (this.stopped) return;
		this.closePicker();
		this.binding = { ...binding };
		this.transcript.clear();
		this.notices.clear();
		this.partial.updateContent(assistantMessage(""));
		this.liveTools.clear();
		this.cards.clear();
		this.liveCards.clear();
		this.blocks = [];
		this.size = 0;
		this.view = undefined;
		this.lastUser = undefined;
		this.tasks = [];
		this.status = { busy: false, jobs: [], spent: 0, budget: null, pending: 0 };
		(this.editor as ConversationEditor).bindHistory(`${binding.session ?? ""}:${binding.conversationId ?? ""}`);
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(TERMINAL_COMMANDS, binding.workdir));
		this.editor.setText(draft);
		this.renderTasks();
		this.scroll.scrollToEnd();
		this.tui.requestRender();
	}
	private statusLine(): string {
		const s = this.status,
			label = this.binding.conversationLabel?.includes("只读") ? "子对话" : "总调度",
			state = s.busy ? c.yellow(`${label}运行中`) : c.green(`${label}空闲`),
			budget = `$${s.spent.toFixed(3)}${s.budget === null ? "" : ` / $${s.budget.toFixed(2)}`}`;
		return ` ${state} · 成员 ${budget} · 待合并 ${s.pending}${s.jobs.length ? ` · 后台 ${s.jobs.map(terminalText).join(" / ")}` : " · 后台无任务"}`;
	}
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.tui.start();
	}
	write(text: string): void {
		if (this.stopped) return;
		const safe = terminalText(text).slice(-20_000);
		if (!safe.trim()) return;
		const component = new Text(`${safe}\n`, 1, 0);
		this.blocks.push({ component, size: safe.length });
		this.size += safe.length;
		this.notices.addChild(component);
		this.scroll.scrollToEnd();
		while (this.blocks.length > 60 || this.size > 30_000) {
			const first = this.blocks.shift()!;
			this.size -= first.size;
			this.notices.removeChild(first.component);
		}
		this.tui.requestRender();
	}
	setPartial(text: string, message?: AssistantMessage): void {
		if (this.stopped) return;
		this.partial.updateContent(assistantMessage(text, message), true);
		this.tui.requestRender();
	}
	setStatus(status: TerminalStatus): void {
		if (this.stopped) return;
		this.status = status;
		this.tui.requestRender();
	}
	setModel(model: string): void { this.binding.model = model; this.tui.requestRender(); }
	applyConversation(view: TerminalConversationView): void {
		if (this.stopped) return;
		const retained: TerminalItem[] = [];
		let size = 0;
		for (const item of view.items.slice(-250).reverse()) {
			const next = JSON.stringify(item).length;
			if (retained.length && size + next > 120_000) break;
			retained.unshift(item);
			size += next;
		}
		this.view = { ...view, items: retained };
		const lastUser = retained.findLast((item) => item.type === "user")?.id;
		if (lastUser !== undefined && lastUser !== this.lastUser) {
			// New committed input starts the next interaction, without old command output below it.
			this.notices.clear();
			this.blocks = [];
			this.size = 0;
			this.lastUser = lastUser;
		}
		// Providers may reuse call IDs in later runs: pair results with the preceding call entry.
		const results = new Map<string, Extract<TerminalItem, { type: "tool" }>>(),
			pending = new Map<string, string>(),
			pairedResults = new Set<number>();
		for (const item of retained) {
			if (item.type === "assistant")
				for (const call of item.toolCalls) pending.set(call.id, `tool:${item.id}:${call.id}`);
			if (item.type === "tool") {
				const key = pending.get(item.callId);
				if (key) {
					results.set(key, item);
					pairedResults.add(item.id);
					pending.delete(item.callId);
				}
			}
		}
		const activeTools: TerminalTool[] = view.tools ?? view.live.tools;
		const live = new Map(activeTools.map((tool) => [tool.callId, tool]));
		const emitted = new Set<string>(),
			used = new Set<string>();
		const children: Component[] = [];
		const message = (item: TerminalItem) => {
			const key = `entry:${item.id}`;
			let card = this.cards.get(key);
			if (item.type === "user") {
				if (!(card instanceof UserMessageComponent)) card = safeNativeComponent(new UserMessageComponent(terminalText(item.text), getMarkdownTheme(), 1));
			} else if (item.type === "assistant") {
				if (!(card instanceof AssistantMessageComponent)) card = safeNativeComponent(new AssistantMessageComponent(undefined, this.thinkingHidden));
				if (this.renderedItems.get(card) !== item) card.updateContent(assistantMessage(item.text, item.message?.role === "assistant" ? item.message : undefined, item.error));
			} else {
				if (!(card instanceof Text)) card = new Text("", 1, 0);
				card.setText(item.type === "job" ? `${c.yellow(`后台结果 ${plain(item.job)} · ${plain(item.agent)} · ${TOOL_STATUS[item.status] ?? plain(item.status)}`)}\n${plain(item.text)}` : item.type === "divider" ? c.dim(`── ${plain(item.label)} ──`) : "");
			}
			this.cards.set(key, card!);
			this.renderedItems.set(card!, item);
			used.add(key);
			children.push(card!);
		};
		const updateTool = (card: ToolExecutionComponent, result: Extract<TerminalItem, { type: "tool" }> | undefined, active: TerminalTool | undefined) => {
			const signature = JSON.stringify([result, active, this.toolsExpanded]);
			if (this.renderedTools.get(card) === signature) return;
			this.renderedTools.set(card, signature);
			if (active?.args) card.updateArgs(active.args);
			if (active?.argsComplete !== false) card.setArgsComplete();
			if (result || active) {
				if (result || active?.status !== "pending") card.markExecutionStarted();
				const raw = result?.message?.role === "toolResult" ? result.message : undefined;
				card.updateResult({
					content: raw?.content ?? [{ type: "text", text: terminalText(result?.text ?? active?.output ?? "") }],
					details: result?.details ?? active?.details,
					isError: result?.isError ?? active?.isError ?? ["error", "aborted", "interrupted"].includes(active?.status ?? ""),
				}, !result && !!active && !["done", "error", "aborted", "interrupted"].includes(active.status));
			} else card.updateResult({ content: [{ type: "text", text: "执行已中断，等待续跑" }], isError: true });
			card.setExpanded(this.toolsExpanded);
		};
		const tool = (
			key: string,
			callId: string,
			name: string,
			args: Record<string, unknown>,
			result?: Extract<TerminalItem, { type: "tool" }>,
		) => {
			let card = this.cards.get(key);
			if (!(card instanceof ToolExecutionComponent)) {
				card = safeNativeComponent(new ToolExecutionComponent(plain(name, 100), callId, args, { showImages: false }, nativeToolRenderers(name, this.binding.workdir), this.tui, this.binding.workdir));
				this.cards.set(key, card);
			}
			const active = pending.get(callId) === key ? live.get(callId) : undefined;
			updateTool(card, result, active);
			used.add(key);
			if (active) emitted.add(callId);
			children.push(card);
		};
		for (const item of retained) {
			if (item.type === "user" || item.type === "assistant" || item.type === "job" || item.type === "divider") message(item);
			if (item.type === "assistant") {
				for (const call of item.toolCalls) {
					const key = `tool:${item.id}:${call.id}`;
					tool(
						key,
						call.id,
						call.name,
						call.args,
						results.get(key),
					);
				}
			}
			if (item.type === "tool" && !pairedResults.has(item.id))
				tool(`result:${item.id}`, item.callId, item.name, {}, item);
		}
		for (const key of this.cards.keys()) if (!used.has(key)) this.cards.delete(key);
		if (
			children.length !== this.transcript.children.length ||
			children.some((child, index) => this.transcript.children[index] !== child)
		) {
			this.transcript.clear();
			for (const child of children) this.transcript.addChild(child);
		}
		const liveChildren: Component[] = [],
			liveUsed = new Set<string>();
		for (const active of activeTools) {
			if (emitted.has(active.callId)) continue;
			let card = this.liveCards.get(active.callId);
			if (!card) {
				card = safeNativeComponent(new ToolExecutionComponent(plain(active.name, 100), active.callId, active.args ?? {}, { showImages: false }, nativeToolRenderers(active.name, this.binding.workdir), this.tui, this.binding.workdir));
				this.liveCards.set(active.callId, card);
			}
			updateTool(card, undefined, active);
			liveChildren.push(card);
			liveUsed.add(active.callId);
		}
		for (const key of this.liveCards.keys()) if (!liveUsed.has(key)) this.liveCards.delete(key);
		if (
			liveChildren.length !== this.liveTools.children.length ||
			liveChildren.some((child, index) => this.liveTools.children[index] !== child)
		) {
			this.liveTools.clear();
			for (const child of liveChildren) this.liveTools.addChild(child);
		}
		this.setPartial(view.live.partial, view.partialMessage);
		this.tui.requestRender();
	}
	applyTasks(tasks: TerminalTask[]): void {
		if (this.stopped) return;
		this.tasks = tasks;
		this.renderTasks();
		this.tui.requestRender();
	}
	private renderTasks(): void {
		const lines = [c.cyan(`原生任务 · ${this.tasks.length} 项 · Ctrl+T 收起`)];
		for (const task of this.tasks.slice(0, 5))
			lines.push(
				`${plain(task.id, 14)} · ${TOOL_STATUS[task.status] ?? plain(task.status, 30)} · ${plain(task.label ?? task.kind, 100)} · 对话 ${plain(task.conversationId, 20)}${task.owner ? ` ← ${plain(task.owner, 12)}` : ""}`,
			);
		if (!this.tasks.length) lines.push(c.dim("当前没有活动任务"));
		else if (this.tasks.length > 5) lines.push(c.dim(`另有 ${this.tasks.length - 5} 项活动任务`));
		this.taskPanel.setText(lines.join("\n"));
	}
	toggleTasks(): void {
		if (this.stopped) return;
		this.tasksVisible = !this.tasksVisible;
		this.renderTasks();
		this.tui.requestRender();
	}
	showConversations(items: TerminalConversation[]): void {
		if (this.stopped) return;
		this.closePicker();
		const picker = nativeSessions(items, (id) => { this.closePicker(); this.options.onConversationSelect?.(id); }, () => this.closePicker(), () => this.tui.requestRender());
		picker.addChild(new Text(c.dim("切换会话 / 查看子对话 · 仅导航，旧记录保留"), 1, 0));
		this.picker = this.tui.showOverlay(picker, { width: "88%", maxHeight: "85%", anchor: "center", margin: 1 });
		this.disposePicker = () => picker.getSessionList().onCancel?.();
		this.tui.requestRender();
	}
	showConversationTree(items: TerminalConversation[]): void {
		if (this.stopped) return;
		this.closePicker();
		const picker = nativeConversationTree(items, this.tui.terminal.rows, (id) => { this.closePicker(); this.options.onConversationSelect?.(id); }, () => this.closePicker());
		picker.getTreeList().onLabelEdit = undefined;
		this.picker = this.tui.showOverlay(picker, { width: "92%", maxHeight: "90%", anchor: "center", margin: 1 });
		this.tui.requestRender();
	}
	showModels(runtime: NativeModelCatalog, current: Model<any> | undefined, choices: readonly Model<any>[], select: (model: Model<any>) => void): void {
		if (this.stopped) return;
		this.closePicker();
		// Upstream types the catalog as ModelRuntime; the version-pinned selector calls only NativeModelCatalog's four methods.
		const picker = safeNativeComponent(new ModelSelectorComponent(this.tui, current, runtime as ModelRuntime, choices.map((model) => ({ model })), (model) => { this.closePicker(); select(model); }, () => this.closePicker()), true);
		this.picker = this.tui.showOverlay(picker, { width: "92%", maxHeight: "90%", anchor: "center", margin: 1 });
		this.disposePicker = () => picker.dispose();
		this.tui.requestRender();
	}
	question(options: { title: string; value?: string; secret?: boolean }): Promise<string> {
		if (this.stopped) return Promise.reject(new Error("终端已关闭。"));
		this.closePicker();
		return new Promise((resolve, reject) => {
			const input = new SettingsInput({ placeholder: options.value ? `留空保留：${plain(options.value, 180)}` : "请输入" });
			input.secret = options.secret === true;
			const panel = new Container();
			panel.addChild(new Text(c.cyan(plain(options.title, 300)), 1, 1));
			panel.addChild(input);
			panel.addChild(new Text(c.dim("Enter 确认 · Esc / Ctrl+C 取消（不会发送给模型）"), 1, 1));
			let settled = false;
			input.onSubmit = (value) => { settled = true; input.setValue(""); this.closePicker(); resolve(value); };
			input.onEscape = () => this.closePicker();
			this.picker = this.tui.showOverlay(panel, { width: "88%", maxHeight: "85%", anchor: "center", margin: 1 });
			this.disposePicker = () => { input.setValue(""); if (!settled) reject(new Error("配置已取消，未保存。")); };
			this.tui.setFocus(input); this.tui.requestRender();
		});
	}
	private closePicker(): void {
		if (!this.picker) return;
		const picker = this.picker, dispose = this.disposePicker;
		this.picker = undefined;
		this.disposePicker = undefined;
		picker.hide();
		dispose?.();
		this.tui.setFocus(this.editor);
	}
	stop(): void {
		if (this.stopped) return;
		this.closePicker();
		this.stopped = true;
		if (this.started) this.tui.stop();
	}
}
