// pi-agent 调度台前端：SSE 增量渲染对话时间线、派工单和成员状态。无构建步骤、无依赖。
const $ = (sel) => document.querySelector(sel);
const timeline = $("#timeline");
const stream = $("#stream");
const input = $("#input");

const AGENT_LABEL = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const STATE_LABEL = { pending: "排队", running: "执行中", sleeping: "等待中", waiting: "等待中", done: "完成" };
const FAILURE_LABEL = {
	model_error: "模型出错",
	no_model: "没有可用模型",
	aborted: "已中止",
	faulted: "内部错误",
	interrupted: "进程中断",
	restart_limit: "反复崩溃，已放弃",
	turn_limit: "达到轮数上限",
	nothing_to_answer: "没有需要回答的内容",
	orphaned: "任务定义缺失",
	reset: "上下文已重置",
};

const tickets = new Map(); // callId -> ticket 视图
const slotStart = new Map(); // callId -> 首次看到运行的时间
let live = { busy: false, turns: 0, partial: "", tools: [] };
let appState = null;
let wasBusy = false;
let ghost = null;

// ---------------- 工具函数 ----------------
function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function el(tag, cls, html) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (html !== undefined) node.innerHTML = html;
	return node;
}
function clock(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function duration(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
function ago(ts) {
	const s = (Date.now() - ts) / 1000;
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
	return `${Math.floor(s / 86400)} 天前`;
}
function kindOf(toolName) {
	return String(toolName).replace(/^ask_/, "");
}
let toastTimer;
function toast(text) {
	const t = $("#toast");
	t.textContent = text;
	t.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
async function copy(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast("已复制");
	} catch {
		toast(text);
	}
}
async function post(path, body = {}) {
	const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
}

// ---------------- 极简 Markdown（先转义，再加格式，不允许任何原始 HTML） ----------------
function inline(text) {
	return esc(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function markdown(src) {
	const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^```\s*([\w-]*)/);
		if (fence) {
			const code = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
			i++;
			out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
			continue;
		}
		const h = line.match(/^(#{1,4})\s+(.*)$/);
		if (h) {
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			i++;
			continue;
		}
		if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
			const ordered = /^\s*\d+[.)]\s+/.test(line);
			const items = [];
			while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))}</li>`);
				i++;
			}
			out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
			continue;
		}
		if (/^>\s?/.test(line)) {
			const quote = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
			out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const para = [];
		while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
		out.push(`<p>${para.map(inline).join("<br>")}</p>`);
	}
	return out.join("");
}

// ---------------- 滚动 ----------------
let followUntil = 0; // 自己刚发送消息后的几秒内，无条件跟随到底部
function nearBottom() {
	return Date.now() < followUntil || stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
}
function stickToBottom(wasNear) {
	if (wasNear) stream.scrollTop = stream.scrollHeight;
}

// ---------------- 派工单 ----------------
function createTicket(call) {
	const kind = kindOf(call.name);
	const node = el("article", "ticket");
	node.dataset.kind = kind;
	const task = String(call.args?.task ?? JSON.stringify(call.args ?? {}));
	const resume = call.args?.session_id ? `<span class="resume">续接 ${esc(String(call.args.session_id).slice(0, 8))}</span>` : "";
	node.innerHTML = `
		<header class="ticket-head">
			<span class="agent-chip">${esc(AGENT_LABEL[kind] ?? call.name)}</span>
			<span class="ticket-no">#${esc(String(call.id).slice(-6))}</span>
			<span class="pill" data-s="pending">排队</span>
		</header>
		<div class="ticket-task">${resume}${esc(task)}</div>
		<div class="log"></div>
		<div class="result" hidden></div>
		<footer class="meta" hidden></footer>`;
	const taskEl = node.querySelector(".ticket-task");
	if (task.length > 220) {
		taskEl.classList.add("clamp");
		taskEl.title = "点击展开";
		taskEl.addEventListener("click", () => taskEl.classList.toggle("clamp"));
	}
	const ticket = {
		node,
		kind,
		pill: node.querySelector(".pill"),
		log: node.querySelector(".log"),
		result: node.querySelector(".result"),
		meta: node.querySelector(".meta"),
		settled: false,
		lastOutput: "",
	};
	tickets.set(call.id, ticket);
	return ticket;
}

function logClass(line) {
	if (/^[▶ℹ]/.test(line)) return "l-start";
	if (/^(🔧|⚙️|📝)/u.test(line)) return "l-tool";
	if (/^❌/u.test(line)) return "l-err";
	return "";
}

function renderLog(ticket, output) {
	if (!output || output === ticket.lastOutput) return;
	ticket.lastOutput = output;
	const stick = ticket.log.scrollHeight - ticket.log.scrollTop - ticket.log.clientHeight < 30;
	ticket.log.replaceChildren(
		...output
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const d = el("div", logClass(l));
				d.textContent = l;
				return d;
			}),
	);
	if (stick) ticket.log.scrollTop = ticket.log.scrollHeight;
}

