// 对话管理：侧栏顶部是「当前对话」卡片；点它（或 Ctrl+K）打开对话切换面板。
// 面板能按名称、你说过的话、任务标题搜索，按最近活动分组；没起名字的对话用第一句输入当标题。
import { refreshState, subscribe } from "./store.js";
import { $, ago, esc, getJson, post, toast } from "./util.js";

let conversations = [];
let active = "";
let loading = false;
let changing = false;
let mode = "create";
let target = "";
let filter = "all";
let cursor = 0;
let showEmpty = false;
let refreshTimer;
const dialog = $("#conversationDialog");
const picker = $("#convPicker");
const list = $("#convList");

const clip = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 显示用的标题：起过名字用名字，否则用第一句输入 */
function titleOf(c) {
	if (c.named) return c.title;
	if (c.digest?.first) return clip(c.digest.first, 48);
	return c.id === "default" ? "默认对话" : "空对话";
}

const stateOf = (c) => (c.busy ? "busy" : c.runningJobs ? "jobs" : "idle");
const STATE_TEXT = { busy: "总调度运行中", jobs: "后台派工中", idle: "" };

function metaOf(c) {
	const d = c.digest ?? {};
	return [d.inputs ? `${d.inputs} 次输入` : "还没有输入", d.lastAt ? ago(d.lastAt) : c.createdAt ? `建于 ${ago(c.createdAt)}` : ""].filter(Boolean).join(" · ");
}

/** 搜索：标题、编号、所有输入、任务标题；命中内容时给一段上下文 */
function match(c, q) {
	if (!q) return { ok: true };
	const hay = `${titleOf(c)} ${c.title} ${c.id}`.toLowerCase();
	if (hay.includes(q)) return { ok: true };
	const text = c.digest?.text ?? "";
	const i = text.toLowerCase().indexOf(q);
	if (i < 0) return { ok: false };
	return { ok: true, snippet: `${i > 30 ? "…" : ""}${text.slice(Math.max(0, i - 30), i + q.length + 50)}${i + q.length + 50 < text.length ? "…" : ""}` };
}

