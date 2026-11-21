// 数据层：SSE 实时同步对话条目和 pi.live，按需拉取状态、派工汇总和更早的历史。
import { getJson, kindOf } from "./util.js";

export const store = {
	items: [], // 按 id 升序
	hasMore: false,
	live: { busy: false, turns: 0, partial: "", tools: [] },
	state: null,
	dispatches: [],
	changes: [],
	connected: false,
	loaded: false,
};

const listeners = new Set();
export function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
function emit(kind, payload) {
	for (const fn of listeners) fn(kind, payload);
}

// callId -> 任务文字 / 成员，来自总调度消息里的工具调用
const calls = new Map();
export function callInfo(callId) {
	return calls.get(callId);
}
function indexCalls(items) {
	for (const item of items) {
		if (item.type !== "assistant") continue;
		for (const call of item.toolCalls) {
			calls.set(call.id, { task: String(call.args?.task ?? JSON.stringify(call.args ?? {})), agent: kindOf(call.name), resume: call.args?.session_id });
		}
	}
}

function mergeItems(items, { prepend = false } = {}) {
	const known = new Set(store.items.map((i) => i.id));
	const fresh = items.filter((i) => !known.has(i.id));
	indexCalls(fresh);
	store.items = prepend ? [...fresh, ...store.items] : [...store.items, ...fresh];
	store.items.sort((a, b) => a.id - b.id);
	return fresh;
}

// ---------- 状态 / 派工汇总（合并频繁的刷新请求） ----------
let stateTimer;
let dispatchTimer;
export function refreshState(delay = 0) {
	clearTimeout(stateTimer);
	stateTimer = setTimeout(async () => {
		try {
			store.state = await getJson("/api/state");
			emit("state");
		} catch {
			/* 断线时由连接状态提示 */
		}
	}, delay);
}
export function refreshDispatches(delay = 0) {
	clearTimeout(dispatchTimer);
	dispatchTimer = setTimeout(async () => {
		try {
			store.dispatches = (await getJson("/api/dispatches")).dispatches;
			emit("dispatches");
		} catch {
			/* 忽略 */
		}
	}, delay);
}

let changesTimer;
export function refreshChanges(delay = 0) {
	clearTimeout(changesTimer);
	changesTimer = setTimeout(async () => {
		try {
			store.changes = (await getJson("/api/changes")).changes;
			emit("changes");
		} catch {
			/* 忽略 */
		}
	}, delay);
}
export function pendingChanges() {
	return store.changes.filter((c) => c.status === "pending" || c.status === "conflict");
}

export async function loadEarlier() {
	const first = store.items[0];
	if (!first || !store.hasMore) return 0;
	const page = await getJson(`/api/history?before=${first.id}&limit=400`);
	const fresh = mergeItems(page.items, { prepend: true });
	store.hasMore = page.hasMore;
	emit("history");
	return fresh.length;
}

/** 派工汇总 + 实时状态：执行中的那些以 live 为准（按时间倒序） */
export function dispatchRows() {
	const slots = new Map(store.live.tools.map((t) => [t.callId, t]));
	const used = new Set();
	const rows = store.dispatches.map((d) => {
		// 同一个 callId 只把实时状态套到最近的那一次上
		const slot = !used.has(d.callId) && d.status === "open" ? slots.get(d.callId) : undefined;
		used.add(d.callId);
		const status = slot && slot.status !== "done" ? (slot.status === "running" ? "running" : "open") : d.status;
		return { ...d, status, slot };
	});
	// 刚派出、汇总还没刷新到的
	for (const slot of store.live.tools) {
		if (!isDispatch(slot.name) || slot.status === "done" || rows.some((r) => r.slot === slot)) continue;
		const info = callInfo(slot.callId);
		rows.unshift({ callId: slot.callId, agent: kindOf(slot.name), task: info?.task ?? "", status: slot.status === "running" ? "running" : "open", slot });
	}
	return rows;
}

/** 派给成员的工具（ask_*）才算派工；plan_tasks / update_task / set_goal 是总调度维护分工表的操作 */
export const isDispatch = (name) => String(name ?? "").startsWith("ask_");

