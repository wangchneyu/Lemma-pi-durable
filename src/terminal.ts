// Pi TUI 只管理呈现和输入；派工、持久化和命令继续走原来的应用。
import {
	CombinedAutocompleteProvider, Container, Editor, matchesKey, ProcessTerminal, ScrollView,
	stripTerminalSequences, Text, truncateToWidth, TuiAltScreen, VStack,
	type Component, type Terminal,
} from "@earendil-works/pi-tui";
import { colors as c } from "./printer.ts";

export const TERMINAL_COMMANDS = [
	["agents", "成员和模型"], ["web", "后台网页"], ["usage", "用量"],
	["goal", "项目目标"], ["tasks", "分工表"], ["rules", "共同规则"],
	["jobs", "后台任务"], ["queue", "排到下一轮"], ["continue", "续跑"],
	["compact", "压缩上下文"], ["abort", "中止本轮；all 连后台一起停"],
	["changes", "待合并改动"], ["diff", "查看改动"], ["apply", "应用改动"],
	["drop", "丢弃改动"], ["clean", "清理工作副本"],
	["new", "新上下文"], ["exit", "退出"], ["quit", "退出"],
	["sessions", "列出隔离会话"], ["session", "new / use / rename 会话"],
	["members", "当前会话的成员上下文"], ["learn", "已验证的修复记录"], ["repair", "自动修复状态"],
	["conversation", "总控对话 ID 与上下文隔离边界"], ["id", "查看当前对话 ID"],
].map(([name, description]) => ({ name: name!, description: description! }));

/** 不允许模型、命令输出里的控制序列移动光标或改终端模式。 */
export function terminalText(text: string): string {
	return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

class Line implements Component {
	private readonly value: () => string;
	constructor(value: () => string) { this.value = value; }
	render(width: number): string[] { return [truncateToWidth(this.value(), Math.max(1, width))]; }
	invalidate(): void {}
}

export interface TerminalStatus {
	busy: boolean;
	jobs: string[];
	spent: number;
	budget: number | null;
	pending: number;
}

export interface AgentTerminalOptions {
	workdir: string;
	model: string;
	demo: boolean;
	web?: string;
	session?: string;
	conversationId?: string;
	onSubmit(text: string): void;
	onInterrupt(): void;
	onExit(): void;
	onSessionNext?(): void;
	onSessionNew?(): void;
	/** 测试可以提供内存终端，不接触真实终端或调用模型。 */
	terminal?: Terminal;
}

export class AgentTerminal {
	readonly tui: TuiAltScreen;
	readonly editor: Editor;
	private readonly transcript = new Container();
	private readonly partial = new Text("", 1, 0);
	private readonly scroll: ScrollView;
	private status: TerminalStatus = { busy: false, jobs: [], spent: 0, budget: null, pending: 0 };
	private blocks: { component: Text; size: number }[] = [];
	private size = 0;
	private stopped = false;
	private started = false;

	constructor(options: AgentTerminalOptions) {
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: false });
		this.editor = new Editor(this.tui, {
			borderColor: c.cyan,
			selectList: { selectedPrefix: c.cyan, selectedText: c.cyan, description: c.dim, scrollInfo: c.dim, noMatch: c.dim },
		}, { paddingX: 1, autocompleteMaxVisible: 5 });
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(TERMINAL_COMMANDS, options.workdir));
		this.editor.onSubmit = (text) => {
			if (this.stopped || !text.trim()) return;
			this.editor.addToHistory(text);
			this.write(`你 › ${text}`);
			this.scroll.scrollToEnd();
			options.onSubmit(text);
		};
		const document = new Container();
		document.addChild(this.transcript);
		document.addChild(this.partial);
		this.scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
		this.tui.setLayoutRoot(new VStack([
			{ component: new Line(() => c.cyan(` Lemma${options.demo ? " · 演示模式" : ""}${options.session ? ` · ${terminalText(options.session)}` : ""}${options.conversationId ? ` · 总控 CID:${terminalText(options.conversationId)}` : ""}`) + c.dim(`  ${terminalText(options.model)}`)), shrink: 0 },
			{ component: new Line(() => c.dim(` ${terminalText(options.workdir)}${options.web ? `  后台：${options.web}` : ""}`)), shrink: 0, visible: ({ height }) => height >= 10 },
			{ component: this.scroll, basis: 0, grow: 1, minSize: 1 },
			{ component: new Line(() => this.statusLine()), shrink: 0 },
			{ component: this.editor, maxSize: 9, minSize: 3 },
			{ component: new Line(() => c.dim(" Enter 发送 · Ctrl+N 新会话 · Ctrl+O 切换 · Ctrl+J 换行 · Tab 补全 · PgUp/PgDn 历史 · /exit 退出")), shrink: 0, visible: ({ height }) => height >= 10 },
		]));
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+o") && options.onSessionNext) { options.onSessionNext(); return { consume: true }; }
			if (matchesKey(data, "ctrl+n") && options.onSessionNew) { options.onSessionNew(); return { consume: true }; }
			if (matchesKey(data, "ctrl+c")) { options.onInterrupt(); return { consume: true }; }
			if (matchesKey(data, "ctrl+d") && !this.editor.getExpandedText()) { options.onExit(); return { consume: true }; }
			return undefined;
		});
	}

	private statusLine(): string {
		const s = this.status;
		const state = s.busy ? c.yellow("总调度运行中") : c.green("总调度空闲");
		const budget = `$${s.spent.toFixed(3)}${s.budget === null ? "" : ` / $${s.budget.toFixed(2)}`}`;
		return ` ${state} · 成员 ${budget} · 待合并 ${s.pending}${s.jobs.length ? ` · 后台 ${s.jobs.map(terminalText).join(" / ")}` : " · 后台无任务"}`;
	}

	start(): void {
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
		this.transcript.addChild(component);
		while (this.blocks.length > 250 || this.size > 150_000) {
			const first = this.blocks.shift()!;
			this.size -= first.size;
			this.transcript.removeChild(first.component);
		}
		this.tui.requestRender();
	}

	setPartial(text: string): void {
		if (this.stopped) return;
		this.partial.setText(text ? `总调度 › ${terminalText(text).slice(-12_000)}` : "");
		this.tui.requestRender();
	}

	setStatus(status: TerminalStatus): void {
		if (this.stopped) return;
		this.status = status;
		this.tui.requestRender();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.started) this.tui.stop();
	}
}
