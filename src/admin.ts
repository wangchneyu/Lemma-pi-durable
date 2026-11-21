// 后台管理网页：嵌在终端进程里，和终端共用同一个 Harness，所以终端里的每一步都能实时看到。
// 网页只看 + 控制（中止本轮、开始新上下文），任务只从终端下发。
// 只监听 127.0.0.1：这个进程能驱动 agent 改文件、执行命令，绝不能暴露给局域网。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ADAPTERS } from "./agents.ts";
import type { App } from "./app.ts";
import type { AgentKind, AppConfig } from "./config.ts";
import type { OrchestratorModel } from "./models.ts";
import { AgentSessions } from "./tools.ts";
import { parseToolResult, toViewItem, toViewLive, type Dispatch, type ViewItem, type ViewLive } from "./view.ts";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const HOST = "127.0.0.1";

export interface AdminOptions {
	app: App;
	config: AppConfig;
	configPath: string;
	orchestrator: OrchestratorModel;
	demo: boolean;
	port: number;
	context: Context;
	/** 网页上做了控制操作时，通知终端 */
	notify?: (line: string) => void;
}

export interface AdminServer {
	url: string;
	close(): Promise<void>;
}

const RESUME_COMMAND: Record<AgentKind, (id: string) => string> = {
	claude: (id) => `claude --resume ${id}`,
	codex: (id) => `codex resume ${id}`,
	gemini: (id) => `gemini --resume ${id}`,
};

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

