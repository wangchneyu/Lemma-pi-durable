// 后台网页测试：以演示模式启动真实的终端进程（后台嵌在里面），从终端的 stdin 下发任务，
// 检查后台接口、安全校验、SSE 实时推送和派工汇总。网页本身不能下发任务。
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

const terminal = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--demo"], {
	env: { ...process.env, PI_AGENT_CONFIG: join(dir, "config.json"), PI_AGENT_PORT: String(port), FAKE_AGENT_DELAY_MS: "600", NO_PROXY: "*" },
	stdio: ["pipe", "pipe", "inherit"],
});
let terminalOutput = "";
terminal.stdout!.on("data", (chunk) => (terminalOutput += chunk));
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
const json = async (path: string) => JSON.parse((await raw(path)).body);

try {
	let ready = false;
	for (let i = 0; i < 100 && !ready; i++) {
		ready = await raw("/api/state").then((r) => r.status === 200, () => false);
		if (!ready) await sleep(150);
	}
	check(ready, "终端启动时后台网页随之启动");
	check(terminalOutput.includes(`后台网页：`) && terminalOutput.includes(String(port)), "终端横幅里显示后台地址");

	const state = await json("/api/state");
	check(state.demo === true && state.agents.length === 3 && state.agents.every((a: any) => a.available), "/api/state 返回演示模式和三个可用成员");
	check(state.orchestrator.keySource && !JSON.stringify(state).match(/sk-|token"/i), "配置信息只给出密钥来源，不含密钥");

	const page = await raw("/");
	check(page.status === 200 && page.body.includes("pi-agent 后台"), "首页可以访问");
	const assets = await Promise.all(["/js/main.js", "/js/sankey.js", "/js/views.js", "/style.css"].map((p) => raw(p)));
	check(assets.every((a) => a.status === 200), "静态资源可以访问");
	const traversal = await raw("/..%2fpackage.json");
	check(traversal.status === 403 || traversal.status === 404, "路径穿越读不到项目外的文件");

	check((await raw("/api/state", { headers: { host: "evil.example" } })).status === 403, "非本机 Host 被拒绝（防 DNS 重绑定）");
	const crossSite = await raw("/api/abort", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
	check(crossSite.status === 403, "其他网站的跨站控制请求被拒绝");
	const form = await raw("/api/abort", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
	check(form.status === 403, "非 JSON 的表单请求被拒绝");
	const submit = await raw("/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
	check(submit.status === 404, "网页不能下发任务（任务只从终端下发）");

	// SSE：先连上，再从终端输入任务，收集事件直到出现汇报
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
	terminal.stdin!.write("加一个导出按钮\n");

	const items = () => events.filter((e) => e.event === "items").flatMap((e) => e.data);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && !items().some((i: any) => i.type === "assistant" && i.text.includes("汇报"))) await sleep(100);

	const all = items();
	const lives = events.filter((e) => e.event === "live").map((e) => e.data);
	check(all.some((i: any) => i.type === "user" && i.text === "加一个导出按钮"), "终端输入的任务实时推送到后台");
	check(all.some((i: any) => i.type === "assistant" && i.toolCalls.length === 2), "推送了总调度的派工（两个工具调用）");
	check(all.filter((i: any) => i.type === "tool" && !i.isError).length === 2, "推送了两个成员的结果");
	check(lives.some((l) => l.tools.filter((t: any) => t.status === "running").length === 2), "实时状态里两个成员同时处于执行中（并行）");
	check(lives.some((l) => l.tools.some((t: any) => t.output.includes("🔧"))), "实时状态里有成员的进度日志");
	check(lives.some((l) => l.partial.length > 0), "实时状态里有总调度的流式草稿");
	check(all.some((i: any) => i.type === "assistant" && i.text.includes("汇报")), "推送了最终汇报");
	await sleep(300);
	check(events.filter((e) => e.event === "live").at(-1)?.data.busy === false, "结束后状态回到空闲");

	const { dispatches } = await json("/api/dispatches");
	check(dispatches.length === 2 && dispatches.every((d: any) => d.status === "done" && d.durationMs > 0 && d.sessionId), "派工汇总里有两次完成的派工（耗时、会话齐全）");
	const detail = await json(`/api/dispatches/${encodeURIComponent(dispatches[0].key)}`);
	check(typeof detail.result === "string" && detail.result.includes("_OK"), "派工详情返回完整结果");
	const after = await json("/api/state");
	check(after.sessions.length === 2 && after.agentStats.claude?.done === 1 && after.agentStats.codex?.done === 1, "会话登记表和成员统计都更新了");
	const firstId = all[0].id;
	const older = await json(`/api/history?before=${all.at(-1).id}&limit=2`);
	check(older.items.length === 2 && older.items.every((i: any) => i.id < all.at(-1).id) && older.hasMore === true && firstId > 0, "历史分页接口按 id 往前翻");

	const abort = await raw("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	await sleep(200);
	check(abort.status === 200 && terminalOutput.includes("后台网页：已中止本轮"), "网页上的中止会通知终端");

	controller.abort();
	await pump;
	console.log("\n后台网页测试通过 ✅");
} finally {
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(terminal.pid), "/T", "/F"], { stdio: "ignore" });
	else terminal.kill("SIGKILL");
}
