// 内存终端走真实 Pi TUI 编辑器和渲染器，不调用真实模型。
import assert from "node:assert/strict";
import { visibleWidth, type ProgramStatus, type Terminal } from "@earendil-works/pi-tui";
import { AgentTerminal, terminalText } from "../src/terminal.ts";
import { setOutputSink, writeLine } from "../src/printer.ts";
import { check } from "./helpers.ts";
import type { ViewItem, ViewLive } from "../src/view.ts";

class MemoryTerminal implements Terminal {
	columns = 100;
	rows = 28;
	kittyProtocolActive = false;
	active = false;
	starts = 0;
	stops = 0;
	output = "";
	input: (data: string) => void = () => {};
	resize: () => void = () => {};
	start(input: (data: string) => void, resize: () => void): void {
		this.starts++;
		this.input = input;
		this.resize = resize;
		this.active = true;
	}
	stop(): void {
		this.stops++;
		this.active = false;
	}
	async drainInput(): Promise<void> {}
	write(text: string): void {
		this.output = (this.output + text).slice(-1_000_000);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}
}

const terminal = new MemoryTerminal();
const submissions: string[] = [];
let interrupts = 0;
let exits = 0;
const selected: string[] = [];
let pickerRequests = 0;
const ui = new AgentTerminal({
	workdir: process.cwd(),
	model: "faux-orchestrator",
	demo: true,
	terminal,
	session: "frontend",
	conversationId: "controller-123",
	onSubmit: (text) => submissions.push(text),
	onInterrupt: () => {
		interrupts++;
	},
	onExit: () => {
		exits++;
	},
	onConversationSelect: (id) => {
		selected.push(id);
	},
	onConversations: () => {
		pickerRequests++;
	},
});
const frame = () => {
	ui.tui.renderNow();
	return ui.tui.getScreenLines().map(terminalText).join("\n");
};