/** 工具结果末尾的元信息行：[agent: x | session_id: y | 耗时: 12s | 花费: $0.01] */
function splitFooter(text) {
	const m = text.match(/\n*\[(agent: [^\]]+)\]\s*$/);
	if (!m) return { body: text, meta: {} };
	const meta = {};
	for (const part of m[1].split("|")) {
		const [k, ...v] = part.split(":");
		meta[k.trim()] = v.join(":").trim();
	}
	return { body: text.slice(0, m.index), meta };
}

/**
 * Pi Durable 自己写的结果（中止、中断、被拦截等）格式是：已有输出 + <harness>[error] …</harness>。
 * 已有输出在日志里看过了，这里只保留 harness 的说明。
 */
function harnessNote(text) {
	const m = text.match(/<harness>([\s\S]*?)<\/harness>\s*$/);
	if (!m) return undefined;
	const lines = m[1]
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => l.replace(/^\[(error|info|warning)\]\s*/, ""));
	const aborted = lines.some((l) => /was aborted|aborted/i.test(l));
	const interrupted = lines.some((l) => /interrupted/i.test(l));
	return { aborted, interrupted, lines };
}

function settleTicket(ticket, item) {
	ticket.settled = true;
	ticket.node.classList.add("settled");
	const note = harnessNote(item.text);
	let { body, meta } = splitFooter(item.text);
	const details = item.details ?? {};
	let label = item.isError ? "失败" : "完成";
	ticket.pill.dataset.s = item.isError ? "error" : "done";
	if (note?.aborted) {
		label = "已中止";
		ticket.pill.dataset.s = "aborted";
		body = "这项任务被中止了，CLI 进程已结束。";
	} else if (note?.interrupted) {
		label = "被中断";
		body = `进程重启时这项任务被中断了。\n\n${note.lines.join("\n")}`;
	} else if (note) {
		body = note.lines.join("\n");
	}
	const took = details.durationMs ? ` · ${duration(details.durationMs)}` : meta["耗时"] ? ` · ${meta["耗时"]}` : "";
	ticket.pill.textContent = `${label}${took}`;

	ticket.result.hidden = false;
	ticket.result.classList.toggle("err", item.isError && !note?.aborted);
	const bodyEl = el("div", "result-body md", markdown(body.trim() || "（没有文字输出）"));
	ticket.result.replaceChildren(bodyEl);
	if (body.length > 900) {
		bodyEl.classList.add("collapsed");
		const more = el("button", "expand", "展开全部 ↓");
		more.type = "button";
		more.addEventListener("click", () => {
			const collapsed = bodyEl.classList.toggle("collapsed");
			more.textContent = collapsed ? "展开全部 ↓" : "收起 ↑";
		});
		ticket.result.append(more);
	}

	const sid = details.sessionId ?? meta["session_id"];
	const parts = [];
	if (sid) parts.push(`会话 <button type="button" data-copy="${esc(sid)}">${esc(String(sid).slice(0, 8))}</button>`);
	if (meta["花费"]) parts.push(`花费 ${esc(meta["花费"])}`);
	if (details.cwd) parts.push(`<span title="${esc(details.cwd)}">${esc(String(details.cwd).split(/[\\/]/).filter(Boolean).pop() ?? details.cwd)}</span>`);
	if (details.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) parts.push(`退出码 ${esc(details.exitCode)}`);
	if (parts.length) {
		ticket.meta.hidden = false;
		ticket.meta.innerHTML = parts.join("");
	}
}

function updateTicketFromSlot(ticket, slot) {
	if (ticket.settled) return;
	if (slot.status === "running" && !slotStart.has(slot.callId)) slotStart.set(slot.callId, Date.now());
	const started = slotStart.get(slot.callId);
	ticket.pill.dataset.s = slot.status === "running" ? "running" : "pending";
	ticket.pill.textContent = `${STATE_LABEL[slot.status] ?? slot.status}${slot.status === "running" && started ? ` ${duration(Date.now() - started)}` : ""}`;
	renderLog(ticket, slot.output);
}

// ---------------- 时间线条目 ----------------
function whoLine(label, at) {
	return `<div class="who"><span>${label}</span>${at ? `<time>${clock(at)}</time>` : ""}</div>`;
}

