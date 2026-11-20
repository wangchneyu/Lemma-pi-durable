// 网页界面的后端：持有 Harness，提供 REST 接口 + SSE 实时推送，并托管 web/ 下的静态页面。
//   npm run web            正式模式（真实模型 + 本机 CLI）
//   npm run web:demo       演示模式（假模型 + 模拟 CLI，不花钱）
// 只监听 127.0.0.1：这个服务能驱动 agent 改文件、执行命令，绝不能暴露给局域网。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { demoConfig, demoOrchestrator } from "./demo.ts";
import { createOrchestratorModel } from "./models.ts";
import { AgentSessions } from "./tools.ts";
import { toViewItem, toViewLive, type ViewItem, type ViewLive } from "./view.ts";

const context = BACKGROUND_CONTEXT;
const demo = process.argv.includes("--demo") || process.env.PI_AGENT_DEMO === "1";
const port = Number(process.env.PORT ?? (demo ? 8788 : 8787));
const host = "127.0.0.1";
const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

const baseConfig = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const config = demo ? demoConfig(baseConfig) : baseConfig;
const orchestrator = demo ? demoOrchestrator() : createOrchestratorModel(config.orchestrator);
const { harness, root, agents } = await openApp(config, orchestrator, context).catch((error: Error) => {
	console.error(`启动失败：${error.message}`);
	process.exit(1);
});

// ---------- 实时状态：一个 watch，广播给所有浏览器 ----------
const clients = new Set<ServerResponse>();
let lastLive: ViewLive = toViewLive(undefined);
let lastLiveJson = JSON.stringify(lastLive);

function broadcast(event: string, data: unknown) {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of clients) res.write(payload);
}

const watch = await root.watch(context);
const seen = new Set(watch.value.entries.map((e) => Number(e.id)));
lastLive = toViewLive(watch.value.docs["pi.live"]);
lastLiveJson = JSON.stringify(lastLive);
watch.start(async (call) => {
	if (call.kind !== "value") return;
	const fresh: ViewItem[] = [];
	for (const entry of call.value.entries) {
		const id = Number(entry.id);
		if (seen.has(id)) continue;
		seen.add(id);
		const item = toViewItem(entry);
		if (item) fresh.push(item);
	}
	if (fresh.length > 0) broadcast("items", fresh);
	const live = toViewLive(call.value.docs["pi.live"]);
	const json = JSON.stringify(live);
	if (json !== lastLiveJson) {
		lastLive = live;
		lastLiveJson = json;
		broadcast("live", live);
	}
});
harness.resume();

// 心跳：防止代理或浏览器把空闲的 SSE 连接断掉
setInterval(() => {
	for (const res of clients) res.write(": ping\n\n");
}, 20_000).unref();

// ---------- 数据接口 ----------
async function history(limit: number): Promise<ViewItem[]> {
	const page = await root.entries({}, limit, undefined, context);
	return page.items
		.slice()
		.sort((a, b) => Number(a.id) - Number(b.id))
		.map(toViewItem)
		.filter((x): x is ViewItem => x !== undefined);
}

async function state() {
	const usage = (await harness.usage(context)) as any;
	const sessions = ((await harness.snapshot(AgentSessions, context)) as any)?.sessions ?? {};
	return {
		demo,
		orchestrator: orchestrator.describe,
		workdir: config.workdir,
		storage: config.storage,
		agents: agents.map((a) => ({
			kind: a.kind,
			available: a.available,
			reason: a.reason,
			description: config.agents[a.kind].description,
		})),
		sessions: Object.entries<any>(sessions)
			.map(([id, s]) => ({ id, agent: s.agent, cwd: s.cwd, updatedAt: s.updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 30),
		usage: Object.entries<any>(usage?.models ?? {}).map(([model, u]) => ({
			model,
			input: u.input ?? 0,
			output: u.output ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cost: u.cost?.total ?? 0,
		})),
	};
}

// ---------- 安全：只接受本机页面发来的请求 ----------
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

function forbidden(req: IncomingMessage): string | undefined {
	// Host 校验防 DNS 重绑定；Origin 校验防其他网站跨站提交任务
	if (!allowedHosts.has(String(req.headers.host ?? ""))) return "bad host";
	if (req.method !== "GET" && req.method !== "HEAD") {
		const origin = req.headers.origin;
		if (origin !== undefined && !allowedOrigins.has(origin)) return "bad origin";
		if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return "json required";
	}
	return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 1_000_000) throw new Error("请求太大");
	}
	return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

async function serveStatic(pathname: string, res: ServerResponse) {
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const file = normalize(join(WEB_DIR, rel));
	if (!file.startsWith(normalize(WEB_DIR))) return sendJson(res, 403, { error: "forbidden" });
	try {
		const body = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
		res.end(body);
	} catch {
		sendJson(res, 404, { error: "not found" });
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
	const denied = forbidden(req);
	if (denied) return sendJson(res, 403, { error: denied });
	try {
		if (url.pathname === "/api/events" && req.method === "GET") {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
			res.write(`event: snapshot\ndata: ${JSON.stringify({ items: await history(300), live: lastLive })}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (url.pathname === "/api/state" && req.method === "GET") return sendJson(res, 200, await state());
		if (url.pathname === "/api/message" && req.method === "POST") {
			const { text } = await readJson(req);
			if (typeof text !== "string" || !text.trim()) return sendJson(res, 400, { error: "text 不能为空" });
			const submission = await root.submit({ type: "input", content: text.trim() }, context);
			return sendJson(res, 200, { submissionId: submission.id });
		}
		if (url.pathname === "/api/abort" && req.method === "POST") {
			await root.abort(context);
			return sendJson(res, 200, { ok: true });
		}
		if (url.pathname === "/api/reset" && req.method === "POST") {
			await root.reset(undefined, context);
			return sendJson(res, 200, { ok: true });
		}
		if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "unknown api" });
		if (req.method === "GET") return serveStatic(url.pathname, res);
		sendJson(res, 405, { error: "method not allowed" });
	} catch (error) {
		sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(port, host, () => {
	console.log(`pi-agent 网页界面：http://${host}:${port}${demo ? "  （演示模式）" : ""}`);
	console.log(`总调度：${orchestrator.describe}`);
	console.log(`会话存储：${config.storage}`);
});

async function shutdown() {
	for (const res of clients) res.end();
	server.close();
	await watch.stop();
	await harness.close(context);
	setTimeout(() => process.exit(0), 2000).unref();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