try {
	ui.start();
	check(terminal.active && frame().includes("Lemma") && frame().includes("演示模式"), "新版终端可以启动并显示 Lemma 品牌");
	check(
		frame().includes("frontend") && frame().includes("总控 CID:controller-123"),
		"固定栏显示会话名称与总控对话 ID，区分会话与成员上下文",
	);
	ui.editor.setText("中文草稿🙂，不要被日志覆盖");
	const cursor = ui.editor.getCursor();
	setOutputSink((text) => ui.write(text));
	for (let i = 0; i < 400; i++) writeLine(`[J3] 实时输出 ${i}`);
	ui.setPartial("正在分析实现方案");
	ui.setStatus({ busy: true, jobs: ["J3 claude"], spent: 0.12, budget: 3, pending: 2 });
	const busyFrame = frame();
	assert.deepEqual(ui.editor.getCursor(), cursor);
	assert.equal(ui.editor.getExpandedText(), "中文草稿🙂，不要被日志覆盖");
	assert.ok(busyFrame.includes("实时输出 399"), busyFrame);
	assert.ok(busyFrame.includes("J3 claude") && busyFrame.includes("0.120"), busyFrame);
	check(true, "大量实时日志、流式回答和状态更新不改动输入草稿或光标");

	ui.editor.setText("");
	const paste = "任务第一行\n第二行：保留中文和 emoji 🙂\n/exit 是任务中的文字";
	terminal.input(`\x1b[200~${paste}\x1b[201~`);
	assert.equal(Number(submissions.length), 0);
	assert.equal(ui.editor.getExpandedText(), paste);
	terminal.input("\r");
	assert.deepEqual(submissions, [paste]);
	check(exits === 0 && ui.editor.getExpandedText() === "", "多行粘贴作为一个完整任务发送，不把其中的命令单独执行");

	terminal.input("a");
	terminal.input("\n");
	terminal.input("b");
	assert.equal(ui.editor.getExpandedText(), "a\nb");
	check(submissions.length === 1, "Ctrl+J 插入换行，Enter 才发送");
	ui.editor.setText("/jo");
	terminal.input("\t");
	await new Promise((resolve) => setTimeout(resolve, 100));
	check(frame().includes("jobs"), "斜杠命令可以用 Tab 补全");
	ui.editor.setText("缩放时保留的中文草稿");
	for (const [columns, rows] of [
		[42, 14],
		[18, 8],
		[120, 35],
	]) {
		terminal.columns = columns!;
		terminal.rows = rows!;
		terminal.resize();
		frame();
		assert.ok(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns!));
		assert.equal(ui.editor.getExpandedText(), "缩放时保留的中文草稿");
	}
	check(true, "窄窗口、中文宽度和连续缩放不会破坏草稿或越界渲染");

	const binding = {
		workdir: process.cwd(),
		model: "faux-orchestrator",
		demo: true,
		session: "frontend",
		conversationId: "controller-123",
	};
	const editor = ui.editor;
	ui.editor.addToHistory("仅属于前端的已发送输入");
	ui.editor.setText("前端剪切私密片段");
	terminal.input("\x15");
	terminal.input("\x19");
	assert.equal(ui.editor.getExpandedText(), "前端剪切私密片段");
	ui.bind({ ...binding, session: "backend", conversationId: "controller-456" }, "后端草稿");
	assert.equal(ui.editor, editor);
	assert.equal(terminal.starts, 1);
	assert.equal(terminal.stops, 0);
	assert.equal(ui.editor.getExpandedText(), "后端草稿");
	assert.ok(frame().includes("backend") && !frame().includes("实时输出 399"));
	terminal.input("\x1f"); // Undo must never bring back the other conversation's draft.
	assert.ok(!ui.editor.getExpandedText().includes("缩放时保留"));
	ui.editor.setText("");
	terminal.input("\x19");
	assert.equal(ui.editor.getExpandedText(), "");
	terminal.input("\x1b[A");
	assert.equal(ui.editor.getExpandedText(), "");
	ui.bind(binding, "前端恢复草稿");
	ui.editor.setText("");
	terminal.input("\x1b[A");
	assert.equal(ui.editor.getExpandedText(), "仅属于前端的已发送输入");
	check(true, "切换绑定保持同一终端与编辑器，隔离输入历史并清除跨会话撤销状态");

	ui.editor.setText("结构化消息不打断草稿");
	const stableCursor = ui.editor.getCursor();
	const live: ViewLive = {
		busy: true,
		turns: 1,
		partial: "正在给出 **增量回答**",
		tools: [{ callId: "reused", name: "ask_codex", status: "running", output: "LIVE_OUTPUT" }],
		inbox: [],
	};
	const items: ViewItem[] = [
		{ id: 1, type: "user", text: "用户唯一标记" },
		{
			id: 2,
			type: "assistant",
			text: "## 方案\n\n使用 **Markdown** 展示",
			toolCalls: [{ id: "reused", name: "ask_codex", args: { task: "第一次派工" } }],
		},
		{ id: 3, type: "tool", callId: "reused", name: "ask_codex", text: "FIRST_RESULT", isError: false },
		{
			id: 4,
			type: "assistant",
			text: "",
			toolCalls: [{ id: "reused", name: "ask_codex", args: { task: "第二次派工" } }],
		},
	];
	ui.applyConversation({ items, live });
	let structured = frame();
	assert.equal(structured.split("用户唯一标记").length - 1, 1);
	assert.ok(structured.includes("FIRST_RESULT") && structured.includes("LIVE_OUTPUT"), structured);
	assert.ok(structured.includes("完成") && structured.includes("执行中") && structured.includes("增量回答"), structured);
	assert.ok(!structured.includes("**Markdown**"));
	items.push({ id: 5, type: "tool", callId: "reused", name: "ask_codex", text: "SECOND_RESULT", isError: true });
	live.tools = [];
	live.partial = "";
	live.busy = false;
	ui.applyConversation({ items, live });
	structured = frame();
	assert.ok(
		structured.includes("FIRST_RESULT") && structured.includes("SECOND_RESULT") && structured.includes("失败"),
		structured,
	);
	assert.deepEqual(ui.editor.getCursor(), stableCursor);
	assert.equal(ui.editor.getExpandedText(), "结构化消息不打断草稿");
	check(true, "Markdown 消息与工具卡片原位更新，重复 callId 的派工结果不串线");
	ui.applyConversation({
		items: [],
		live: {
			...live,
			tools: [
				{
					callId: "expanded",
					name: "read",
					status: "running",
					output: `${"旧日志\n".repeat(800)}DETAIL_TOP\nline2\nline3\nline4\nLATEST_OUTPUT`,
				},
			],
		},
	});
	assert.ok(frame().includes("LATEST_OUTPUT") && !frame().includes("DETAIL_TOP"));
	terminal.input("\x05");
	assert.ok(frame().includes("DETAIL_TOP"));
	terminal.input("\x05");
	check(true, "工具输出默认跟随最新内容，展开后可查看保留的详细日志");

	ui.applyConversation({
		items: [
			{
				id: 20,
				type: "assistant",
				text: "[链接](https://example.com/&#27;[2J)\n\n\x1b]0;bad-title\x07正文",
				toolCalls: [],
			},
		],
		live,
	});
	frame();
	const rendered = ui.tui.getScreenLines().join("\n");
	// TuiAltScreen closes hyperlinks on every line; no untrusted URL payload may remain.
	assert.ok(
		!/\x1b\]8;;[^\x07\x1b]+/.test(rendered) && !rendered.includes("\x1b[2J") && !rendered.includes("bad-title"),
		JSON.stringify(rendered),
	);
	check(true, "Markdown 编码链接和模型控制序列不能发出终端操作或超链接载荷");

	ui.applyTasks([
		{
			id: "task-42",
			kind: "pi.tool",
			status: "waiting",
			conversationId: "child-7",
			owner: "parent-3",
			label: "等待验收",
		},
	]);
	terminal.input("\x14");
	assert.ok(frame().includes("原生任务") && frame().includes("task-42") && frame().includes("等待中"));
	const beforePicker = ui.editor.getExpandedText();
	terminal.input("\x0b");
	assert.equal(pickerRequests, 1);
	ui.showConversations([
		{ id: "session:frontend", title: "前端", current: true },
		{ id: "conversation:7", title: "后端审查", detail: "子对话 · 只读" },
	]);
	assert.ok(frame().includes("切换会话"));
	terminal.input("后端");
	terminal.input("\r");
	assert.deepEqual(selected, ["conversation:7"]);
	assert.equal(ui.editor.getExpandedText(), beforePicker);
	ui.bind({ ...binding, conversationId: "child-7", conversationLabel: "子对话 CID · 只读" }, beforePicker);
	assert.ok(frame().includes("子对话 CID · 只读:child-7"));
	for (const columns of [42, 18, 80]) {
		terminal.columns = columns;
		terminal.resize();
		ui.showConversations([
			{ id: "session:frontend", title: "很长的中文会话标题用于宽度验证", detail: "中文描述与状态" },
		]);
		frame();
		assert.ok(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns));
		terminal.input("\x1b");
	}
	check(true, "原生任务面板、可搜索会话选择器和只读子对话标题支持窄窗口且保留草稿");

	terminal.input("\x03");
	assert.equal(interrupts, 1);
	ui.editor.setText("");
	terminal.input("\x04");
	assert.equal(exits, 1);
	check(true, "Ctrl+C 和空输入 Ctrl+D 分别交给中止与退出处理");
	assert.equal(terminalText("\x1b[2J\x1b]0;bad title\x07hello\r\nworld\x00"), "hello\nworld");
	check(true, "日志中的清屏、窗口标题和控制字符不能干扰终端");
} finally {
	setOutputSink(undefined);
	ui.stop();
	ui.stop();
}
check(!terminal.active && terminal.output.includes("\x1b[?1049l"), "退出可重复清理，恢复终端主屏幕");
