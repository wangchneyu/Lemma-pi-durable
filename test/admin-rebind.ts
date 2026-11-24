// HTTP 监听器与会话绑定分离：切换不重启端口、不混历史，失败也不损坏原绑定。
import assert from "node:assert/strict";
import { Agent, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { startAdmin, type AdminOptions } from "../src/admin.ts";
import { openApp } from "../src/app.ts";
import { Resources } from "../src/resources.ts";
import { check, fauxOrchestrator, testConfig } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const configs = [testConfig(), testConfig()];
const models = [fauxOrchestrator(), fauxOrchestrator()];
const first = await openApp(configs[0]!, models[0]!, context, { memory: true });
const second = await openApp(configs[1]!, models[1]!, context, { memory: true });
const apps = [first, second];
const options = (index: number): AdminOptions => ({
	app: apps[index]!, config: configs[index]!, configPath: "test-only.json",
	orchestrator: { ...models[index]!, describe: "faux" }, port: 0, context,
	session: { id: index ? "second" : "first", title: index ? "第二个" : "第一个" },
});
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const admin = await startAdmin(options(0));
let stream: IncomingMessage | undefined;
async function raw(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; data: any; socket: Socket }>((resolve, reject) => {
		let socket: Socket;
		const req = request(admin.url + path, { agent, method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
			let text = ""; res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(text), socket }); } catch (error) { reject(error); } });
		});
		req.on("socket", (value) => { socket = value; }); req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
try {
	models[0]!.faux.setResponses([fauxAssistantMessage(fauxText("旧会话完成"))]);
	await (await first.root.submit({ type: "input", content: "旧会话的私有输入" }, context)).wait(context);
	const initial = await raw("/api/state");
	const originalUrl = admin.url;
	const socket = initial.socket;
	const baseline = { changes: second.changes.listenerCount("change"), project: second.project.listenerCount("change"), jobs: second.jobs.listenerCount("change") };
	let streamEnded = false;
	let events = "";
	await new Promise<void>((resolve, reject) => {
		const req = request(admin.url + "/api/events", (res) => {
			stream = res; res.on("end", () => { streamEnded = true; }); res.on("data", (chunk) => { events += chunk; });
			res.once("data", () => resolve()); res.resume();
		}); req.on("error", reject); req.end();
	});
	await first.harness.commit(async (tx) => { (await tx.doc(Resources)).claims.fixture = { id: "fixture", member: "claude", service: "cli:claude", runKey: null, status: "queued", reservedUsd: 0, at: Date.now(), reason: "等待团队并发名额" }; }, context);
	const eventDeadline = Date.now() + 3000; while (!events.includes("event: resources") && Date.now() < eventDeadline) await new Promise((done) => setTimeout(done, 20));
	assert(events.includes("event: resources")); assert.equal((await raw("/api/state")).data.resources.queued.length, 1);
	check(true, "排队文档首次创建即经 Durable 提交订阅推送网页，不依赖定时刷新");
	await admin.rebind(options(1));
	const changed = await raw("/api/state");
	assert.equal(admin.url, originalUrl); assert.equal(changed.socket, socket);
	assert.equal(changed.data.startedAt, initial.data.startedAt);
	assert.equal(changed.data.conversation.id, "second");
	assert.deepEqual((await raw("/api/history")).data.items, []);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(streamEnded, "Old SSE stream must finish on rebind");
	assert.equal((await raw("/api/state?conversation=first")).status, 409);
	assert.equal((await raw("/api/reset", { expectedSession: "first" })).status, 409);
	assert.equal((await raw("/api/state", undefined, { host: "evil.example" })).status, 403);
	check(true, "切换会话复用同一个 HTTP 连接与端口，旧 SSE 结束，过期操作被拒绝");
	// HTTP 头先到旧绑定，请求体在切换后才结束，不能对新对话执行旧操作。
	let delayedRequest!: ReturnType<typeof request>;
	const delayedResponse = new Promise<number>((resolve, reject) => {
		delayedRequest = request(admin.url + "/api/reset", { method: "POST", headers: { "content-type": "application/json" } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
		delayedRequest.on("error", reject); delayedRequest.flushHeaders(); delayedRequest.write("{");
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	await admin.rebind(options(0));
	delayedRequest.end('"expectedSession":"second"}');
	assert.equal(await delayedResponse, 409);
	await admin.rebind(options(1));
	for (let i = 0; i < 3; i++) { await admin.rebind(options(0)); await admin.rebind(options(1)); }
	assert.equal(second.changes.listenerCount("change"), baseline.changes + 1);
	assert.equal(second.project.listenerCount("change"), baseline.project + 1);
	assert.equal(second.jobs.listenerCount("change"), baseline.jobs + 1);
	const failedOptions = options(0);
	failedOptions.app = { ...first, root: new Proxy(first.root, { get(target, key) { if (key === "watch") return async () => { throw new Error("injected bind failure"); }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } }) };
	await assert.rejects(admin.rebind(failedOptions), /injected bind failure/);
	assert.equal((await raw("/api/state")).data.conversation.id, "second");
	await admin.rebind(options(0));
	const oldHistory = (await raw("/api/history")).data.items;
	assert.ok(oldHistory.some((item: any) => item.text === "旧会话的私有输入"));
	assert.ok(oldHistory.some((item: any) => item.text === "旧会话完成"));
	check(true, "反复切换不累积监听器；绑定失败保留旧视图，切回后原历史完整");
	await Promise.all([admin.close(), admin.close()]);
	await assert.rejects(admin.rebind(options(1)), /后台已关闭/);
	assert.equal(second.changes.listenerCount("change"), baseline.changes);
	assert.equal(second.project.listenerCount("change"), baseline.project);
	assert.equal(second.jobs.listenerCount("change"), baseline.jobs);
	check(true, "重复关闭可安全清理所有绑定，关闭后拒绝重新绑定");
} finally {
	stream?.destroy(); agent.destroy(); await admin.close();
	await Promise.all(apps.map((app) => app.harness.close(context)));
}
