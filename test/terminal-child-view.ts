// 从真实 TUI 选择原生 API 子对话，只读浏览不得提交消息、重置任务或丢失总控草稿。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { terminalText } from "../src/terminal.ts";
import { check } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "lemma-terminal-child-view-"));
const config = join(directory, "config.json");
writeFileSync(config, JSON.stringify({ workdir: directory, storage: join(directory, "session.sqlite") }));
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const terminal = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./terminal-cli-child.ts", import.meta.url)), "--faux", "--tui"], {
	env: { ...process.env, PI_AGENT_CONFIG: config, PI_AGENT_PORT: String(port), FAKE_AGENT_DELAY_MS: "120", TERM: "xterm-256color" },
	stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
let errors = "";
let exited = false;
terminal.stdout.on("data", (chunk) => { output += chunk; });
terminal.stderr.on("data", (chunk) => { errors += chunk; });
const closed = new Promise<number | null>((resolve) => terminal.on("close", (code) => { exited = true; resolve(code); }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function json(path: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const req = request(`http://127.0.0.1:${port}${path}`, (res) => {
			let body = ""; res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => { try { assert.equal(res.statusCode, 200, body); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
		});
		req.on("error", reject); req.end();
	});
}
async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 35_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline && !exited) { try { if (await predicate()) return; } catch {} await sleep(60); }
	if (await predicate()) return;
	throw new Error(`${label} 超时：${errors}\n${terminalText(output).slice(-4000)}`);
}
// 显式无修饰 Enter，避免 Windows 读取真实 Shift 状态影响管道模拟终端。
const send = (text: string) => terminal.stdin.write(`\x1b[200~${text}\x1b[201~\x1b[13u`);
const visibleSince = (offset: number) => terminalText(output.slice(offset));
function entries(storage: string, id: string): string[] {
	const database = new DatabaseSync(storage, { readOnly: true });
	try { return database.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id").all(Number(id)).map((row) => String(row.record)); }
	finally { database.close(); }
}
async function openChild(id: string, tree = false): Promise<void> {
	const marker = output.length;
	terminal.stdin.write(tree ? "\x1bc" : "\x0b"); // Alt+C / Ctrl+K，保留原草稿。
	await until("打开原生选择器", () => visibleSince(marker).includes(tree ? "Session Tree" : "切换会话 / 查看子对话"));
	terminal.stdin.write(`conversation:${id}`);
	await until("搜索词已显示", () => visibleSince(marker).includes(`conversation:${id}`));
	terminal.stdin.write("\x1b[13u");
	await until("进入只读成员子对话", () => visibleSince(marker).includes("正在只读查看子对话") && visibleSince(marker).includes("子对话 CID · 只读"));
}
try {
	await until("终端和后台启动", async () => (await json("/api/state")).conversation.id === "default");
	terminal.stdin.write("\x1b[?1;2c");
	send("验证只读浏览成员历史功能");
	await until("模拟协作及最终汇报完成", async () => {
		const [state, history] = await Promise.all([json("/api/state"), json("/api/history")]);
		return state.jobs.length === 4 && state.jobs.every((job: any) => job.status === "done" && job.delivered)
			&& history.items.some((item: any) => item.type === "assistant" && !item.toolCalls.length && item.text.includes("汇报"));
	});
	const state = await json("/api/state");
	const member = state.sessions.find((record: any) => record.agent === "deepseek");
	assert.ok(member?.id, "演示协作应创建 DeepSeek 原生子对话");
	const childId = String(member.id);
	const originalHistory = (await json("/api/history")).items;
	const childHistory = entries(state.storage, childId);
	assert.ok(childHistory.length > 0, "应存在可读取的真实子对话历史");
	const rootDraft = "总控未发送草稿保留在原会话";
	terminal.stdin.write(rootDraft);
	await openChild(childId);
	check(true, "Ctrl+K 可搜索并打开 DeepSeek 原生子对话，显示独立只读 CID");
	const thinkingMarker = output.length;
	send("/thinking");
	await until("只读视图可折叠思考", () => visibleSince(thinkingMarker).includes("思考记录：已折叠"));
	const thinkingRestoreMarker = output.length;
	send("/thinking");
	await until("只读视图可展开思考", () => visibleSince(thinkingRestoreMarker).includes("思考记录：已展开"));
	send("/history");
	const attemptMarker = output.length;
	const rejectedMessage = "只读浏览时绝不能发送的唯一文本-READONLY-CHILD";
	send(rejectedMessage);
	await until("只读消息被拒绝", () => visibleSince(attemptMarker).includes("消息未发送"));
	const resetMarker = output.length;
	send("/new");
	await until("只读重置被拒绝", () => visibleSince(resetMarker).includes("先 /main 返回总控再执行控制命令"));
	const modelMarker = output.length;
	send("/model forbidden-model");
	await until("只读模型切换被拒绝", () => visibleSince(modelMarker).includes("先 /main 返回总控再执行控制命令"));
	assert.deepEqual((await json("/api/history")).items, originalHistory);
	assert.deepEqual((await json("/api/state")).sessions, state.sessions);
	assert.deepEqual(entries(state.storage, childId), childHistory);
	check(true, "只读浏览拒绝发送和重置，总控与成员原始历史、成员轮次均保持不变");
	const returnMarker = output.length;
	send("/main");
	await until("回到总控并恢复草稿", () => visibleSince(returnMarker).includes(rootDraft));
	assert.equal((await json("/api/state")).startedAt, state.startedAt);
	assert.equal(output.split("\x1b[?1049h").length - 1, 1, "查看子对话不得重建 TUI");
	assert.equal(output.includes("\x1b[?1049l"), false, "查看子对话不得退出备用屏幕");
	const reopenMarker = output.length;
	await openChild(childId, true);
	assert.ok(!visibleSince(reopenMarker).includes(rejectedMessage), "再次打开子对话不得显示已拒绝消息");
	assert.deepEqual(entries(state.storage, childId), childHistory);
	check(true, "返回总控恢复原草稿，重新打开子对话不带入拒绝消息，终端和网页始终复用");
	send("/exit");
	await until("只读视图中正常退出", () => exited, 15_000);
	assert.equal(await closed, 0, errors);
	assert.equal(output.split("\x1b[?1049h").length - 1, 1);
	assert.ok(output.includes("\x1b[?1049l"), "退出应恢复终端主屏幕");
	check(true, "只读子对话内 /exit 正常关闭所有服务并恢复终端");
} finally {
	if (!exited) { terminal.kill(); await closed; }
}
