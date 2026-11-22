// 用真实终端进程和 HTTP 管理对话，模型与成员均为模拟，不调用付费 API。
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-conversation-web-"));
const config = join(directory, "config.json");
writeFileSync(config, JSON.stringify({ workdir: directory, storage: join(directory, "session.sqlite") }));
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let terminal!: ChildProcessWithoutNullStreams;
let output = "";
let closed!: Promise<number | null>;
let exited = false;

function launch() {
	exited = false; output = "";
	terminal = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--demo", "--plain"], {
		env: { ...process.env, PI_AGENT_CONFIG: config, PI_AGENT_PORT: String(port), FAKE_AGENT_DELAY_MS: "150", PI_AGENT_DEMO: "0" }, stdio: ["pipe", "pipe", "pipe"],
	});
	terminal.stdout.on("data", (chunk) => { output += chunk; });
	terminal.stderr.on("data", (chunk) => { output += chunk; });
	closed = new Promise((resolve) => terminal.on("close", (code) => { exited = true; resolve(code); }));
}
async function raw(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; data: any }>((resolve, reject) => {
		const req = request(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
			let text = ""; res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(text) }); } catch (error) { reject(error); } });
		});
		req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
const get = async (path: string) => { const response = await raw(path); assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
async function until(label: string, predicate: () => Promise<boolean>, timeout = 25_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline && !exited) { try { if (await predicate()) return; } catch {} await sleep(70); }
	if (await predicate()) return;
	throw new Error(`${label} 超时：${output.slice(-3000)}`);
}
async function choose(id: string, from: string) {
	const response = await raw(`/api/conversations/${id}/select`, { expectedSession: from });
	assert.equal(response.status, 202, JSON.stringify(response.data));
	await until("切换对话", async () => (await get("/api/state")).conversation.id === id);
}
async function stop() {
	if (exited) return;
	terminal.stdin.write("/exit\n");
	const code = await Promise.race([closed, sleep(10_000).then(() => "timeout")]);
	if (code === "timeout") { terminal.kill(); await closed; }
	assert.equal(code, 0, output.slice(-1000));
}

launch();
try {
	await until("启动", async () => (await get("/api/state")).conversation.id === "default");
	assert.equal((await get("/api/conversations")).conversations.length, 1);
	assert.equal((await raw("/api/conversations", { title: "被拒绝", expectedSession: "default" }, { origin: "https://evil.example" })).status, 403);
	assert.equal((await raw("/api/conversations", { title: 123, expectedSession: "default" })).status, 400);
	assert.equal((await raw("/api/conversations", { title: "过期请求", expectedSession: "unknown" })).status, 409);
	terminal.stdin.write("旧对话独有的导出功能\n");
	await until("旧任务完成", async () => {
		const state = await get("/api/state");
		const history = await get("/api/history");
		return state.jobs.length === 4 && state.jobs.every((j: any) => j.status === "done" && j.delivered) && history.items.some((i: any) => i.type === "assistant" && !i.toolCalls.length && i.text.includes("汇报"));
	});
	const oldState = await get("/api/state");
	const oldHistory = await get("/api/history");
	const oldChanges = await get("/api/changes");
	const oldDispatches = await get("/api/dispatches");
	assert.ok(oldHistory.items.some((item: any) => item.text === "旧对话独有的导出功能"));
	const oldDigest = (await get("/api/conversations")).conversations.find((c: any) => c.id === "default").digest;
	assert.ok(oldDigest.messageCount > 1 && oldDigest.inputs > 0 && oldDigest.lastAt >= oldDigest.firstAt);
	assert.ok(oldState.project.tasks.length > 0 && oldState.usage.length > 0 && oldChanges.changes.length > 0);
	const created = await raw("/api/conversations", { title: "接口排查 新对话", expectedSession: "default" });
	assert.equal(created.status, 202, JSON.stringify(created.data));
	assert.equal(created.data.preserved, true);
	const id = created.data.id as string;
	await until("新建并切换", async () => (await get("/api/state")).conversation.id === id);
	const fresh = await get("/api/state");
	assert.deepEqual((await get("/api/history")).items, []);
	assert.deepEqual(fresh.project.tasks, []); assert.deepEqual(fresh.jobs, []); assert.deepEqual(fresh.usage, []);
	assert.deepEqual((await get("/api/changes")).changes, []); assert.deepEqual((await get("/api/dispatches")).dispatches, []);
	assert.notEqual(fresh.storage, oldState.storage);
	assert.equal((await raw("/api/state?conversation=default")).status, 409);
	assert.equal((await raw("/api/reset", { expectedSession: "default" })).status, 409);
	assert.equal((await raw("/api/message", { text: "网页不能发任务" })).status, 404);
	check(true, "网页新建独立对话，旧存储不重置，新对话的记录、任务、派工、用量和改动从空开始");
	const named = await raw(`/api/conversations/${id}/title`, { title: "保留的接口排查", expectedSession: id });
	assert.equal(named.status, 200);
	assert.equal((await get("/api/conversations")).conversations.find((c: any) => c.id === id).title, "保留的接口排查");
	await choose("default", id);
	assert.deepEqual((await get("/api/history")).items, oldHistory.items);
	const restored = await get("/api/state");
	assert.deepEqual(restored.project.tasks, oldState.project.tasks); assert.deepEqual(restored.jobs, oldState.jobs);
	assert.deepEqual(restored.usage, oldState.usage); assert.deepEqual(restored.sessions, oldState.sessions);
	assert.deepEqual((await get("/api/changes")).changes, oldChanges.changes);
	assert.deepEqual((await get("/api/dispatches")).dispatches, oldDispatches.dispatches);
	assert.equal(restored.conversation.controllerId, oldState.conversation.controllerId);
	check(true, "切回旧对话后，原始消息、任务、成员会话、派工、用量、改动与对话 ID 全部保留");
	assert.equal((await raw("/api/conversations/default/title", { title: "原始开发对话", expectedSession: "default" })).status, 200);
	await choose(id, "default");
	await stop(); launch();
	await until("重启恢复选中对话", async () => (await get("/api/state")).conversation.id === id);
	const persisted = await get("/api/conversations");
	assert.equal(persisted.conversations.find((c: any) => c.id === "default").digest.messageCount, oldDigest.messageCount);
	assert.equal(persisted.conversations.find((c: any) => c.id === "default").title, "原始开发对话");
	assert.equal(persisted.conversations.find((c: any) => c.id === id).title, "保留的接口排查");
	await choose("default", id);
	assert.deepEqual((await get("/api/history")).items, oldHistory.items);
	const reopened = await get("/api/state");
	assert.deepEqual(reopened.project.tasks, oldState.project.tasks); assert.deepEqual(reopened.jobs, oldState.jobs); assert.deepEqual(reopened.usage, oldState.usage);
	assert.deepEqual((await get("/api/changes")).changes, oldChanges.changes);
	assert.deepEqual((await get("/api/dispatches")).dispatches, oldDispatches.dispatches);
	check(true, "重启保留全部对话名称和选中状态；重新打开旧对话，历史与后台数据仍完整");
} finally { await stop(); }