export async function startAdmin(options: AdminOptions): Promise<AdminServer> {
	const { app, config, orchestrator, demo, context } = options;
	const { harness, root, agents } = app;
	const startedAt = Date.now();

	// ---------- 派工汇总：启动时扫一遍全部历史，之后随新条目增量更新 ----------
	const dispatches = new Map<string, Dispatch>(); // key -> 派工
	const latestByCall = new Map<string, string>(); // callId -> 最近一次使用它的派工 key
	let entryCount = 0;
	function ingest(entry: EntryRecord) {
		entryCount++;
		const item = toViewItem(entry);
		if (!item) return;
		if (item.type === "assistant") {
			for (const call of item.toolCalls) {
				const key = `${item.id}:${call.id}`;
				if (dispatches.has(key)) continue;
				latestByCall.set(call.id, key);
				dispatches.set(key, {
					key,
					callId: call.id,
					agent: call.name.replace(/^ask_/, ""),
					task: typeof call.args.task === "string" ? call.args.task : JSON.stringify(call.args),
					resume: typeof call.args.session_id === "string" ? call.args.session_id : null,
					at: item.at,
					entryId: item.id,
					status: "open",
				});
			}
		} else if (item.type === "tool") {
			const known = latestByCall.get(item.callId);
			let d = known ? dispatches.get(known) : undefined;
			if (!d) {
				// 派工消息不在历史里（不应发生，兜底）
				const key = `r${item.id}:${item.callId}`;
				d = { key, callId: item.callId, agent: item.name.replace(/^ask_/, ""), task: "", resume: null, status: "open" };
				dispatches.set(key, d);
			}
			const details = item.details as any;
			const parsed = parseToolResult(item.text, item.isError, details);
			d.status = parsed.status;
			d.endAt = item.at;
			d.resultEntryId = item.id;
			d.durationMs = parsed.durationMs;
			d.cost = typeof details?.costUsd === "number" ? details.costUsd : parsed.cost;
			d.sessionId = parsed.sessionId ?? undefined;
			d.cwd = parsed.cwd;
			d.exitCode = parsed.exitCode;
			d.preview = parsed.body.slice(0, 280);
		}
	}
	let cursor: any;
	do {
		const page = await root.entries({ order: "ascending" }, 500, cursor, context);
		for (const entry of page.items) ingest(entry);
		cursor = page.next;
	} while (cursor);

	function agentStats() {
		const stats: Record<string, { total: number; done: number; error: number; aborted: number; open: number; durationMs: number; timed: number; cost: number; lastAt?: number }> = {};
		for (const d of dispatches.values()) {
			const s = (stats[d.agent] ??= { total: 0, done: 0, error: 0, aborted: 0, open: 0, durationMs: 0, timed: 0, cost: 0 });
			s.total++;
			if (d.status === "done") s.done++;
			else if (d.status === "error") s.error++;
			else if (d.status === "aborted" || d.status === "interrupted") s.aborted++;
			else s.open++;
			if (d.durationMs !== undefined) {
				s.durationMs += d.durationMs;
				s.timed++;
			}
			s.cost += d.cost ?? 0;
			const at = d.endAt ?? d.at;
			if (at && (!s.lastAt || at > s.lastAt)) s.lastAt = at;
		}
		return stats;
	}

	// ---------- 实时状态：一个 watch，广播给所有浏览器 ----------
	const clients = new Set<ServerResponse>();
	const broadcast = (event: string, data: unknown) => {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of clients) res.write(payload);
	};
	const watch = await root.watch(context);
	const seen = new Set(watch.value.entries.map((e) => Number(e.id)));
	let lastLive: ViewLive = toViewLive(watch.value.docs["pi.live"]);
	let lastLiveJson = JSON.stringify(lastLive);
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const fresh: ViewItem[] = [];
		for (const entry of call.value.entries) {
			const id = Number(entry.id);
			if (seen.has(id)) continue;
			seen.add(id);
			ingest(entry);
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
	const ping = setInterval(() => {
		for (const res of clients) res.write(": ping\n\n");
	}, 20_000);
	ping.unref();

	// ---------- 数据 ----------
	async function history(limit: number, before?: number) {
		const query = before ? { maxEntryId: (before - 1) as any } : {};
		const page = await root.entries(query, limit, undefined, context);
		const items = page.items
			.slice()
			.sort((a, b) => Number(a.id) - Number(b.id))
			.map(toViewItem)
			.filter((x): x is ViewItem => x !== undefined);
		return { items, hasMore: page.next !== undefined };
	}

	async function state() {
		const usage = (await harness.usage(context)) as any;
		const sessions = ((await harness.snapshot(AgentSessions, context)) as any)?.sessions ?? {};
		const useCount = new Map<string, number>();
		for (const d of dispatches.values()) if (d.sessionId) useCount.set(d.sessionId, (useCount.get(d.sessionId) ?? 0) + 1);
		const o = config.orchestrator;
		return {
			demo,
			pid: process.pid,
			startedAt,
			configPath: options.configPath,
			workdir: config.workdir,
			storage: config.storage,
			entries: entryCount,
			orchestrator: {
				describe: orchestrator.describe,
				type: orchestrator.info?.type ?? o.type,
				modelId: orchestrator.info?.modelId ?? o.modelId,
				host: orchestrator.info?.host,
				keySource: orchestrator.info?.keySource ?? "",
				maxTurns: o.maxTurns ?? 40,
			},
			stripEnv: config.stripEnv,
			agents: agents.map((a) => {
				const c = config.agents[a.kind];
				return {
					kind: a.kind,
					label: ADAPTERS[a.kind].label,
					available: a.available,
					reason: a.reason,
					enabled: c.enabled,
					description: c.description,
					command: a.command ?? c.command ?? null,
					extraArgs: c.extraArgs,
					timeoutMinutes: c.timeoutMinutes,
					maxOutputChars: c.maxOutputChars,
					canResume: ADAPTERS[a.kind].canResume,
				};
			}),
			agentStats: agentStats(),
			sessions: Object.entries<any>(sessions)
				.map(([id, s]) => ({
					id,
					agent: s.agent,
					cwd: s.cwd,
					updatedAt: s.updatedAt,
					uses: useCount.get(id) ?? 0,
					resume: RESUME_COMMAND[s.agent as AgentKind]?.(id) ?? null,
				}))
				.sort((a, b) => b.updatedAt - a.updatedAt),
			usage: Object.entries<any>(usage?.models ?? {}).map(([model, u]) => ({
				model,
				input: u.input ?? 0,
				output: u.output ?? 0,
				cacheRead: u.cacheRead ?? 0,
				cacheWrite: u.cacheWrite ?? 0,
				cost: u.cost?.total ?? 0,
			})),
		};
	}

	/** 按 key 查；也接受 callId（取最近一次） */
	async function dispatchDetail(id: string) {
		const d = dispatches.get(id) ?? dispatches.get(latestByCall.get(id) ?? "");
		if (!d) return undefined;
		let result: string | undefined;
		if (d.resultEntryId !== undefined) {
			const page = await root.entries({ minEntryId: d.resultEntryId as any, maxEntryId: d.resultEntryId as any }, 1, undefined, context);
			const item = page.items[0] ? toViewItem(page.items[0]) : undefined;
			if (item?.type === "tool") result = parseToolResult(item.text, item.isError, item.details).body;
		}
		return { ...d, result };
	}

	// ---------- HTTP ----------
	let port = options.port;
	const allowed = () => ({
		hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
		origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
	});
	function forbidden(req: IncomingMessage): string | undefined {
		const { hosts, origins } = allowed();
		// Host 校验防 DNS 重绑定；Origin 校验防其他网站跨站发起控制操作
		if (!hosts.has(String(req.headers.host ?? ""))) return "bad host";
		if (req.method !== "GET" && req.method !== "HEAD") {
			const origin = req.headers.origin;
			if (origin !== undefined && !origins.has(origin)) return "bad origin";
			if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return "json required";
		}
		return undefined;
	}
	const sendJson = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};
	async function serveStatic(pathname: string, res: ServerResponse) {
		const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
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

	const server: Server = createServer(async (req, res) => {
		const denied = forbidden(req);
		if (denied) return sendJson(res, 403, { error: denied });
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		try {
			if (url.pathname === "/api/events" && req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
				const { items, hasMore } = await history(400);
				res.write(`event: snapshot\ndata: ${JSON.stringify({ items, hasMore, live: lastLive })}\n\n`);
				clients.add(res);
				req.on("close", () => clients.delete(res));
				return;
			}
			if (url.pathname === "/api/state" && req.method === "GET") return sendJson(res, 200, await state());
			if (url.pathname === "/api/history" && req.method === "GET") {
				const before = Number(url.searchParams.get("before"));
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 400, 1), 1000);
				return sendJson(res, 200, await history(limit, Number.isFinite(before) && before > 0 ? before : undefined));
			}
			if (url.pathname === "/api/dispatches" && req.method === "GET") {
				const list = [...dispatches.values()].sort((a, b) => (b.entryId ?? b.resultEntryId ?? 0) - (a.entryId ?? a.resultEntryId ?? 0));
				return sendJson(res, 200, { dispatches: list });
			}
			const detail = url.pathname.match(/^\/api\/dispatches\/([^/]+)$/);
			if (detail && req.method === "GET") {
				const d = await dispatchDetail(decodeURIComponent(detail[1]!));
				return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: "没有这次派工" });
			}
			if (url.pathname === "/api/abort" && req.method === "POST") {
				await root.abort(context);
				options.notify?.("后台网页：已中止本轮");
				return sendJson(res, 200, { ok: true });
			}
			if (url.pathname === "/api/reset" && req.method === "POST") {
				await root.reset(undefined, context);
				options.notify?.("后台网页：已开始新的上下文");
				return sendJson(res, 200, { ok: true });
			}
			if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "unknown api" });
			if (req.method === "GET") return serveStatic(url.pathname, res);
			sendJson(res, 405, { error: "method not allowed" });
		} catch (error) {
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});

	// 端口被占用时依次往后找（比如正式模式和演示模式同时开着）
	for (let attempt = 0; ; attempt++) {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, HOST, () => {
					server.off("error", reject);
					resolve();
				});
			});
			break;
		} catch (error: any) {
			if (error?.code !== "EADDRINUSE" || attempt >= 9) {
				await watch.stop();
				throw error;
			}
			port++;
		}
	}

	return {
		url: `http://${HOST}:${port}`,
		async close() {
			clearInterval(ping);
			for (const res of clients) res.end();
			clients.clear();
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await closed;
			await watch.stop();
		},
	};
}