function renderItem(item) {
	if (item.type === "user") {
		const node = el("div", "item user", `${whoLine("你", item.at)}<div class="bubble"></div>`);
		node.querySelector(".bubble").textContent = item.text;
		return node;
	}
	if (item.type === "divider") return el("div", "item divider", esc(item.label));
	if (item.type === "assistant") {
		if (!item.text.trim() && !item.toolCalls.length && !item.error) return null;
		const node = el("div", "item orch", whoLine("总调度", item.at));
		if (item.text.trim()) node.append(el("div", "md", markdown(item.text)));
		if (item.error) node.append(el("div", "error", esc(item.error)));
		if (item.toolCalls.length) {
			const wrap = el("div", `tickets${item.toolCalls.length > 1 ? " multi" : ""}`);
			for (const call of item.toolCalls) wrap.append(createTicket(call).node);
			node.append(wrap);
		}
		return node;
	}
	if (item.type === "tool") {
		const ticket = tickets.get(item.callId);
		if (ticket) {
			settleTicket(ticket, item);
			return null;
		}
		// 对应的派工单不在当前窗口里：单独显示结果
		const node = el("div", "item orch", whoLine("成员结果", item.at));
		const t = createTicket({ id: item.callId, name: item.name, args: { task: "（较早的任务）" } });
		settleTicket(t, item);
		node.append(t.node);
		return node;
	}
	return null;
}

function appendItems(items, { animate = true } = {}) {
	const stick = nearBottom();
	for (const item of items) {
		const node = renderItem(item);
		if (!node) continue;
		if (!animate) node.classList.add("still"); // 历史记录不播放进场动画
		timeline.append(node);
	}
	if (ghost) timeline.append(ghost); // 流式草稿始终在最后
	$("#welcome").hidden = timeline.children.length > 0;
	stickToBottom(stick);
}

// ---------------- 实时状态 ----------------
function renderLive() {
	const stick = nearBottom();
	// 总调度正在输出的草稿
	if (live.busy && live.partial.trim()) {
		if (!ghost) {
			ghost = el("div", "item orch ghost", `${whoLine("总调度")}<div class="md typing"></div>`);
			timeline.append(ghost);
		}
		ghost.querySelector(".md").innerHTML = markdown(live.partial);
	} else if (ghost) {
		ghost.remove();
		ghost = null;
	}
	// 派工单
	for (const slot of live.tools) {
		const ticket = tickets.get(slot.callId);
		if (ticket) updateTicketFromSlot(ticket, slot);
	}
	// 顶栏状态
	const status = $("#status");
	const running = live.tools.filter((t) => t.status === "running");
	if (live.busy) {
		status.dataset.state = "busy";
		const parts = [`调度中 · 第 ${live.turns + 1} 轮`];
		if (running.length) parts.push(`${running.length} 名成员执行中`);
		if (live.retry) parts.push("模型重试中");
		$("#statusText").textContent = parts.join(" · ");
	} else if (live.runFailure?.reason === "aborted") {
		status.dataset.state = "idle";
		$("#statusText").textContent = "待命 · 上一轮已中止";
	} else if (live.runFailure) {
		status.dataset.state = "failed";
		$("#statusText").textContent = `上一轮未完成：${FAILURE_LABEL[live.runFailure.reason] ?? live.runFailure.reason}`;
	} else {
		status.dataset.state = "idle";
		$("#statusText").textContent = "待命";
	}
	renderFailureBanner();
	$("#stopBtn").hidden = !live.busy;
	$("#hint").classList.toggle("show", live.busy);
	renderRoster();
	if (wasBusy && !live.busy) refreshState();
	wasBusy = live.busy;
	stickToBottom(stick);
}

let failureBanner = null;
function renderFailureBanner() {
	const failure = !live.busy && live.runFailure && live.runFailure.reason !== "aborted" ? live.runFailure : null;
	if (!failure) {
		failureBanner?.remove();
		failureBanner = null;
		return;
	}
	if (!failureBanner) failureBanner = el("div", "item banner");
	failureBanner.innerHTML = `<strong>${esc(FAILURE_LABEL[failure.reason] ?? failure.reason)}</strong> ${esc(failure.detail ?? "")}`;
	timeline.append(failureBanner);
}

// 每秒刷新运行中派工单的计时
setInterval(() => {
	if (!live.busy) return;
	for (const slot of live.tools) {
		const ticket = tickets.get(slot.callId);
		if (ticket && slot.status === "running") updateTicketFromSlot(ticket, slot);
	}
}, 1000);

