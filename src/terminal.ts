// Pi TUI renders committed Durable views; runtime owns dispatch and persistence.
import {
	Box,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	fuzzyFilter,
	getKeybindings,
	Input,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	SelectList,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	TuiAltScreen,
	VStack,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type OverlayHandle,
	type SelectItem,
	type Terminal,
} from "@earendil-works/pi-tui";
import { colors as c } from "./printer.ts";
import type { ViewItem, ViewLive } from "./view.ts";
export const TERMINAL_COMMANDS = [
	["agents", "成员和模型"],
	["web", "后台网页"],
	["usage", "用量"],
	["goal", "项目目标"],
	["tasks", "分工表"],
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
	["main", "返回总控"],
	["members", "成员上下文"],
	["learn", "已验证的修复记录"],
	["repair", "自动修复状态"],
	["conversation", "总控对话 ID 与隔离边界"],
	["id", "当前对话 ID"],
].map(([name, description]) => ({ name: name!, description: description! }));
/** Untrusted output cannot change cursor position, title or terminal modes. */
export function terminalText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
const plain = (text: unknown, limit = 20_000) => terminalText(String(text ?? "")).slice(0, limit);
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const markdownTheme: MarkdownTheme = {
	heading: (text) => c.cyan(bold(text)),
	link: c.cyan,
	linkUrl: c.dim,
	code: c.yellow,
	codeBlock: (text) => text,
	codeBlockBorder: c.dim,
	quote: c.dim,
	quoteBorder: c.dim,
	hr: c.dim,
	listBullet: c.cyan,
	bold,
	italic: (text) => `\x1b[3m${text}\x1b[23m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	underline: (text) => `\x1b[4m${text}\x1b[24m`,
};
const selectTheme = { selectedPrefix: c.cyan, selectedText: c.cyan, description: c.dim, scrollInfo: c.dim, noMatch: c.dim };
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
class ConversationEditor extends Editor {
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
/** Markdown can decode entities into control characters; preserve only our SGR styling. */
class SafeMarkdown extends Markdown {
	override render(width: number): readonly string[] {
		return super.render(Math.max(1, width)).map((line) => {
			const styles: string[] = [];
			const protectedLine = line.replace(/\x1b\[[0-9;:]*m/g, (style) => {
				styles.push(style);
				return `\ue000${styles.length - 1}\ue001`;
			});
			return terminalText(protectedLine).replace(/\ue000([0-9]+)\ue001/g, (_, index) => styles[Number(index)] ?? "");
		});
	}
}
class MessageCard extends Container {
	private title = new Text("", 1, 0);
	private body = new SafeMarkdown("", 1, 0, markdownTheme);
	private value = "";
	constructor() {
		super();
		this.addChild(this.title);
		this.addChild(this.body);
	}
	update(title: string, text: string): void {
		const value = JSON.stringify([title, text]);
		if (value === this.value) return;
		this.value = value;
		this.title.setText(title);
		this.body.setText(plain(text));
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
class ToolCard extends Container {
	private title = new Text("", 1, 0);
	private summary = new Text("", 2, 0);
	private output = new Text("", 2, 0);
	private value = "";
	constructor() {
		super();
		this.addChild(this.title);
		this.addChild(this.summary);
		this.addChild(this.output);
	}
	update(name: string, status: string, summary: string, output: string, expanded: boolean): void {
		const value = JSON.stringify([name, status, summary, output, expanded]);
		if (value === this.value) return;
		this.value = value;
		const color = ["error", "interrupted", "aborted"].includes(status) ? c.red : status === "done" ? c.green : c.yellow;
		this.title.setText(color(`▸ ${plain(name, 100)} · ${TOOL_STATUS[status] ?? plain(status, 30)}`));
		this.summary.setText(c.dim(plain(summary, expanded ? 2000 : 220)));
		const safe = terminalText(output).slice(expanded ? -12_000 : -2000),
			lines = safe.split("\n"),
			shown = expanded ? safe : lines.slice(-3).join("\n").slice(-420);
		this.output.setText(
			shown
				? `${shown}${!expanded && (lines.length > 3 || safe.length > 420) ? c.dim("\n… Ctrl+E 展开工具详情") : ""}\n`
				: "",
		);
	}
}
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
export interface TerminalConversation {
	id: string;
	title: string;
	detail?: string;
	current?: boolean;
}
export interface AgentTerminalOptions extends TerminalBinding {
	onSubmit(text: string): void;
	onInterrupt(): void;
	onExit(): void;
	onSessionNext?(): void;
	onSessionNew?(): void;
	onConversations?(): void;
	onConversationSelect?(id: string): void;
	terminal?: Terminal;
}
class ConversationPicker extends Container implements Focusable {
	private input = new Input({ prompt: "查找 › ", placeholder: "名称、编号或成员" });
	private listContainer = new Container();
	private list!: SelectList;
	private readonly items: SelectItem[];
	private select: (id: string) => void;
	private cancel: () => void;
	private renderAgain: () => void;
	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}
	constructor(items: TerminalConversation[], select: (id: string) => void, cancel: () => void, renderAgain: () => void) {
		super();
		this.items = items.map((item) => ({
			value: item.id,
			label: `${item.current ? "● " : "○ "}${plain(item.title, 100)}`,
			description: `${plain(item.detail ?? "", 180)} ${plain(item.id, 100)}`,
		}));
		this.select = select;
		this.cancel = cancel;
		this.renderAgain = renderAgain;
		const box = new Box(1, 1);
		box.addChild(new Text(c.cyan("切换会话 / 查看子对话")));
		box.addChild(this.input);
		box.addChild(this.listContainer);
		box.addChild(new Text(c.dim("↑↓ 选择 · Enter 打开 · Esc 返回")));
		this.addChild(box);
		this.filter();
	}
	private filter(): void {
		const items = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.description}`);
		this.list = new SelectList(items, 8, selectTheme);
		this.list.onSelect = (item) => this.select(item.value);
		this.list.onCancel = this.cancel;
		this.listContainer.clear();
		this.listContainer.addChild(this.list);
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) this.list.handleInput(data);
		else {
			this.input.handleInput(data);
			this.filter();
		}
		this.renderAgain();
	}
}
export class AgentTerminal {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	private binding: TerminalBinding;
	private options: AgentTerminalOptions;
	private readonly transcript = new Container();
	private readonly notices = new Container();
	private readonly partial = new MessageCard();
	private readonly liveTools = new Container();
	private readonly taskPanel = new Text("", 1, 0);
	private readonly scroll: ScrollView;
	private status: TerminalStatus = { busy: false, jobs: [], spent: 0, budget: null, pending: 0 };
	private blocks: { component: Text; size: number }[] = [];
	private cards = new Map<string, MessageCard | ToolCard>();
	private liveCards = new Map<string, ToolCard>();
	private view?: { items: ViewItem[]; live: ViewLive };
	private tasks: TerminalTask[] = [];
	private tasksVisible = false;
	private toolsExpanded = false;
	private picker?: OverlayHandle;
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
			{ paddingX: 1, autocompleteMaxVisible: 5 },
		);
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
							" Enter 发送 · Ctrl+K 会话 · Ctrl+T 任务 · Ctrl+E 工具详情 · Ctrl+N 新建 · Ctrl+O 切换 · Ctrl+J 换行",
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
			if (matchesKey(data, "ctrl+t")) {
				this.toggleTasks();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+e")) {
				this.toolsExpanded = !this.toolsExpanded;
				if (this.view) this.applyConversation(this.view);
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
		this.partial.update("", "");
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
	setPartial(text: string): void {
		if (this.stopped) return;
		const label = this.binding.conversationLabel?.includes("只读") ? "子对话" : "总调度";
		this.partial.update(text ? c.green(`${label} › 正在回答`) : "", text ? plain(text, 12_000) : "");
		this.tui.requestRender();
	}
	setStatus(status: TerminalStatus): void {
		if (this.stopped) return;
		this.status = status;
		this.tui.requestRender();
	}
	applyConversation(view: { items: ViewItem[]; live: ViewLive }): void {
		if (this.stopped) return;
		const retained: ViewItem[] = [];
		let size = 0;
		for (const item of view.items.slice(-250).reverse()) {
			const next = JSON.stringify(item).length;
			if (retained.length && size + next > 120_000) break;
			retained.unshift(item);
			size += next;
		}
		this.view = { items: retained, live: view.live };
		const lastUser = retained.findLast((item) => item.type === "user")?.id;
		if (lastUser !== undefined && lastUser !== this.lastUser) {
			// New committed input starts the next interaction, without old command output below it.
			this.notices.clear();
			this.blocks = [];
			this.size = 0;
			this.lastUser = lastUser;
		}
		const speaker = this.binding.conversationLabel?.includes("只读") ? "子对话" : "总调度";
		// Providers may reuse call IDs in later runs: pair results with the preceding call entry.
		const results = new Map<string, Extract<ViewItem, { type: "tool" }>>(),
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
		const live = new Map(view.live.tools.map((tool) => [tool.callId, tool]));
		const emitted = new Set<string>(),
			used = new Set<string>();
		const children: Component[] = [];
		const message = (key: string, title: string, body: string) => {
			let card = this.cards.get(key);
			if (!(card instanceof MessageCard)) {
				card = new MessageCard();
				this.cards.set(key, card);
			}
			card.update(title, body);
			used.add(key);
			children.push(card);
		};
		const tool = (
			key: string,
			callId: string,
			name: string,
			task: string,
			result?: Extract<ViewItem, { type: "tool" }>,
		) => {
			let card = this.cards.get(key);
			if (!(card instanceof ToolCard)) {
				card = new ToolCard();
				this.cards.set(key, card);
			}
			const active = pending.get(callId) === key ? live.get(callId) : undefined,
				status = result ? (result.isError ? "error" : "done") : (active?.status ?? "interrupted");
			card.update(name, status, task, result?.text ?? active?.output ?? "", this.toolsExpanded);
			used.add(key);
			if (active) emitted.add(callId);
			children.push(card);
		};
		for (const item of retained) {
			if (item.type === "user") message(`entry:${item.id}`, c.cyan("你 ›"), item.text);
			if (item.type === "assistant") {
				if (item.text || item.error)
					message(
						`entry:${item.id}`,
						item.error ? c.red(`${speaker} › 未完成`) : c.green(`${speaker} ›`),
						`${item.text}${item.error ? `\n\n${plain(item.error)}` : ""}`,
					);
				for (const call of item.toolCalls) {
					const key = `tool:${item.id}:${call.id}`;
					tool(
						key,
						call.id,
						call.name,
						String(call.args.task ?? call.args.goal ?? call.args.title ?? JSON.stringify(call.args)),
						results.get(key),
					);
				}
			}
			if (item.type === "tool" && !pairedResults.has(item.id))
				tool(`result:${item.id}`, item.callId, item.name, "工具结果", item);
			if (item.type === "job")
				message(
					`entry:${item.id}`,
					c.yellow(
						`后台结果 ${plain(item.job)} · ${plain(item.agent)} · ${TOOL_STATUS[item.status] ?? plain(item.status)}`,
					),
					item.text,
				);
			if (item.type === "divider") message(`entry:${item.id}`, c.dim(`── ${plain(item.label)} ──`), "");
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
		for (const active of view.live.tools) {
			if (emitted.has(active.callId)) continue;
			let card = this.liveCards.get(active.callId);
			if (!card) {
				card = new ToolCard();
				this.liveCards.set(active.callId, card);
			}
			card.update(active.name, active.status, "", active.output, this.toolsExpanded);
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
		this.setPartial(view.live.partial);
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
		const picker = new ConversationPicker(
			items,
			(id) => {
				this.closePicker();
				this.options.onConversationSelect?.(id);
			},
			() => this.closePicker(),
			() => this.tui.requestRender(),
		);
		this.picker = this.tui.showOverlay(picker, { width: "88%", maxHeight: "85%", anchor: "center", margin: 1 });
		this.tui.requestRender();
	}
	private closePicker(): void {
		if (!this.picker) return;
		this.picker.hide();
		this.picker = undefined;
		this.tui.setFocus(this.editor);
	}
	stop(): void {
		if (this.stopped) return;
		this.closePicker();
		this.stopped = true;
		if (this.started) this.tui.stop();
	}
}