function mark(text, q) {
	const safe = esc(text);
	if (!q) return safe;
	const i = text.toLowerCase().indexOf(q);
	if (i < 0) return safe;
	return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

function groupOf(c) {
	const at = c.digest?.lastAt ?? c.createdAt ?? 0;
	if (!c.digest?.inputs && c.id !== active) return "empty";
	const day = 24 * 3600e3;
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	if (at >= start.getTime()) return "today";
	if (at >= start.getTime() - day) return "yesterday";
	if (at >= start.getTime() - 6 * day) return "week";
	return "older";
}
const GROUP_TEXT = { today: "今天", yesterday: "昨天", week: "最近 7 天", older: "更早", empty: "空对话" };

// ---------- 侧栏卡片 ----------
function renderCurrent() {
	const c = conversations.find((x) => x.id === active);
	$("#convTitle").textContent = c ? titleOf(c) : "加载中…";
	$("#convTitle").title = c ? `${c.title}（${c.id}）` : "";
	$("#convMeta").textContent = c ? [STATE_TEXT[stateOf(c)], metaOf(c)].filter(Boolean).join(" · ") : "";
	$("#convDot").dataset.state = c ? stateOf(c) : "idle";
	const others = conversations.filter((x) => x.digest?.inputs || x.id === active).length;
	$("#convCount").textContent = conversations.length ? String(others) : "";
	for (const id of ["#sideNewConversationBtn", "#convSwitch", "#convAllBtn"]) $(id).disabled = changing || !active;
}

// ---------- 切换面板 ----------
let visible = [];
function renderList() {
	const q = $("#convQuery").value.trim().toLowerCase();
	const rows = conversations
		.map((c) => ({ c, m: match(c, q) }))
		.filter(({ c, m }) => m.ok && (filter === "all" || (filter === "active" && c.digest?.inputs) || (filter === "running" && (c.busy || c.runningJobs)) || (filter === "pending" && c.digest?.pending)))
		.sort((a, b) => (b.c.digest?.lastAt ?? b.c.createdAt ?? 0) - (a.c.digest?.lastAt ?? a.c.createdAt ?? 0));
	const groups = new Map();
	for (const r of rows) {
		const g = q ? "result" : groupOf(r.c);
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(r);
	}
	visible = [];
	const order = q ? ["result"] : ["today", "yesterday", "week", "older", "empty"];
	let html = "";
	for (const g of order) {
		const items = groups.get(g);
		if (!items?.length) continue;
		const collapsed = g === "empty" && !showEmpty;
		html += `<div class="picker-group"><span>${g === "result" ? `找到 ${items.length} 个对话` : GROUP_TEXT[g]}</span>${g === "empty" ? `<button type="button" class="picker-toggle" data-toggle-empty>${collapsed ? `显示 ${items.length} 个` : "收起"}</button>` : ""}</div>`;
		if (collapsed) continue;
		for (const { c, m } of items) {
			const i = visible.length;
			visible.push(c);
			const d = c.digest ?? {};
			const state = stateOf(c);
			const sub = m.snippet ? mark(m.snippet, q) : d.last && d.last !== d.first ? `最近：${mark(clip(d.last, 90), q)}` : c.named && d.first ? mark(clip(d.first, 90), q) : "";
			const chips = [
				c.id === active ? `<i class="chip cur">当前</i>` : "",
				state !== "idle" ? `<i class="chip run">${STATE_TEXT[state]}${c.runningJobs ? ` ${c.runningJobs}` : ""}</i>` : "",
				d.tasks?.total ? `<i class="chip">任务 ${d.tasks.done}/${d.tasks.total}</i>` : "",
				d.pending ? `<i class="chip warn">待合并 ${d.pending}</i>` : "",
			].join("");
			html += `<div class="picker-row${i === cursor ? " sel" : ""}${c.id === active ? " cur" : ""}" role="option" aria-selected="${i === cursor}" data-i="${i}">
				<span class="conv-dot" data-state="${state}"></span>
				<span class="row-main">
					<strong>${mark(titleOf(c), q)}</strong>
					${sub ? `<small>${sub}</small>` : ""}
				</span>
				<span class="row-side"><span class="row-chips">${chips}</span><time>${esc(metaOf(c))}</time></span>
				<button type="button" class="row-rename" data-rename="${esc(c.id)}" title="重命名" aria-label="重命名">✎</button>
			</div>`;
		}
	}
	list.innerHTML = html || `<p class="picker-empty">${q ? `没有对话提到「${esc(q)}」` : "这个筛选下没有对话"}</p>`;
	list.querySelector(".picker-row.sel")?.scrollIntoView({ block: "nearest" });
}

function openPicker() {
	if (changing || !active) return;
	cursor = 0;
	$("#convQuery").value = "";
	renderList();
	picker.showModal();
	$("#convQuery").focus();
	void refresh();
}

function choose(c) {
	if (!c || changing) return;
	if (c.id === active) return picker.close();
	void change(`/api/conversations/${encodeURIComponent(c.id)}/select`, {}, active).catch((error) => toast(error.message));
}

function render() {
	renderCurrent();
	if (picker.open) renderList();
}

async function refresh() {
	if (loading || changing) return;
	loading = true;
	try {
		const data = await getJson("/api/conversations");
		conversations = data.conversations;
		active = data.current;
		render();
	} catch {
		/* 终端切换期间等 SSE 重连，不清除已有列表 */
	} finally {
		loading = false;
	}
}
function scheduleRefresh() {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(refresh, 150);
}

// ---------- 新建 / 重命名 ----------
function openDialog(modeName, id = active) {
	if (changing || !active) return;
	mode = modeName;
	target = id;
	const rename = mode === "rename";
	const c = conversations.find((x) => x.id === id);
	$("#conversationDialogTitle").textContent = rename ? "重命名对话" : "新建对话";
	$("#conversationDialogHint").textContent = rename
		? "只改名称，对话记录和后台数据都不变。起个能认出来的名字，以后在对话列表里一眼就能找到。"
		: "新对话从空白上下文开始。当前对话的记录、任务、派工和改动都保留，正在跑的任务也会继续。";
	$("#conversationTitle").value = rename ? (c?.named ? c.title : c?.digest?.first ? clip(c.digest.first, 40) : "") : "";
	$("#saveConversationBtn").textContent = rename ? "保存名称" : "创建并切换";
	$("#saveConversationBtn").disabled = false;
	$("#conversationError").hidden = true;
	if (picker.open) picker.close();
	dialog.showModal();
	$("#conversationTitle").focus();
	$("#conversationTitle").select();
}

async function awaitSelection(id) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch("/api/state", { cache: "no-store" });
			if (response.ok && (await response.json()).conversation?.id === id) {
				location.reload();
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("切换没有完成。新旧对话都还在，请刷新后再试。");
}

async function change(path, body, expected) {
	changing = true;
	render();
	$("#conversationSwitching").hidden = false;
	try {
		const result = await post(path, { ...body, expectedSession: expected });
		if (dialog.open) dialog.close();
		if (picker.open) picker.close();
		await awaitSelection(result.id);
	} catch (error) {
		changing = false;
		$("#conversationSwitching").hidden = true;
		render();
		throw error;
	}
}

// ---------- 事件 ----------
$("#convSwitch").addEventListener("click", openPicker);
$("#convAllBtn").addEventListener("click", openPicker);
$("#sideNewConversationBtn").addEventListener("click", () => openDialog("create"));
$("#pickerNewBtn").addEventListener("click", () => openDialog("create"));
$("#convClose").addEventListener("click", () => picker.close());
$("#cancelConversationBtn").addEventListener("click", () => dialog.close());
picker.addEventListener("click", (e) => {
	if (e.target === picker) picker.close(); // 点遮罩关闭
});
$("#convQuery").addEventListener("input", () => {
	cursor = 0;
	renderList();
});
$("#convFilters").addEventListener("click", (e) => {
	const b = e.target.closest("[data-f]");
	if (!b) return;
	filter = b.dataset.f;
	for (const x of $("#convFilters").querySelectorAll("button")) x.classList.toggle("on", x === b);
	cursor = 0;
	renderList();
});
list.addEventListener("click", (e) => {
	const t = e.target;
	if (t.closest("[data-toggle-empty]")) {
		showEmpty = !showEmpty;
		return renderList();
	}
	const rename = t.closest("[data-rename]");
	if (rename) return openDialog("rename", rename.dataset.rename);
	const row = t.closest("[data-i]");
	if (row) choose(visible[Number(row.dataset.i)]);
});
list.addEventListener("mousemove", (e) => {
	const row = e.target.closest("[data-i]");
	if (!row || Number(row.dataset.i) === cursor) return;
	cursor = Number(row.dataset.i);
	for (const r of list.querySelectorAll(".picker-row")) r.classList.toggle("sel", Number(r.dataset.i) === cursor);
});
picker.addEventListener("keydown", (e) => {
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		if (!visible.length) return;
		cursor = (cursor + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
		renderList();
	} else if (e.key === "Enter" && e.target.id === "convQuery") {
		e.preventDefault();
		choose(visible[cursor]);
	}
});
document.addEventListener("keydown", (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		if (picker.open) picker.close();
		else openPicker();
	}
});
$("#conversationForm").addEventListener("submit", async (event) => {
	event.preventDefault();
	if (changing) return;
	$("#saveConversationBtn").disabled = true;
	try {
		const title = $("#conversationTitle").value.trim();
		if (mode === "rename") {
			if (!title) throw new Error("名称不能为空");
			await post(`/api/conversations/${encodeURIComponent(target)}/title`, { title, expectedSession: active });
			dialog.close();
			await refresh();
			refreshState();
			toast("名称已保存");
		} else await change("/api/conversations", { title }, active);
	} catch (error) {
		$("#conversationError").textContent = error.message;
		$("#conversationError").hidden = false;
		if (!dialog.open) toast(error.message);
	} finally {
		$("#saveConversationBtn").disabled = false;
	}
});
subscribe((kind) => {
	if (kind === "snapshot" || kind === "state" || kind === "jobs") scheduleRefresh();
});
setInterval(() => {
	if (!document.hidden) void refresh();
}, 10_000);
void refresh();
