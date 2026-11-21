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
	check(state.demo === true && state.agents.length === 4 && state.agents.every((a: any) => a.available), "/api/state 返回演示模式和四个可用成员");
	const dsInfo = state.agents.find((a: any) => a.kind === "deepseek");
	check(dsInfo?.api?.host === "api.deepseek.com" && /PI_AGENT_DEMO_KEY/.test(dsInfo.api.keySource) && !JSON.stringify(dsInfo).includes("demo-placeholder"), "DeepSeek 显示接入地址和密钥来源，不含密钥");
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
	// 演示剧本一是异步的：设计、编码、调研三项放后台并行，编码做完后基于它的改动在后台派审查
	const jobEvents = events.filter((e) => e.event === "jobs").map((e) => e.data as any[]);
	const outputs = events.filter((e) => e.event === "job-output").map((e) => e.data);
	check(all.some((i: any) => i.type === "assistant" && i.toolCalls.length === 3 && i.toolCalls.every((c: any) => c.args.background === true)), "推送了总调度的三个后台派工");
	check(all.filter((i: any) => i.type === "tool" && i.name.startsWith("ask_") && /已在后台开工 J\d/.test(i.text)).length === 4, "四次派工都立刻返回了后台编号");
	check(all.some((i: any) => i.type === "assistant" && i.toolCalls.some((c: any) => c.name === "wait_jobs")), "总调度用 wait_jobs 等后台结果");
	check(jobEvents.some((list) => list.filter((j) => j.status === "running").length >= 3), "三个后台派工同时在跑（并行）");
	check(outputs.some((o: any) => /^J\d+$/.test(o.id) && o.line.includes("🔧")), "推送了后台派工的实时输出");
	check(lives.some((l) => l.partial.length > 0), "实时状态里有总调度的流式草稿");
	check(all.some((i: any) => i.type === "assistant" && i.text.includes("汇报")), "推送了最终汇报");
	await sleep(300);
	check(events.filter((e) => e.event === "live").at(-1)?.data.busy === false, "结束后状态回到空闲");

	const { dispatches } = await json("/api/dispatches");
	check(dispatches.length === 4 && dispatches.every((d: any) => d.job && d.status === "done" && d.durationMs > 0 && d.sessionId), "派工汇总里四次后台派工都完成了（状态、耗时、会话来自后台记录）");
	const detail = await json(`/api/dispatches/${encodeURIComponent(dispatches[0].key)}`);
	check(typeof detail.result === "string" && detail.result.includes("_OK"), "后台派工的详情返回完整结果");
	const after = await json("/api/state");
	check(after.jobs.length === 4 && after.jobs.every((j: any) => j.status === "done"), "状态接口带上后台派工列表");
	check(after.agentStats.claude?.done === 2 && after.agentStats.deepseek?.done === 1 && after.agentStats.gemini?.done === 1, "成员统计把后台派工算进去（实现由 DeepSeek 完成）");
	const topo = await json("/api/topology");
	const claudeLanes = topo.lanes.filter((l: any) => l.agent === "claude" && l.session);
	check(topo.bars.length === 4 && topo.bars.every((b: any) => b.mode === "async"), "拓扑接口：四条后台派工时间条");
	check(claudeLanes.length === 2, "拓扑接口：Claude 开了两个会话（设计、审查），各占一条泳道");
	check(topo.links.length === 1 && topo.stats.peak >= 3, "拓扑接口：审查基于编码的改动（一条依赖），并行峰值至少 3 路");
	check((await raw("/api/jobs/J99/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404, "取消不存在的后台派工返回 404");
	const firstId = all[0].id;
	const older = await json(`/api/history?before=${all.at(-1).id}&limit=2`);
	check(older.items.length === 2 && older.items.every((i: any) => i.id < all.at(-1).id) && older.hasMore === true && firstId > 0, "历史分页接口按 id 往前翻");

	// 一次写入多行命令：必须按顺序执行（/clean 要等 /apply all 做完，才能清掉刚合并的改动）
	const { changes: before } = await json("/api/changes");
	const pendingCount = before.filter((c: any) => c.status === "pending").length;
	check(pendingCount >= 3, `演示派工在沙盒仓库里产生了待合并的改动（${pendingCount} 个）`);
	terminal.stdin!.write("/apply all\n/clean\n");
	for (let i = 0; i < 50 && !/清理了 \d+ 个 worktree|没有需要清理/.test(terminalOutput); i++) await sleep(100);
	check(Number(terminalOutput.match(/清理了 (\d+) 个 worktree/)?.[1] ?? 0) >= pendingCount, "多行命令按顺序执行：/clean 清掉了刚合并的改动");

	const conv = await json("/api/conventions");
	check(Array.isArray(conv.files) && conv.members?.claude && conv.files.every((f: any) => f.path === undefined), "规范文件接口返回扫描结果，不暴露绝对路径");
	check((await raw("/api/conventions/file?id=project%3A..%2F..%2Fpackage.json")).status === 404, "规范文件接口不能读任意路径");

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
