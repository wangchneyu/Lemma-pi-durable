// 后台入口：路由、顶栏状态、导航计数、主题，以及把数据变化分发给当前页面。
import { closeDrawer } from "./drawer.js";
import { buildRuns, connect, pendingChanges, store, subscribe } from "./store.js";
import { noteSlots } from "./ticket.js";
import { $, $$, FAILURE_LABEL, copy, post, toast } from "./util.js";
import { VIEWS } from "./views.js";

const content = $("#content");
let view = null;
let viewName = "";

// ---------- 路由：#/页面/参数 ----------
function route() {
	const [name, ...params] = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
	const target = VIEWS[name] ? name : "overview";
	const key = `${target}/${params.join("/")}`;
	if (key === viewName) return;
	view?.unmount?.();
	viewName = key;
	view = VIEWS[target]();
	closeDrawer();
	$("#pageTitle").textContent = view.title;
	$("#pageSub").textContent = view.sub;
	document.title = `${view.title} · pi-agent 后台`;
	for (const a of $$("#nav a")) a.classList.toggle("active", a.dataset.view === target);
	content.replaceChildren();
	content.scrollTop = 0;
	view.mount(content, params);
}
addEventListener("hashchange", route);

// ---------- 顶栏 / 导航 ----------
function renderChrome() {
	const { live, state } = store;
	const status = $("#status");
	const running = live.tools.filter((t) => t.status === "running").length;
	const inbox = live.inbox ?? [];
	const steers = inbox.filter((i) => i.mode === "steer").length;
	const queued = inbox.length - steers;
	const waiting = `${steers ? ` · 插话 ${steers}` : ""}${queued ? ` · 排队 ${queued}` : ""}`;
	if (live.busy) {
		status.dataset.state = "busy";
		$("#statusText").textContent = `调度中 · 第 ${live.turns + 1} 轮${running ? ` · ${running} 名成员执行中` : ""}${live.retry ? " · 模型重试中" : ""}${waiting}`;
	} else if (live.runFailure && live.runFailure.reason !== "aborted") {
		status.dataset.state = "failed";
		$("#statusText").textContent = `上一轮未完成：${FAILURE_LABEL[live.runFailure.reason] ?? live.runFailure.reason}`;
	} else {
		status.dataset.state = "idle";
		$("#statusText").textContent = live.runFailure ? "待命 · 上一轮已中止" : "待命";
	}
	$("#stopBtn").hidden = !live.busy;
	if (state) $("#demoBadge").hidden = !state.demo;
	const counts = {
		runs: buildRuns().filter((r) => !r.divider).length + (store.hasMore ? "+" : ""),
		dispatches: store.dispatches.length || "",
		changes: pendingChanges().length || "",
		sessions: state?.sessions.length || "",
	};
	for (const [k, v] of Object.entries(counts)) $(`[data-count="${k}"]`).textContent = v ? String(v) : "";
}

subscribe((kind, payload) => {
	if (kind === "conn") {
		const conn = $("#conn");
		conn.dataset.state = store.connected ? "open" : "lost";
		conn.textContent = store.connected ? "已连接终端" : "与终端断开，重连中";
		return;
	}
	if (kind === "live" || kind === "snapshot") noteSlots(store.live.tools);
	renderChrome();
	if (kind === "snapshot") {
		// 重新连上终端（比如终端重启了）：整页重建
		viewName = "";
		route();
		return;
	}
	view?.update(kind, payload);
});

// 每秒刷新计时（执行中的派工、运行时长）
setInterval(() => {
	if (store.live.busy) view?.update("tick");
}, 1000);

// ---------- 控制 ----------
$("#stopBtn").addEventListener("click", async () => {
	try {
		await post("/api/abort");
		toast("已中止本轮");
	} catch (err) {
		toast(`中止失败：${err.message}`);
	}
});
$("#resetBtn").addEventListener("click", async () => {
	if (!confirm("开始新的上下文？总调度将不再看到之前的对话（历史仍保存在存储里）。")) return;
	try {
		await post("/api/reset");
		toast("已开始新的上下文");
	} catch (err) {
		toast(`操作失败：${err.message}`);
	}
});
document.addEventListener("click", (e) => {
	const target = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
	if (target) {
		e.preventDefault();
		copy(target.getAttribute("data-copy"));
	}
});

// ---------- 主题 ----------
function applyTheme(theme) {
	if (theme) document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
}
try {
	applyTheme(localStorage.getItem("pi-agent-theme"));
} catch {
	/* 无存储权限时跟随系统 */
}
$("#themeToggle").addEventListener("click", () => {
	const current = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
	const next = current === "light" ? "dark" : "light";
	applyTheme(next);
	try {
		localStorage.setItem("pi-agent-theme", next);
	} catch {
		/* 忽略 */
	}
});

route();
connect();