// ---------------- 侧栏 ----------------
function renderRoster() {
	if (!appState) return;
	const busyKinds = new Set(live.tools.filter((t) => t.status === "running").map((t) => kindOf(t.name)));
	const roster = $("#roster");
	roster.replaceChildren(
		...appState.agents.map((a) => {
			const state = !a.available ? "off" : busyKinds.has(a.kind) ? "busy" : "idle";
			const li = el("li", "member");
			li.dataset.kind = a.kind;
			li.dataset.state = state;
			li.innerHTML = `
				<span class="lamp"></span>
				<span class="member-name">${esc(AGENT_LABEL[a.kind] ?? a.kind)}</span>
				<span class="member-state">${state === "busy" ? "执行中" : state === "off" ? "不可用" : "待命"}</span>
				<span class="member-desc">${esc(a.available ? a.description : a.reason)}</span>`;
			return li;
		}),
	);
}

function renderSidebar() {
	if (!appState) return;
	$("#orchestrator").textContent = appState.orchestrator;
	$("#workdir").textContent = appState.workdir;
	$("#workdir").title = appState.storage;
	$("#demoBadge").hidden = !appState.demo;
	renderRoster();

	const sessions = $("#sessions");
	if (!appState.sessions.length) sessions.innerHTML = '<li class="empty">还没有会话</li>';
	else
		sessions.replaceChildren(
			...appState.sessions.map((s) => {
				const li = el("li");
				const b = el("button", "session");
				b.type = "button";
				b.style.setProperty("--c", `var(--${s.agent})`);
				b.title = `${s.id}\n${s.cwd}`;
				b.innerHTML = `<span class="dot"></span><span class="sid">${esc(AGENT_LABEL[s.agent] ?? s.agent)} · ${esc(s.id.slice(0, 8))}</span><span class="when">${esc(ago(s.updatedAt))}</span><span class="where">${esc(s.cwd)}</span>`;
				b.addEventListener("click", () => copy(s.id));
				li.append(b);
				return li;
			}),
		);

	const usage = $("#usage");
	if (!appState.usage.length) usage.innerHTML = '<span class="empty">暂无</span>';
	else
		usage.innerHTML = appState.usage
			.map(
				(u) =>
					`<div class="usage-row"><strong>${esc(u.model)}</strong><span>输入 ${u.input.toLocaleString()} · 输出 ${u.output.toLocaleString()} · 缓存 ${u.cacheRead.toLocaleString()}</span>${u.cost ? `<span>$${u.cost.toFixed(4)}</span>` : ""}</div>`,
			)
			.join("");
}

async function refreshState() {
	try {
		appState = await (await fetch("/api/state")).json();
		renderSidebar();
	} catch {
		/* 断线时由 SSE 状态提示 */
	}
}

// ---------------- SSE ----------------
function connect() {
	const conn = $("#conn");
	const es = new EventSource("/api/events");
	es.addEventListener("open", () => {
		conn.dataset.state = "open";
		conn.textContent = "已连接";
	});
	es.addEventListener("error", () => {
		conn.dataset.state = "lost";
		conn.textContent = "连接断开，重连中";
	});
	es.addEventListener("snapshot", (e) => {
		const { items, live: l } = JSON.parse(e.data);
		timeline.replaceChildren();
		tickets.clear();
		ghost = null;
		failureBanner = null;
		appendItems(items, { animate: false });
		live = l;
		renderLive();
		requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight, behavior: "instant" }));
	});
	es.addEventListener("items", (e) => appendItems(JSON.parse(e.data)));
	es.addEventListener("live", (e) => {
		live = JSON.parse(e.data);
		renderLive();
	});
}

// ---------------- 输入 ----------------
function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
	input.style.overflowY = input.scrollHeight > 220 ? "auto" : "hidden";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		$("#composer").requestSubmit();
	}
});
$("#composer").addEventListener("submit", async (e) => {
	e.preventDefault();
	const text = input.value.trim();
	if (!text) return;
	const btn = $("#sendBtn");
	btn.disabled = true;
	try {
		followUntil = Date.now() + 3000;
		await post("/api/message", { text });
		input.value = "";
		autosize();
		stream.scrollTop = stream.scrollHeight;
	} catch (err) {
		toast(`发送失败：${err.message}`);
	} finally {
		btn.disabled = false;
		input.focus();
	}
});
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
$("#examples").addEventListener("click", (e) => {
	if (e.target instanceof HTMLButtonElement) {
		input.value = e.target.textContent;
		autosize();
		input.focus();
	}
});
document.addEventListener("click", (e) => {
	const target = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
	if (target) copy(target.getAttribute("data-copy"));
});

// ---------------- 主题与侧栏 ----------------
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
$("#railToggle").addEventListener("click", (e) => {
	e.stopPropagation();
	$("#rail").classList.toggle("open");
});
document.querySelector(".main").addEventListener("click", () => $("#rail").classList.remove("open"));

// ---------------- 启动 ----------------
refreshState();
setInterval(refreshState, 30_000);
connect();
input.focus();
