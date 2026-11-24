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
	visibleWidth,
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
import { conversationWelcome, terminalLabel, terminalRow } from "./terminal-layout.ts";
export const TERMINAL_COMMANDS = [
	["agents", "成员和模型"],
	["agent", "add / edit / show / enable / disable / model / key 成员配置"],
	["setup", "引导配置总控模型、接口与凭据"],
	["tool", "list / add / edit / key / remove / test 成员业务工具"],
	["limits", "查看并发和预算；edit 引导修改限制"],
	["progress", "运行、排队与预留；定位等待原因"],
	["mcp", "add / refresh / remove / list 成员 MCP 只读工具"],
	["help", "终端操作与成员配置命令"],
	["history", "加载当前对话更早的记录，不调用模型"],
	["thinking", "展开或收起模型返回的思考记录"],
	["web", "后台网页"],
	["usage", "用量"],
	["goal", "项目目标"],
	["tasks", "分工表"],
	["ready", "查看就绪队列、依赖等待原因和自动派发授权"],
	["workflow", "status / pause / resume 自动协作状态和暂停恢复"],
	["task", "inspect / resume / supply / reassign / cancel 受阻任务恢复"],
	["result", "按 result_id 分页查看完整成员结果，不调用模型"],
	["operations", "查看业务操作；resolve 人工核对未知远端状态"],
	["rules", "共同规则"],
	["jobs", "后台任务"],
	["queue", "排到下一轮"],
	["continue", "续跑"],
	["compact", "压缩上下文"],
	["abort", "中止本轮；all 连后台一起停"],
	["changes", "待合并改动"],
	["integrate", "create / list / show / cancel 多分支联合集成与检查"],
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
	private readonly value: (width: number) => string;
	constructor(value: (width: number) => string) {
		this.value = value;
	}
	render(width: number): string[] {
		return [truncateToWidth(this.value(width), Math.max(1, width))];
	}
	invalidate(): void {}
}
/** Observe native scroll boundaries without intercepting its keyboard, mouse or selection input. */
class HistoryScrollView extends ScrollView {
	private readonly onReachStart: () => void;
	constructor(component: Component, onReachStart: () => void) {
		super(component, { follow: "end", primary: true, scrollbar: "auto" });
		this.onReachStart = onReachStart;
	}
	override updateLayout(height: number, viewport: number, requestRender: () => void): void {
		super.updateLayout(height, viewport, requestRender);
		if (!this.isFollowingEnd && this.scrollTop <= this.viewportHeight) this.onReachStart();
	}
}
/** Isolate input history without replacing Editor or using private framework fields. */
class ConversationEditor extends CustomEditor {
	caption: () => string = () => "输入消息";
	override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0 || width < 24) return super.renderTopBorder(width, hiddenLineCount);
		const label = truncateToWidth(` ${this.caption()} `, Math.max(1, width - 4));
		return this.borderColor("──" + label + "─".repeat(Math.max(0, width - visibleWidth(label) - 2)));
	}
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
	private readonly partial = safeNativeComponent(new AssistantMessageComponent(undefined, false));
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
	private thinkingHidden = false;
	private picker?: OverlayHandle;
	private disposePicker?: () => void;
	private size = 0;
	private stopped = false;
	private started = false;
	private lastUser?: number;
	private unread = 0;
	private seenEntries = new Set<number>();
	private newestEntry = -Infinity;
	private readonly messageFrames = new Map<string, Container>();
	private readonly failure = new Text("", 1, 0);
	private historyRequest?: object;
	private historyAutoBlocked = false;
	constructor(options: AgentTerminalOptions) {
		this.options = options;
		this.binding = { ...options };
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: true, wheelScrollLines: "auto" });
		this.editor = new ConversationEditor(
			this.tui,
			{ borderColor: c.cyan, selectList: selectTheme },
			getKeybindings() as ConstructorParameters<typeof CustomEditor>[2],
			{ paddingX: 1, autocompleteMaxVisible: 5 },
		);
		(this.editor as CustomEditor).onAction("app.model.select", () => options.onModels?.());
		(this.editor as ConversationEditor).caption = () => this.readOnly ? "只读浏览 · /main 返回总控" : this.status.busy ? "补充本轮要求 · Ctrl+C 中止" : "输入消息 · / 查看命令";
		this.editor.onSubmit = (text) => {
			if (this.stopped || !text.trim()) return;
			this.editor.addToHistory(text);
			this.scroll.scrollToEnd();
			this.unread = 0;
			options.onSubmit(text);
		};
		const document = new Container();
		document.addChild(new Line(() => c.dim(this.view?.history?.loading ? " 正在加载更早记录…" : this.view?.history?.hasEarlier ? " 向上滚动加载更早记录 · /history" : this.view?.items.length ? " 已到对话开头" : "")));
		document.addChild({ render: (width) => !this.view?.items.length && !this.status.busy && !this.view?.live.partial && !this.view?.live.runFailure && !(this.view?.tools ?? this.view?.live.tools)?.length ? conversationWelcome(width, this.readOnly) : [], invalidate() {} });
		document.addChild(this.transcript);
		document.addChild({ render: (width) => this.view?.live.partial || this.view?.partialMessage?.content.some((block) => block.type === "thinking") ? [truncateToWidth(c.dim(this.readOnly ? " 成员 · 正在回答" : " Lemma · 正在回答"), Math.max(1, width))] : [], invalidate() {} });
		document.addChild(this.partial);
		document.addChild(this.liveTools);
		document.addChild(this.notices);
		document.addChild(this.failure);
		this.scroll = new HistoryScrollView(document, () => {
			if (!this.historyAutoBlocked && !this.historyRequest && this.view?.history?.hasEarlier && !this.view.history.loading)
				queueMicrotask(() => { if (!this.stopped && !this.historyAutoBlocked && !this.scroll.isFollowingEnd && this.scroll.scrollTop <= this.scroll.viewportHeight) void this.loadEarlier(); });
		});
		this.tui.setLayoutRoot(
			new VStack([
				{
					component: new Line((width) => {
						const b = this.binding;
						return terminalRow(
							c.cyan(
								` Lemma${b.session ? ` · ${terminalLabel(b.session)}` : ""}${b.conversationId ? ` · ${terminalLabel(b.conversationLabel ?? "总控 CID")}:${terminalLabel(b.conversationId)}` : ""}`,
							), c.dim(terminalLabel(b.model)), width
						);
					}),
					shrink: 0,
				},
				{
					component: new Line(() =>
						c.dim(
							` ${terminalLabel(this.binding.workdir, 500)}${this.binding.web ? `  后台网页：${terminalLabel(this.binding.web, 200)}` : ""}`,
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
				{ component: new Line((width) => this.statusLine(width)), shrink: 0 },
				{ component: this.editor, maxSize: 9, minSize: 3 },
				{
					component: new Line((width) => this.helpLine(width)),
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
			if (matchesKey(data, "alt+end")) { this.scroll.scrollToEnd(); this.unread = 0; this.tui.requestRender(); return { consume: true }; }
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
				this.toggleThinking();
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
		this.historyRequest = undefined;
		this.historyAutoBlocked = false;
		this.tui.resetTextSelection();
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
		this.unread = 0; this.seenEntries.clear(); this.newestEntry = -Infinity; this.messageFrames.clear(); this.failure.setText("");
		this.tasks = [];
		this.status = { busy: false, jobs: [], spent: 0, budget: null, pending: 0 };
		(this.editor as ConversationEditor).bindHistory(`${binding.session ?? ""}:${binding.conversationId ?? ""}`);
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(TERMINAL_COMMANDS, binding.workdir));
		this.editor.setText(draft);
		this.renderTasks();
		this.scroll.scrollToEnd();
		this.tui.requestRender();
	}
	private get readOnly(): boolean { return this.binding.conversationLabel?.includes("只读") ?? false; }
	private helpLine(width: number): string {
		if (!this.scroll.isFollowingEnd) return c.yellow(` 正在翻阅${this.unread ? ` · ${this.unread} 条新内容` : ""} · Alt+End 回到最新`);
		if (this.readOnly) return c.dim(" 只读 · /main 返回总控 · PgUp/PgDn 翻阅 · Ctrl+K 会话");
		return c.dim(width < 54 ? " 滚轮翻阅 · Alt+T 思考 · /help" : width < 100 ? " Enter 发送 · 滚轮/PgUp 翻阅 · Alt+T 思考 · /help" : " Enter 发送 · Ctrl+J 换行 · 滚轮/PgUp/PgDn 翻阅 · Alt+T 思考 · Ctrl+K 会话 · /help");
	}
	toggleThinking(): void {
		this.thinkingHidden = !this.thinkingHidden;
		this.partial.setHideThinkingBlock(this.thinkingHidden);
		for (const card of this.cards.values()) if (card instanceof AssistantMessageComponent) card.setHideThinkingBlock(this.thinkingHidden);
		this.tui.flash(`思考记录：${this.thinkingHidden ? "已折叠" : "已展开"} · Alt+T 切换`);
		this.tui.requestRender();
	}
	async loadEarlier(): Promise<void> {
		const history = this.view?.history;
		if (this.stopped || this.historyRequest || history?.loading || !history?.hasEarlier) return;
		const request = this.historyRequest = {};
		this.historyAutoBlocked = false;
		const first = this.transcript.children[0];
		try {
			await history.loadEarlier();
			if (this.stopped || this.historyRequest !== request) return;
			if (first && !this.scroll.isFollowingEnd) {
				const index = this.transcript.children.indexOf(first);
				if (index > 0) {
					const width = this.scroll.getContentWidth(this.tui.terminal.columns);
					const added = this.transcript.children.slice(0, index).reduce((sum, child) => sum + child.render(width).length, 0);
					const top = this.scroll.scrollTop;
					this.tui.renderNow();
					this.scroll.scrollTo(top + added, { disableFollow: true });
				}
			}
		} catch (error) {
			if (!this.stopped && this.historyRequest === request) { this.historyAutoBlocked = true; this.tui.flash(`历史加载失败，可 /history 重试：${plain(error, 120)}`); }
		} finally { if (this.historyRequest === request) this.historyRequest = undefined; }
		this.tui.requestRender();
	}
	private statusLine(width: number): string {
		const s = this.status,
			label = this.binding.conversationLabel?.includes("只读") ? "子对话" : "总调度",
			state = this.view?.live.retry ? c.yellow(`${label}重试等待`) : s.busy ? c.yellow(`${label}运行中`) : this.readOnly ? c.dim("子对话只读") : this.view?.live.runFailure ? c.red("本轮未完成") : c.green(`${label}空闲`),
			budget = `$${s.spent.toFixed(3)}${s.budget === null ? "" : ` / $${s.budget.toFixed(2)}`}`;
		const tools = (this.view?.tools ?? this.view?.live.tools ?? []).filter((tool) => !["done", "error", "aborted", "interrupted"].includes(tool.status)), queued = tools.filter((tool) => ["waiting", "sleeping", "pending"].includes(tool.status)).length;
		const inbox = this.view?.live.inbox.length ?? 0;
		const activity = `${tools.length ? ` · 工具 ${tools.length}${queued ? `（等待 ${queued}）` : ""}` : ""}${inbox ? ` · 待处理消息 ${inbox}` : ""}${s.jobs.length ? ` · 后台 ${s.jobs.map((job) => terminalLabel(job)).join(" / ")}` : ""}`;
		return terminalRow(` ${state}${activity}`, `成员 ${budget} · 待合并 ${s.pending}`, width);
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
		if (!this.scroll.isFollowingEnd) this.unread++;
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
		const retained = view.items;
		const newest = this.newestEntry;
		this.view = { ...view, items: retained };
		const fresh = retained.filter((item) => item.id > newest && !this.seenEntries.has(item.id));
		for (const item of fresh) this.newestEntry = Math.max(this.newestEntry, item.id);
		if (!this.scroll.isFollowingEnd) this.unread += fresh.length; else this.unread = 0;
		this.seenEntries = new Set(retained.map((item) => item.id));
		const failure = view.live.runFailure;
		const next = failure && ["interrupted", "turn_limit", "aborted"].includes(failure.reason) ? "/continue 续跑 · /tasks 查看成果" : failure?.reason === "model_error" || failure?.reason === "no_model" ? "/model 检查模型 · /help 查看操作" : "/tasks 查看成果 · /help 查看操作";
		this.failure.setText(failure && !view.live.busy ? c.red(`本轮未完成 · ${plain(failure.reason, 80)}`) + (failure.detail ? `\n${plain(failure.detail, 220)}` : "") + c.dim(`\n${next} · 记录已保留`) : "");
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
			if (item.type === "user" || (item.type === "assistant" && (item.text || item.error || item.message?.role === "assistant" && item.message.content.some((block) => block.type === "thinking")))) {
				let frame = this.messageFrames.get(key);
				if (!frame) { frame = new Container(); frame.addChild(new Text(item.type === "user" ? c.cyan(this.readOnly ? "收到的任务" : "你") : c.dim(this.readOnly ? "成员" : "Lemma"), 1, 0)); frame.addChild(card!); this.messageFrames.set(key, frame); }
				children.push(frame);
			} else children.push(card!);
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
		for (const key of this.messageFrames.keys()) if (!used.has(key)) this.messageFrames.delete(key);
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
