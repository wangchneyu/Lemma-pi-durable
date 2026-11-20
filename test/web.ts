// 网页后端测试：以演示模式启动真实的服务器进程，检查接口、安全校验、SSE 实时推送的完整流程。
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-agent-web-"));
const port = 8799;
const base = `http://127.0.0.1:${port}`;
writeFileSync(join(dir, "config.json"), JSON.stringify({ workdir: dir, storage: join(dir, "session.sqlite") }));

const server = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/server.ts", import.meta.url)), "--demo"], {
	env: { ...process.env, PI_AGENT_CONFIG: join(dir, "config.json"), PORT: String(port), FAKE_AGENT_DELAY_MS: "600", NO_PROXY: "*" },
	stdio: ["ignore", "pipe", "inherit"],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function raw(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request(`${base}${path}`, { method: init.method ?? "GET", headers: init.headers }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end(init.body);
	});
}

try {
	let ready = false;
	for (let i = 0; i < 100 && !ready; i++) {
		ready = await raw("/api/state").then((r) => r.status === 200, () => false);
		if (!ready) await sleep(150);
	}
	check(ready, "演示模式服务器已启动");

	const state = JSON.parse((await raw("/api/state")).body);
	check(state.demo === true && state.agents.length === 3 && state.agents.every((a: any) => a.available), "/api/state 返回演示模式和三个可用成员");

	const page = await raw("/");
	check(page.status === 200 && page.body.includes("pi-agent 调度台"), "首页可以访问");
	check((await raw("/app.js")).status === 200 && (await raw("/style.css")).status === 200, "静态资源可以访问");
	const traversal = await raw("/..%2fpackage.json");
	check(traversal.status === 403 || traversal.status === 404, "路径穿越读不到项目外的文件");

	check((await raw("/api/state", { headers: { host: "evil.example" } })).status === 403, "非本机 Host 被拒绝（防 DNS 重绑定）");
	const crossSite = await raw("/api/message", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "https://evil.example" },
		body: JSON.stringify({ text: "x" }),
	});
	check(crossSite.status === 403, "其他网站的跨站提交被拒绝");
	const form = await raw("/api/message", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=x" });
	check(form.status === 403, "非 JSON 的表单提交被拒绝");
	const empty = await raw("/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: " " }) });
	check(empty.status === 400, "空消息被拒绝");

	// SSE：先连上，再发消息，收集事件直到出现汇报
	const events: Array<{ event: string; data: any }> = [];
	const controller = new AbortController();
	const sse = await fetch(`${base}/api/events`, { signal: controller.signal });
	const reader = sse.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const pump = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buffer.indexOf("\n\n")) >= 0) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const event = chunk.match(/^event: (.*)$/m)?.[1];
				const data = chunk.match(/^data: (.*)$/m)?.[1];
				if (event && data) events.push({ event, data: JSON.parse(data) });
			}
		}
	})().catch(() => {});

	await sleep(300);
	check(events[0]?.event === "snapshot", "SSE 连接后先收到快照");
	const sent = await raw("/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "加一个导出按钮" }) });
	check(sent.status === 200 && JSON.parse(sent.body).submissionId !== undefined, "通过接口提交任务");

	const items = () => events.filter((e) => e.event === "items").flatMap((e) => e.data);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && !items().some((i: any) => i.type === "assistant" && i.text.includes("汇报"))) await sleep(100);

	const all = items();
	const lives = events.filter((e) => e.event === "live").map((e) => e.data);
	check(all.some((i: any) => i.type === "user" && i.text === "加一个导出按钮"), "推送了用户消息");
	const dispatch = all.find((i: any) => i.type === "assistant" && i.toolCalls.length === 2);
	check(dispatch !== undefined, "推送了总调度的派工（两个工具调用）");
	check(all.filter((i: any) => i.type === "tool" && !i.isError).length === 2, "推送了两个成员的结果");
	check(
		lives.some((l) => l.tools.filter((t: any) => t.status === "running").length === 2),
		"实时状态里两个成员同时处于执行中（并行）",
	);
	check(lives.some((l) => l.tools.some((t: any) => t.output.includes("🔧"))), "实时状态里有成员的进度日志");
	check(lives.some((l) => l.partial.length > 0), "实时状态里有总调度的流式草稿");
	check(all.some((i: any) => i.type === "assistant" && i.text.includes("汇报")), "推送了最终汇报");
	check(lives.at(-1)?.busy === false, "结束后状态回到空闲");

	const after = JSON.parse((await raw("/api/state")).body);
	check(after.sessions.length === 2, "会话登记表里记录了两个 CLI 会话");

	controller.abort();
	await pump;
	console.log("\n网页后端测试通过 ✅");
} finally {
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
	else server.kill("SIGKILL");
}