// ---------- 运行记录：按"你的一次输入"分组 ----------
export function buildRuns() {
	const runs = [];
	let current = null;
	let prev = null;
	for (const item of store.items) {
		if (item.type === "divider") {
			runs.push({ id: `d${item.id}`, divider: true, label: item.label, at: undefined });
			current = null;
			prev = item;
			continue;
		}
		// 插话（steer）只会放在一轮工具结果之后：紧跟在成员结果后面的用户消息属于当前这次运行
		const steer = item.type === "user" && current && prev?.type === "tool";
		if (steer) item.steer = true;
		prev = item;
		if ((item.type === "user" && !steer) || !current) {
			current = { id: String(item.id), user: item.type === "user" ? item : null, items: [], at: item.at };
			runs.push(current);
		}
		current.items.push(item);
	}
	const real = runs.filter((r) => !r.divider);
	const last = real.at(-1);
	for (const run of real) {
		const assistants = run.items.filter((i) => i.type === "assistant");
		const lastAssistant = assistants.at(-1);
		run.agents = [...new Set(assistants.flatMap((a) => a.toolCalls.filter((c) => isDispatch(c.name)).map((c) => kindOf(c.name))))];
		run.dispatchCount = assistants.reduce((n, a) => n + a.toolCalls.filter((c) => isDispatch(c.name)).length, 0);
		const times = run.items.map((i) => i.at).filter(Boolean);
		run.endAt = times.length ? Math.max(...times) : undefined;
		run.answer = lastAssistant && !lastAssistant.toolCalls.length ? lastAssistant.text : "";
		if (run === last && store.live.busy) run.status = "running";
		else if (lastAssistant?.stopReason === "aborted") run.status = "aborted";
		else if (lastAssistant?.error) run.status = "error";
		else if (run.answer)
			// 总调度给了最终汇报，但中间有成员失败：标成"有失败"，别让失败藏在"完成"里
			run.status = run.items.some((i) => i.type === "tool" && i.isError) ? "partial" : "done";
		else if (run === last && store.live.runFailure) run.status = store.live.runFailure.reason === "aborted" ? "aborted" : "error";
		else if (run.items.some((i) => i.type === "tool" && /<harness>[\s\S]*aborted/i.test(i.text))) run.status = "aborted";
		else run.status = "open";
	}
	return runs;
}

// ---------- SSE ----------
export function connect() {
	const es = new EventSource("/api/events");
	es.addEventListener("open", () => {
		store.connected = true;
		emit("conn");
	});
	es.addEventListener("error", () => {
		store.connected = false;
		emit("conn");
	});
	es.addEventListener("snapshot", (e) => {
		const { items, hasMore, live } = JSON.parse(e.data);
		store.items = [];
		calls.clear();
		mergeItems(items);
		store.hasMore = hasMore;
		store.live = live;
		store.loaded = true;
		refreshState();
		refreshDispatches();
		refreshChanges();
		emit("snapshot");
	});
	// 目标或分工表变了
	es.addEventListener("project", () => refreshState(100));
	// 改动记录变了：派工收尾、终端里 /apply /drop /clean
	es.addEventListener("change", () => {
		refreshChanges(150);
		refreshState(400);
	});
	es.addEventListener("items", (e) => {
		const fresh = mergeItems(JSON.parse(e.data));
		if (!fresh.length) return;
		if (fresh.some((i) => i.type === "tool" || (i.type === "assistant" && i.toolCalls.length))) refreshDispatches(250);
		if (fresh.some((i) => i.type === "tool" || i.type === "divider")) refreshState(400);
		emit("items", fresh);
	});
	es.addEventListener("live", (e) => {
		const wasBusy = store.live.busy;
		store.live = JSON.parse(e.data);
		if (wasBusy && !store.live.busy) {
			refreshState(300);
			refreshDispatches(300);
		}
		emit("live");
	});
}

// 定时刷新（会话"多久以前"、进程运行时长等）
setInterval(() => refreshState(), 30_000);
