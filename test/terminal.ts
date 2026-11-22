// 内存终端走真实 Pi TUI 编辑器和渲染器，不调用真实模型。
import assert from "node:assert/strict";
import { visibleWidth, type ProgramStatus, type Terminal } from "@earendil-works/pi-tui";
import { AgentTerminal, terminalText } from "../src/terminal.ts";
import { setOutputSink, writeLine } from "../src/printer.ts";
import { check } from "./helpers.ts";
import type { ViewItem, ViewLive } from "../src/view.ts";
import { AssistantMessageComponent, CustomEditor, UserMessageComponent, ToolExecutionComponent, SessionSelectorComponent, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { assistantMessage } from "../src/native-terminal-components.ts";
import { nativeSessions, nativeConversationTree, conversationTree } from "../src/native-selectors.ts";
import { nativeModelCatalog } from "../src/model-selection.ts";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

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
	assert.ok(ui.editor instanceof CustomEditor);
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
	assert.ok(structured.includes("第一次派工") && structured.includes("第二次派工") && structured.includes("增量回答"), structured);
	assert.ok(!structured.includes("**Markdown**"));
	const nativeCards = (ui as unknown as { cards: Map<string, unknown> }).cards;
	assert.ok(nativeCards.get("entry:1") instanceof UserMessageComponent);
	assert.ok(nativeCards.get("entry:2") instanceof AssistantMessageComponent);
	assert.ok(nativeCards.get("tool:2:reused") instanceof ToolExecutionComponent);
	check(true, "消息和工具实际使用官方 coding-agent 组件实例，而非自建同名卡片");
	items.push({ id: 5, type: "tool", callId: "reused", name: "ask_codex", text: "SECOND_RESULT", isError: true });
	live.tools = [];
	live.partial = "";
	live.busy = false;
	ui.applyConversation({ items, live });
	structured = frame();
	const failedTool = nativeCards.get("tool:4:reused") as ToolExecutionComponent;
	const successfulTool = nativeCards.get("tool:2:reused") as ToolExecutionComponent;
	assert.notEqual(failedTool.render(100).join("\n").match(/\x1b\[48[^m]*m/)?.[0], successfulTool.render(100).join("\n").match(/\x1b\[48[^m]*m/)?.[0]);
	assert.ok(
		structured.includes("FIRST_RESULT") && structured.includes("SECOND_RESULT"),
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
					name: "ask_codex",
					status: "running",
					output: `DETAIL_TOP\n${"日志\n".repeat(15)}LATEST_OUTPUT`,
				},
			],
		},
	});
	assert.ok(frame().includes("DETAIL_TOP") && !frame().includes("LATEST_OUTPUT") && frame().includes("ctrl+e"));
	terminal.input("\x05");
	assert.ok(frame().includes("LATEST_OUTPUT"));
	terminal.input("\x05");
	check(true, "工具使用原生前十行预览和 Ctrl+E 展开，快捷键提示与操作一致");

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
	const thinkingMessage = assistantMessage("");
	thinkingMessage.content = [{ type: "thinking", thinking: "原生思考唯一标记" }, { type: "text", text: "原生回答唯一标记" }];
	ui.applyConversation({ items: [{ id: 30, type: "assistant", text: "原生回答唯一标记", toolCalls: [], message: thinkingMessage }], live });
	assert.ok(!frame().includes("原生思考唯一标记") && frame().includes("Thinking"));
	terminal.input("\x1bt");
	assert.ok(frame().includes("原生思考唯一标记"));
	terminal.input("\x1bt");
	const partialMessage = assistantMessage("");
	partialMessage.content = [{ type: "toolCall", id: "streamed", name: "ask_codex", arguments: { task: "流式参数第一版" } }];
	const streamTool = { callId: "streamed", name: "ask_codex", status: "pending", output: "", argsComplete: false, args: { task: "流式参数第一版" } };
	ui.applyConversation({ items: [], live, partialMessage, tools: [streamTool] });
	assert.ok(frame().includes("流式参数第一版"));
	streamTool.args = { task: "流式参数第二版" };
	ui.applyConversation({ items: [], live, partialMessage, tools: [streamTool] });
	assert.ok(frame().includes("流式参数第二版") && !frame().includes("流式参数第一版"));
	ui.applyConversation({ items: [], live: { ...live, tools: [] } });
	assert.ok(!frame().includes("流式参数第二版"));
	check(true, "原始思考块可展开，原生工具参数增量更新且取消后清理");
	ui.applyConversation({ items: [
		{ id: 40, type: "assistant", text: "", toolCalls: [{ id: "file-read", name: "read", args: { path: "src/main.ts" } }] },
		{ id: 41, type: "tool", callId: "file-read", name: "read", text: "FILE_NATIVE_CONTENT", isError: false },
	], live });
	assert.ok(frame().includes("src/main.ts") && !frame().includes("FILE_NATIVE_CONTENT"));
	terminal.input("\x05");
	assert.ok(frame().includes("FILE_NATIVE_CONTENT"));
	terminal.input("\x05");
	check(true, "内置 read 使用官方文件工具渲染和折叠规则，失败工具使用原生错误背景");

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
	await new Promise((resolve) => setTimeout(resolve, 0));
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
	terminal.columns = 100; terminal.rows = 30; terminal.resize();
	const choices = [
		{ id: "session:frontend", title: "前端", current: true },
		{ id: "conversation:root", title: "总控", parentId: "session:frontend" },
		{ id: "conversation:member", title: "成员唯一树标记", parentId: "conversation:root" },
	];
	const native = nativeSessions(choices, () => {}, () => {}, () => {});
	assert.ok(native instanceof SessionSelectorComponent);
	assert.equal(native.getSessionList().onDeleteSession, undefined);
	native.getSessionList().onCancel?.();
	const tree = nativeConversationTree(choices, 30, () => {}, () => {});
	assert.ok(tree instanceof TreeSelectorComponent);
	assert.equal(conversationTree(choices)[0]?.children[0]?.children[0]?.entry.id, "conversation:member");
	assert.equal(conversationTree([{ id: "a", title: "a", parentId: "b" }, { id: "b", title: "b", parentId: "a" }]).length, 2);
	ui.showConversationTree(choices);
	assert.ok(frame().includes("Session Tree"));
	terminal.input("成员唯一树标记");
	terminal.input("\r");
	assert.equal(selected.at(-1), "conversation:member");
	assert.equal(ui.editor.getExpandedText(), beforePicker);
	const models = createModels();
	const faux = fauxProvider({ provider: "selector-test", models: [{ id: "first" }, { id: "second" }] });
	models.setProvider(faux.provider);
	const catalog = await nativeModelCatalog(models, "selector-test");
	let chosen = "";
	ui.showModels(catalog, models.getModel("selector-test", "first"), catalog.getAvailableSnapshot(), (model) => { chosen = model.id; });
	terminal.input("second");
	terminal.input("\r");
	assert.equal(chosen, "second");
	assert.equal(ui.editor.getExpandedText(), beforePicker);
	const aborts: AbortSignal[] = [];
	let refreshed = false;
	const discovered = { ...models.getModel("selector-test", "second")!, id: "discovered-only", name: "discovered-only" };
	ui.showModels({ ...catalog, getAvailableSnapshot: () => refreshed ? [...catalog.getAvailableSnapshot(), discovered] : catalog.getAvailableSnapshot(), refresh: async () => { refreshed = true; return { aborted: false, errors: new Map() }; } }, models.getModel("selector-test", "first"), [], (model) => { chosen = model.id; });
	await new Promise((resolve) => setTimeout(resolve, 0));
	terminal.input("discovered-only"); terminal.input("\r");
	assert.equal(chosen, "discovered-only");
	ui.showModels({ ...catalog, refresh: (options) => new Promise((resolve) => { const signal = options!.signal!; aborts.push(signal); signal.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), { once: true }); }) }, models.getModel("selector-test", "first"), catalog.getAvailableSnapshot(), () => {});
	ui.bind(binding, beforePicker);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(aborts.every((signal) => signal.aborted));
	assert.equal(faux.state.callCount, 0);
	check(true, "实际原生会话、关系树和模型选择器可导航，切换时取消刷新并保留输入草稿");

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
