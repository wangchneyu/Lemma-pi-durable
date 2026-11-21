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
import { memberKey } from "./api-member.ts";
import type { App } from "./app.ts";
import type { AgentKind, AppConfig } from "./config.ts";
import type { OrchestratorModel } from "./models.ts";
import { Board, boardTasks, type BoardState } from "./board.ts";
import { readConvention, scanConventions } from "./conventions.ts";
import { diffText } from "./git.ts";
import { Jobs, type JobRecord, type JobsState } from "./jobs.ts";
import { LEAD_TOOL } from "./lead.ts";
import { AgentSessions, RunBudget } from "./tools.ts";
import { Learning } from "./learning.ts";
import { parseToolResult, toViewItem, toViewLive, type Dispatch, type ViewItem, type ViewLive } from "./view.ts";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const HOST = "127.0.0.1";

export interface AdminOptions {
	conversations?: {
		list(): Promise<unknown[]>;
		create(title: string): Promise<{ id: string }>;
		select(id: string): Promise<void>;
		rename(id: string, title: string): Promise<void>;
		busy(): boolean;
	};
	session?: { id: string; title: string; controllerId?: string };
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
	deepseek: () => "（Pi 子对话，由 Lemma 续接）",
};

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

export async function startAdmin(options: AdminOptions): Promise<AdminServer> {
	const { app, config, orchestrator, demo, context } = options;
	const { harness, root, agents, changes, project } = app;
	const startedAt = Date.now();

	// ---------- 派工汇总：启动时扫一遍全部历史，之后随新条目增量更新 ----------
	const dispatches = new Map<string, Dispatch>(); // key -> 派工
	const latestByCall = new Map<string, string>(); // callId -> 最近一次使用它的派工 key
	let entryCount = 0;
	// ---------- 子调度：总调度交出去的子目标，以及子调度在自己子对话里派的工 ----------
	type Lead = { key: string; callId: string; name: string; goal: string; taskId?: string; at?: number; endAt?: number; status: Dispatch["status"]; conversationId?: string; dispatches?: number };
	const leads = new Map<string, Lead>();
	const latestLeadByCall = new Map<string, string>();
	const childWatches: { stop(): Promise<unknown> }[] = [];
	const attached = new Set<string>();

	/** lead：这条记录来自哪个子调度的子对话（总调度自己的记录不传） */
	function ingest(entry: EntryRecord, lead?: string) {
		if (!lead) entryCount++;
		const item = toViewItem(entry);
		if (!item) return;
		const scope = lead ? `${lead}>` : "";
		if (item.type === "assistant") {
			for (const call of item.toolCalls) {
				if (!lead && call.name === LEAD_TOOL) {
					const key = `${item.id}:${call.id}`;
					if (leads.has(key)) continue;
					latestLeadByCall.set(call.id, key);
					leads.set(key, {
						key,
						callId: call.id,
						name: typeof call.args.name === "string" ? call.args.name : "子调度",
						goal: typeof call.args.goal === "string" ? call.args.goal : "",
						taskId: typeof call.args.task_id === "string" ? call.args.task_id : undefined,
						at: item.at,
						status: "open",
					});
					continue;
				}
				if (!call.name.startsWith("ask_")) continue; // 只有派给成员的才算派工（分工表工具不算）
				const key = `${scope}${item.id}:${call.id}`;
				if (dispatches.has(key)) continue;
				latestByCall.set(`${scope}${call.id}`, key);
				dispatches.set(key, {
					key,
					...(lead ? { lead } : {}),
					callId: call.id,
					agent: call.name.replace(/^ask_/, ""),
					task: typeof call.args.task === "string" ? call.args.task : JSON.stringify(call.args),
					resume: typeof call.args.session_id === "string" ? call.args.session_id : null,
					at: item.at,
					entryId: item.id,
					status: "open",
					model: typeof call.args.model === "string" ? call.args.model : config.agents[call.name.replace(/^ask_/, "") as AgentKind]?.defaultModel,
					basedOn: typeof call.args.based_on === "string" ? call.args.based_on : undefined,
					taskId: typeof call.args.task_id === "string" ? call.args.task_id : undefined,
				});
			}
		} else if (item.type === "tool") {
			if (!lead && item.name === LEAD_TOOL) {
				const l = leads.get(latestLeadByCall.get(item.callId) ?? "");
				if (!l) return;
				const details = item.details as any;
				l.status = item.isError ? (/<harness>[\s\S]*aborted/i.test(item.text) ? "aborted" : "error") : "done";
				l.endAt = item.at;
				if (typeof details?.dispatches === "number") l.dispatches = details.dispatches;
				if (typeof details?.conversationId === "string") attachLead(l, details.conversationId);
				return;
			}
			if (!item.name.startsWith("ask_")) return;
			const known = latestByCall.get(`${scope}${item.callId}`);
			let d = known ? dispatches.get(known) : undefined;
			if (!d) {
				// 派工消息不在历史里（不应发生，兜底）
				const key = `${scope}r${item.id}:${item.callId}`;
				d = { key, ...(lead ? { lead } : {}), callId: item.callId, agent: item.name.replace(/^ask_/, ""), task: "", resume: null, status: "open" };
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
			if (typeof details?.model === "string") d.model = details.model;
			d.costEstimated = details?.costEstimated === true || undefined;
			if (typeof details?.changeId === "string") d.changeId = details.changeId;
			// 后台派工：这条结果只是「已开工」，真正的结果在后台派工记录里（见 withJob）
			if (typeof details?.job === "string") {
				d.job = details.job;
				d.status = "open";
				d.endAt = undefined;
				d.durationMs = undefined;
			}
		}
	}

	/** 找到子调度的子对话后：读它已有的记录，再跟着它的新记录（派工汇总、拓扑都会算上） */
	let onLeadActivity = () => {};
	function attachLead(l: Lead, conversationId: string) {
		l.conversationId = conversationId;
		if (attached.has(conversationId)) return;
		attached.add(conversationId);
		void (async () => {
			const child = await harness.conversation(conversationId as any, context);
			if (!child) return;
			let cursor: any;
			do {
				const page = await child.entries({ order: "ascending" } as any, 500, cursor, context);
				for (const entry of page.items) ingest(entry, l.key);
				cursor = page.next;
			} while (cursor);
			const watch = await child.watch(context);
			const seenChild = new Set(watch.value.entries.map((e) => String(e.id)));
			watch.start(async (call) => {
				if (call.kind !== "value") return;
				let fresh = false;
				for (const entry of call.value.entries) {
					if (seenChild.has(String(entry.id))) continue;
					seenChild.add(String(entry.id));
					ingest(entry, l.key);
					fresh = true;
				}
				if (fresh) onLeadActivity();
			});
			childWatches.push(watch);
			onLeadActivity();
		})().catch(() => {});
	}

	// ---------- 后台派工：Pi Durable 文档里的记录，叠加到派工汇总上 ----------
	let jobs: Record<string, JobRecord> = {};
	async function refreshJobs() {
		jobs = ((await harness.snapshot(Jobs, context)) as JobsState | undefined)?.jobs ?? {};
	}
	await refreshJobs();
	/** 后台派工以后台记录为准（状态、会话、花费、结束时间） */
	function withJob(d: Dispatch): Dispatch {
		const j = d.job ? jobs[d.job] : undefined;
		if (!j) return d;
		const status: Dispatch["status"] = j.status === "running" ? "open" : j.status === "done" ? "done" : j.status === "failed" ? "error" : "aborted";
		return {
			...d,
			status,
			at: j.startedAt,
			endAt: j.endedAt,
			durationMs: j.durationMs,
			cost: j.costUsd,
			costEstimated: j.costEstimated,
			sessionId: j.sessionId,
			model: j.model ?? d.model,
			changeId: j.changeId,
			preview: j.result ? j.result.slice(0, 280) : d.preview,
		};
	}
	const allDispatches = () => [...dispatches.values()].map(withJob);
	let cursor: any;
	do {
		const page = await root.entries({ order: "ascending" }, 500, cursor, context);
		for (const entry of page.items) ingest(entry);
		cursor = page.next;
	} while (cursor);

	function agentStats() {
		const stats: Record<string, { total: number; done: number; error: number; aborted: number; open: number; durationMs: number; timed: number; cost: number; lastAt?: number }> = {};
		for (const d of allDispatches()) {
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

	/** 按 成员 × 模型 汇总：用来对比不同模型的花费和成功率 */
	function modelStats() {
		const rows = new Map<string, { agent: string; model: string; total: number; done: number; error: number; durationMs: number; timed: number; cost: number; estimated: boolean }>();
		for (const d of allDispatches()) {
			const model = d.model ?? "（CLI 默认）";
			const key = `${d.agent}|${model}`;
			let r = rows.get(key);
			if (!r) rows.set(key, (r = { agent: d.agent, model, total: 0, done: 0, error: 0, durationMs: 0, timed: 0, cost: 0, estimated: false }));
			r.total++;
			if (d.status === "done") r.done++;
			else if (d.status === "error") r.error++;
			if (d.durationMs !== undefined) {
				r.durationMs += d.durationMs;
				r.timed++;
			}
			r.cost += d.cost ?? 0;
			if (d.costEstimated) r.estimated = true;
		}
		return [...rows.values()].sort((a, b) => a.agent.localeCompare(b.agent) || b.total - a.total);
	}

	// ---------- 实时状态：一个 watch，广播给所有浏览器 ----------
	const clients = new Set<ServerResponse>();
	const broadcast = (event: string, data: unknown) => {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of clients) res.write(payload);
	};
	const watch = await root.watch(context);
	const seen = new Set(watch.value.entries.map((e) => Number(e.id)));
	let lastLive: ViewLive = toViewLive(watch.value.docs["pi.live"], watch.value.docs["pi.inbox"]);
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
		const live = toViewLive(call.value.docs["pi.live"], call.value.docs["pi.inbox"]);
		for (const slot of live.tools) {
			const conv = (slot.details as any)?.conversationId;
			if (slot.name !== LEAD_TOOL || typeof conv !== "string") continue;
			const l = leads.get(latestLeadByCall.get(slot.callId) ?? "");
			if (l && !l.conversationId) attachLead(l, conv);
		}
		const json = JSON.stringify(live);
		if (json !== lastLiveJson) {
			lastLive = live;
			lastLiveJson = json;
			broadcast("live", live);
		}
	});
	// 改动记录变了（派工收尾、终端里 /apply /drop）：通知页面刷新
	const onChange = (record: unknown) => broadcast("change", record);
	changes.on("change", onChange);
	// 目标或分工表变了：通知页面刷新「项目」
	const onProject = () => broadcast("project", null);
	project.on("change", onProject);
	// 后台派工开工 / 结束：刷新记录并通知页面；成员的实时输出直接转发
	onLeadActivity = () => broadcast("lead", null);
	const onJobs = () => {
		void refreshJobs().then(() => broadcast("jobs", Object.values(jobs)));
	};
	const onJobOutput = (id: string, line: string) => broadcast("job-output", { id, line });
	app.jobs.on("change", onJobs);
	app.jobs.on("output", onJobOutput);
	const ping = setInterval(() => {
		for (const res of clients) res.write(": ping\n\n");
	}, 20_000);
	ping.unref();

	// ---------- 数据 ----------
	/** 往前取 limit 条能显示的条目（系统提示更新等不显示的条目不占名额） */
	async function history(limit: number, before?: number) {
		const query = before ? { maxEntryId: (before - 1) as any } : {};
		const items: ViewItem[] = [];
		let cursor: any;
		let hasMore = false;
		do {
			const page = await root.entries(query, limit, cursor, context);
			for (const entry of page.items) {
				const item = toViewItem(entry);
				if (!item) continue;
				if (items.length === limit) {
					hasMore = true;
					break;
				}
				items.push(item);
			}
			cursor = page.next;
			if (!hasMore && items.length === limit && cursor) hasMore = true;
		} while (cursor && items.length < limit);
		items.sort((a, b) => a.id - b.id);
		return { items, hasMore };
	}

	/** 后台派工列表：进行中的在前，带最近的实时输出 */
	function jobList() {
		return Object.values(jobs)
			.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt)
			.map((j) => ({ ...j, waiter: undefined, output: j.status === "running" ? app.jobs.recent(j.id).slice(-20) : undefined }));
	}

	/**
	 * 协作拓扑：总调度 → 成员 → 会话（泳道）→ 每次派工（时间条），加上「基于某次改动」的依赖。
	 * 同一个成员的多条泳道 = 它同时 / 先后开的多个会话；时间条重叠 = 并行。
	 */
	async function topology(limit = 80) {
		const sessions = ((await harness.snapshot(AgentSessions, context)) as any)?.sessions ?? {};
		const live = lastLive;
		const now = Date.now();
		const list = allDispatches()
			.filter((d) => d.at !== undefined)
			.sort((a, b) => a.at! - b.at!)
			.slice(-limit);
		type Lane = { id: string; agent: string; session: string | null; rounds: number; first: number; last: number; running: boolean; model?: string; lastTask?: string; tasks: string[] };
		const lanes = new Map<string, Lane>();
		// 真的在跑：同步派工有实时槽位，后台派工的记录在跑，子调度派的工要它的子调度还在跑。
		// 没有结果、也不在跑的（比如进程中途退出过），只是「中断」，不能画成一直在执行。
		const slotRunning = (callId: string) => live.busy && live.tools.some((t) => t.callId === callId && t.status !== "done");
		const leadRunning = (key: string) => {
			const l = leads.get(key);
			return !!l && l.status === "open" && slotRunning(l.callId);
		};
		const isRunning = (d: Dispatch) => {
			if (d.status !== "open") return false;
			if (d.job) return jobs[d.job]?.status === "running";
			if (d.lead) return leadRunning(d.lead);
			return slotRunning(d.callId);
		};
		const bars = list.map((d) => {
			const running = isRunning(d);
			if (d.status === "open" && !running) d = { ...d, status: "interrupted" };
			// 同步派工还在跑时，会话 ID 在实时槽位的 details 里
			const slot = running && !d.job ? live.tools.find((t) => t.callId === d.callId) : undefined;
			const session = d.resume ?? d.sessionId ?? ((slot?.details as any)?.sessionId as string | undefined) ?? null;
			const laneId = session ?? `solo:${d.key}`;
			const end = d.endAt ?? (running ? now : d.at!);
			let lane = lanes.get(laneId);
			if (!lane) lanes.set(laneId, (lane = { id: laneId, agent: d.agent, session, rounds: 0, first: d.at!, last: end, running: false, tasks: [] }));
			lane.rounds++;
			lane.last = Math.max(lane.last, end);
			lane.running ||= running;
			if (d.model) lane.model = d.model;
			lane.lastTask = d.task.replace(/\s+/g, " ").trim().slice(0, 80);
			if (d.taskId && !lane.tasks.includes(d.taskId)) lane.tasks.push(d.taskId);
			return {
				key: d.key,
				lane: laneId,
				agent: d.agent,
				start: d.at!,
				end,
				running,
				status: d.status,
				mode: d.job ? "async" : "sync",
				lead: d.lead,
				job: d.job ?? null,
				task: d.task.replace(/\s+/g, " ").trim().slice(0, 140),
				taskId: d.taskId ?? null,
				changeId: d.changeId ?? null,
				basedOn: d.basedOn ?? null,
				resume: d.resume,
				model: d.model ?? null,
				cost: d.cost ?? null,
			};
		});
		// 子调度：每个一条泳道，时间条覆盖它从接手到汇报的整段
		const leadBars = [...leads.values()]
			.filter((l) => l.at !== undefined && (l.at >= (list[0]?.at ?? 0) || bars.some((b) => b.lead === l.key)))
			.map((l) => {
				const running = leadRunning(l.key);
				const end = l.endAt ?? (running ? now : l.at!);
				const laneId = `lead:${l.key}`;
				lanes.set(laneId, { id: laneId, agent: "lead", session: l.conversationId ?? null, rounds: 1, first: l.at!, last: end, running, lastTask: l.goal.slice(0, 80), tasks: l.taskId ? [l.taskId] : [], model: l.name });
				return {
					key: l.key,
					lane: laneId,
					agent: "lead",
					lead: undefined as string | undefined,
					start: l.at!,
					end,
					running,
					status: l.status === "open" && !running ? "interrupted" : l.status,
					mode: "lead",
					job: null,
					task: `${l.name}：${l.goal.replace(/\s+/g, " ").trim().slice(0, 120)}`,
					taskId: l.taskId ?? null,
					changeId: null,
					basedOn: null,
					resume: null,
					model: null,
					cost: null,
				};
			});
		// 依赖：基于某次改动开工的派工 ← 产出那次改动的派工
		const byChange = new Map(bars.filter((b) => b.changeId).map((b) => [b.changeId!, b.key]));
		const links: { from: string; to: string; change?: string | null; type: "based_on" | "spawn" }[] = [
			...bars.filter((b) => b.basedOn && byChange.has(b.basedOn)).map((b) => ({ from: byChange.get(b.basedOn!)!, to: b.key, change: b.basedOn, type: "based_on" as const })),
			// 子调度 → 它派的工
			...bars.filter((b) => b.lead && leads.has(b.lead)).map((b) => ({ from: b.lead!, to: b.key, type: "spawn" as const })),
		];
		bars.push(...(leadBars as any[]));
		// 同一时刻最多有几个派工在跑
		const edges = bars.flatMap((b) => [
			{ t: b.start, d: 1 },
			{ t: b.end, d: -1 },
		]);
		edges.sort((a, b) => a.t - b.t || a.d - b.d);
		let current = 0;
		let peak = 0;
		for (const e of edges) peak = Math.max(peak, (current += e.d));
		return {
			now,
			orchestrator: { model: orchestrator.info?.modelId ?? config.orchestrator.modelId, busy: live.busy, turns: live.turns },
			members: [
				...agents.map((a) => ({ kind: a.kind, label: ADAPTERS[a.kind].label, available: a.available })),
				...(leads.size ? [{ kind: "lead", label: "子调度", available: true }] : []),
			],
			lanes: [...lanes.values()].map((l) => ({ ...l, known: l.session ? !!sessions[l.session] : false })),
			bars,
			links,
			stats: { running: bars.filter((b) => b.running).length, peak, async: bars.filter((b) => b.mode === "async").length, total: bars.length },
		};
	}

	async function state() {
		await refreshJobs();
		const usage = (await harness.usage(context)) as any;
		const sessions = ((await harness.snapshot(AgentSessions, context)) as any)?.sessions ?? {};
		const useCount = new Map<string, number>();
		for (const d of allDispatches()) if (d.sessionId) useCount.set(d.sessionId, (useCount.get(d.sessionId) ?? 0) + 1);
		const o = config.orchestrator;
		return {
			demo,
			pid: process.pid,
			startedAt,
			configPath: options.configPath,
			workdir: config.workdir,
			storage: config.storage,
			conversation: { ...(options.session ?? { id: "default", title: "默认会话" }), controllerId: String(root.id) },
			autonomy: { ...config.autonomy, learning: await harness.snapshot(Learning, context) },
			lead: config.lead,
			entries: entryCount,
			jobs: jobList(),
			orchestrator: {
				describe: orchestrator.describe,
				type: orchestrator.info?.type ?? o.type,
				modelId: orchestrator.info?.modelId ?? o.modelId,
				host: orchestrator.info?.host,
				keySource: orchestrator.info?.keySource ?? "",
				maxTurns: o.maxTurns ?? 40,
				price: o.price ?? null,
			},
			stripEnv: config.stripEnv,
			isolation: config.isolation,
			budget: { ...config.budget, ...((await harness.snapshot(RunBudget, context)) as any) },
			modelStats: modelStats(),
			project: {
				goal: project.goal() ?? null,
				goalPath: project.goalPath,
				assignPath: project.assignPath,
				tasks: boardTasks((await harness.snapshot(Board, context)) as BoardState | undefined),
				roles: config.roles,
			},
			changeCounts: changes.list().reduce<Record<string, number>>((m, ch) => ((m[ch.status] = (m[ch.status] ?? 0) + 1), m), {}),
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
					models: c.models,
					defaultModel: c.defaultModel ?? null,
					api: c.api
						? { type: c.api.type, host: hostOf(c.api.baseUrl), keySource: memberKey(c.api).source, bash: c.api.bash, bashAllow: c.api.bashAllow }
						: null,
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
					rounds: s.rounds ?? null,
					createdAt: s.createdAt ?? null,
					lastTask: s.lastTask ?? null,
					model: s.model ?? null,
					change: s.change ?? null,
					resume: RESUME_COMMAND[s.agent as AgentKind]?.(id) ?? null,
				}))
				.sort((a, b) => b.updatedAt - a.updatedAt),
			// 只算总调度（含子调度）自己的模型；API 成员（member-*）的子对话用量已经算在成员花费里，不能再算一遍
			usage: Object.entries<any>(usage?.models ?? {}).filter(([model]) => !model.startsWith("member-")).map(([model, u]) => ({
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
		const raw = dispatches.get(id) ?? dispatches.get(latestByCall.get(id) ?? "");
		const d = raw ? withJob(raw) : undefined;
		if (!d) return undefined;
		let result: string | undefined;
		if (d.resultEntryId !== undefined) {
			const page = await root.entries({ minEntryId: d.resultEntryId as any, maxEntryId: d.resultEntryId as any }, 1, undefined, context);
			const item = page.items[0] ? toViewItem(page.items[0]) : undefined;
			if (item?.type === "tool") result = parseToolResult(item.text, item.isError, item.details).body;
		}
		const job = d.job ? jobs[d.job] : undefined;
		if (job) result = job.result ?? (job.status === "running" ? undefined : result);
		return { ...d, result, output: job?.status === "running" ? app.jobs.recent(job.id) : undefined };
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
	async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 4096) throw new Error("请求内容过长");
			chunks.push(bytes);
		}
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
		return value as Record<string, unknown>;
	}
	const afterResponse = (res: ServerResponse, id: string) => {
		// 先把新编号送回浏览器，再重建当前会话的服务，避免关闭正在响应的连接。
		res.once("finish", () => setImmediate(() => {
			void options.conversations!.select(id).catch((error) => options.notify?.(`切换对话失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { changingConversation = false; });
		}));
	};
	let changingConversation = false;
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
			const requestedConversation = url.searchParams.get("conversation");
			if (requestedConversation && requestedConversation !== (options.session?.id ?? "default")) return sendJson(res, 409, { error: "对话已切换，不能读取另一个对话的数据" });
			if (url.pathname === "/api/conversations" && req.method === "GET") {
				return sendJson(res, 200, { current: options.session?.id ?? "default", conversations: options.conversations ? await options.conversations.list() : [] });
			}
			const conversationAction = url.pathname.match(/^\/api\/conversations\/([a-z0-9_-]+)\/(select|title)$/);
			if ((url.pathname === "/api/conversations" || conversationAction) && req.method === "POST") {
				if (!options.conversations) return sendJson(res, 503, { error: "当前运行入口未启用对话管理" });
				let body: Record<string, unknown>;
				try { body = await readJson(req); } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
				if (body.expectedSession !== (options.session?.id ?? "default")) return sendJson(res, 409, { error: "当前对话已变化，请刷新后重试" });
				if (changingConversation || options.conversations.busy()) return sendJson(res, 409, { error: "正在切换对话，请稍后重试" });
				changingConversation = true;
				try {
					if (conversationAction?.[2] === "title") {
						changingConversation = false;
						if (typeof body.title !== "string") return sendJson(res, 400, { error: "需要对话标题" });
						await options.conversations.rename(conversationAction[1]!, body.title);
						if (options.session && options.session.id === conversationAction[1]) options.session.title = body.title.trim();
						return sendJson(res, 200, { ok: true });
					}
					let id: string;
					if (conversationAction) {
						id = conversationAction[1]!;
						const list = await options.conversations.list() as { id: string }[];
						if (!list.some((item) => item.id === id)) { changingConversation = false; return sendJson(res, 404, { error: "没有这个对话" }); }
					} else {
						if (body.title !== undefined && typeof body.title !== "string") { changingConversation = false; return sendJson(res, 400, { error: "标题需要是文字" }); }
						({ id } = await options.conversations.create((body.title as string | undefined) ?? ""));
					}
					afterResponse(res, id);
					return sendJson(res, 202, { ok: true, id, preserved: true });
				} catch (error) { changingConversation = false; return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
			}
			if (url.pathname === "/api/events" && req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
				const { items, hasMore } = await history(400);
				res.write(`event: snapshot\ndata: ${JSON.stringify({ items, hasMore, live: lastLive, conversation: { id: options.session?.id ?? "default", controllerId: String(root.id), storage: config.storage } })}\n\n`);
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
				const list = allDispatches().sort((a, b) => (b.entryId ?? b.resultEntryId ?? 0) - (a.entryId ?? a.resultEntryId ?? 0));
				return sendJson(res, 200, { dispatches: list });
			}
			const detail = url.pathname.match(/^\/api\/dispatches\/([^/]+)$/);
			if (detail && req.method === "GET") {
				const d = await dispatchDetail(decodeURIComponent(detail[1]!));
				return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: "没有这次派工" });
			}
			// Agent 规范文件：扫描结果（不含内容）；按编号读单个文件（打码）
			if (url.pathname === "/api/conventions" && req.method === "GET") {
				const scan = scanConventions(config.workdir);
				return sendJson(res, 200, { ...scan, files: scan.files.map(({ path: _p, ...f }) => f) });
			}
			if (url.pathname === "/api/conventions/file" && req.method === "GET") {
				const scan = scanConventions(config.workdir);
				const file = readConvention(scan, url.searchParams.get("id") ?? "");
				if (!file) return sendJson(res, 404, { error: "没有这个文件" });
				const { path: _p, ...meta } = file.file;
				return sendJson(res, 200, { file: meta, text: file.text, truncated: file.truncated });
			}
			if (url.pathname === "/api/topology" && req.method === "GET") return sendJson(res, 200, await topology(Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 5), 200)));
			if (url.pathname === "/api/jobs" && req.method === "GET") return sendJson(res, 200, { jobs: jobList() });
			// 取消后台派工（控制操作，和「中止本轮」同级）
			const jobCancel = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
			if (jobCancel && req.method === "POST") {
				const body = await readJson(req);
				if (body.expectedSession !== undefined && body.expectedSession !== (options.session?.id ?? "default")) return sendJson(res, 409, { error: "对话已切换，未执行取消" });
				const id = decodeURIComponent(jobCancel[1]!);
				const r = await app.jobs.cancel(id, "user", context);
				if (r === "cancelled") options.notify?.(`后台网页：已取消后台派工 ${id}`);
				return sendJson(res, r === "not_found" ? 404 : 200, { ok: r === "cancelled", result: r });
			}
			if (url.pathname === "/api/changes" && req.method === "GET") return sendJson(res, 200, { changes: changes.list() });
			const changeDiff = url.pathname.match(/^\/api\/changes\/([^/]+)\/diff$/);
			if (changeDiff && req.method === "GET") {
				const ch = changes.get(decodeURIComponent(changeDiff[1]!));
				if (!ch) return sendJson(res, 404, { error: "没有这个改动" });
				// 已合并的看完整改动，其余看还没合并的部分
				const [from, to] = ch.status === "applied" ? [ch.base, ch.head] : changes.range(ch);
				if (from === to) return sendJson(res, 200, { text: "", truncated: false });
				try {
					return sendJson(res, 200, await diffText(ch.root, from, to));
				} catch (error) {
					return sendJson(res, 200, { text: "", truncated: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
			if (url.pathname === "/api/abort" && req.method === "POST") {
				const body = await readJson(req);
				if (body.expectedSession !== undefined && body.expectedSession !== (options.session?.id ?? "default")) return sendJson(res, 409, { error: "对话已切换，未执行中止" });
				await root.abort(context);
				options.notify?.("后台网页：已中止本轮");
				return sendJson(res, 200, { ok: true });
			}
			if (url.pathname === "/api/reset" && req.method === "POST") {
				const body = await readJson(req);
				if (body.expectedSession !== undefined && body.expectedSession !== (options.session?.id ?? "default")) return sendJson(res, 409, { error: "对话已切换，未执行重置" });
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
			changes.off("change", onChange);
			project.off("change", onProject);
			app.jobs.off("change", onJobs);
			for (const w of childWatches) await w.stop().catch(() => {});
			app.jobs.off("output", onJobOutput);
			for (const res of clients) res.end();
			clients.clear();
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await closed;
			await watch.stop();
		},
	};
}
