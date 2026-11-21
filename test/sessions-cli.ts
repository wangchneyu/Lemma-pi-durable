import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalText } from "../src/terminal.ts";
import { check } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-session-cli-"));
const file = join(dir, "config.json");
writeFileSync(file, JSON.stringify({ workdir: dir, storage: join(dir, "session.sqlite") }));
const free = createServer();
await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
const port = (free.address() as { port: number }).port;
await new Promise<void>((resolve) => free.close(() => resolve()));
const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./terminal-cli-child.ts", import.meta.url)), "--demo", "--tui"], {
	env: { ...process.env, PI_AGENT_CONFIG: file, PI_AGENT_PORT: String(port), FAKE_AGENT_DELAY_MS: "1200", TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
let errors = "";
let exited = false;
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { errors += chunk; });
const closed = new Promise<number | null>((resolve) => child.on("close", (code) => { exited = true; resolve(code); }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function json(path: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const req = request(`http://127.0.0.1:${port}${path}`, (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); });
		req.on("error", reject); req.end();
	});
}
async function until(label: string, test: () => boolean | Promise<boolean>, timeout = 25_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline && !exited) { try { if (await test()) return; } catch {} await sleep(80); }
	if (await test()) return;
	throw new Error(`${label} 超时：${errors}\n${terminalText(output).slice(-2500)}`);
}
const send = (text: string) => child.stdin!.write(`\x1b[200~${text}\x1b[201~\r`);
try {
	await until("后台随终端启动", async () => (await json("/api/state")).conversation?.id === "default");
	const controllerId = (await json("/api/state")).conversation.controllerId;
	assert.equal(typeof controllerId, "string");
	assert.ok(controllerId.length > 0);
	child.stdin!.write("\x1b[?1;2c");
	send("/conversation");
	await until("显示对话隔离说明", () => terminalText(output).includes("总控 conversation_id"));
	send("默认会话独有功能");
	await until("后台开始派工", async () => (await json("/api/jobs")).jobs.some((j: any) => j.status === "running"));
	child.stdin!.write("默认会话未发送草稿");
	child.stdin!.write("\x0e"); // Ctrl+N 新建，保留当前草稿。
	let newId = "";
	await until("新会话切换", async () => { newId = (await json("/api/state")).conversation.id; return newId !== "default"; });
	child.stdin!.write("\x1b[?1;2c");
	const fresh = await json("/api/state");
	assert.equal(fresh.jobs.length, 0);
	assert.equal((await json("/api/history")).items.length, 0);
	const marker = output.length;
	child.stdin!.write("新会话未发送草稿");
	child.stdin!.write("\x0f"); // Ctrl+O 切回默认。
	await until("切回默认会话", async () => (await json("/api/state")).conversation.id === "default");
	await until("默认草稿恢复", () => terminalText(output.slice(marker)).includes("默认会话未发送草稿"));
	await until("后台任务继续直到完成", async () => { const s = await json("/api/state"); return s.jobs.length === 4 && s.jobs.every((j: any) => j.status === "done"); });
	assert.ok((await json("/api/history")).items.some((i: any) => i.type === "user" && i.text === "默认会话独有功能"));
	assert.ok(!(await json("/api/history")).items.some((i: any) => /未发送草稿/.test(i.text ?? "")));
	check(true, "后台随终端启动，切换会话时跟随当前会话，原会话派工继续完成");
	const nextMarker = output.length;
	child.stdin!.write("\x0f");
	await until("再次进入新会话", async () => (await json("/api/state")).conversation.id === newId);
	await until("新会话草稿恢复", () => terminalText(output.slice(nextMarker)).includes("新会话未发送草稿"));
	assert.equal((await json("/api/history")).items.length, 0);
	check(true, "快捷键切换保留各自草稿，未发送输入与其他会话历史不进入模型上下文");
	child.stdin!.write("\x15"); send("/exit");
	await until("退出全部会话", () => exited, 15_000);
	assert.equal(await closed, 0, errors);
} finally { if (!exited) { child.kill(); await closed; } }
