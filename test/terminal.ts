// 内存终端走真实 Pi TUI 编辑器和渲染器，不调用真实模型。
import assert from "node:assert/strict";
import { visibleWidth, type ProgramStatus, type Terminal } from "@earendil-works/pi-tui";
import { AgentTerminal, terminalText } from "../src/terminal.ts";
import { setOutputSink, writeLine } from "../src/printer.ts";
import { check } from "./helpers.ts";

class MemoryTerminal implements Terminal {
	columns = 100;
	rows = 28;
	kittyProtocolActive = false;
	active = false;
	output = "";
	input: (data: string) => void = () => {};
	resize: () => void = () => {};
	start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; this.active = true; }
	stop(): void { this.active = false; }
	async drainInput(): Promise<void> {}
	write(text: string): void { this.output = (this.output + text).slice(-1_000_000); }
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
const ui = new AgentTerminal({
	workdir: process.cwd(), model: "faux-orchestrator", demo: true, terminal, session: "frontend", conversationId: "controller-123",
	onSubmit: (text) => submissions.push(text),
	onInterrupt: () => { interrupts++; },
	onExit: () => { exits++; },
});
const frame = () => { ui.tui.renderNow(); return ui.tui.getScreenLines().map(terminalText).join("\n"); };

try {
	ui.start();
	check(terminal.active && frame().includes("演示模式"), "新版终端可以启动并渲染完整界面");
	check(frame().includes("frontend") && frame().includes("总控 CID:controller-123"), "固定栏显示会话名称与总控对话 ID，区分会话与成员上下文");
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
	for (const [columns, rows] of [[42, 14], [18, 8], [120, 35]]) {
		terminal.columns = columns!; terminal.rows = rows!; terminal.resize(); frame();
		assert.ok(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns!));
		assert.equal(ui.editor.getExpandedText(), "缩放时保留的中文草稿");
	}
	check(true, "窄窗口、中文宽度和连续缩放不会破坏草稿或越界渲染");

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
