// 右侧抽屉：一次派工的完整任务、实时输出、结果和元信息。
import { store, subscribe } from "./store.js";
import { renderLogInto, slotStart } from "./ticket.js";
import { $, AGENT_LABEL, STATUS_LABEL, agentColor, duration, esc, getJson, markdown, money, stamp } from "./util.js";

const drawer = $("#drawer");
const body = $("#drawerBody");
let currentId = null;
let detail = null;

function find(id) {
	return store.dispatches.find((d) => d.key === id) ?? store.dispatches.find((d) => d.callId === id);
}

function statusOf(d) {
	const slot = d.status === "open" ? store.live.tools.find((t) => t.callId === d.callId) : undefined;
	if (slot && slot.status !== "done") return { status: slot.status === "running" ? "running" : "open", slot };
	return { status: d.status, slot: undefined };
}

function render() {
	if (!detail) return;
	const d = detail;
	const { status, slot } = statusOf(d);
	const started = slot ? slotStart.get(d.callId) : undefined;
	drawer.style.setProperty("--c", agentColor(d.agent));
	$("#drawerTitle").innerHTML = `<span class="agent-chip">${esc(AGENT_LABEL[d.agent] ?? d.agent)}</span><span class="ticket-no">#${esc(d.callId.slice(-6))}</span><span class="pill" data-s="${status === "running" ? "running" : status === "done" ? "done" : status === "error" ? "error" : "aborted"}">${esc(STATUS_LABEL[status] ?? status)}${status === "running" && started ? ` ${duration(Date.now() - started)}` : ""}</span>`;
	const rows = [
		["派工时间", stamp(d.at)],
		["结束时间", d.endAt ? stamp(d.endAt) : "—"],
		["耗时", duration(d.durationMs)],
		["花费", money(d.cost)],
		["会话", d.sessionId ? `<button type="button" class="linkish" data-copy="${esc(d.sessionId)}">${esc(d.sessionId)}</button>` : "—"],
		["续接自", d.resume ? esc(d.resume) : "—"],
		["目录", d.cwd ? `<code>${esc(d.cwd)}</code>` : "—"],
		["退出码", d.exitCode ?? "—"],
	];
	body.innerHTML = `
		<section><h3 class="eyebrow">任务</h3><div class="drawer-task"></div></section>
		${slot ? `<section><h3 class="eyebrow">实时输出</h3><div class="log tall"></div></section>` : ""}
		<section><h3 class="eyebrow">结果</h3><div class="drawer-result md">${d.result !== undefined ? markdown(d.result || "（没有文字输出）") : `<span class="muted">${status === "running" ? "还在执行…" : "没有结果"}</span>`}</div></section>
		<section><h3 class="eyebrow">信息</h3><dl class="kvs">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></section>`;
	body.querySelector(".drawer-task").textContent = d.task || "（派工记录不在历史里）";
	if (slot) renderLogInto(body.querySelector(".log"), slot.output);
}

export async function openDispatch(callId) {
	currentId = callId;
	const base = find(callId);
	detail = base ? { ...base, result: undefined } : { callId, agent: "", task: "", status: "open" };
	drawer.hidden = false;
	requestAnimationFrame(() => drawer.classList.add("open"));
	render();
	try {
		const full = await getJson(`/api/dispatches/${encodeURIComponent(callId)}`);
		if (currentId === callId) {
			detail = full;
			render();
		}
	} catch {
		/* 还没有汇总（刚派出），用列表里的信息 */
	}
}

export function closeDrawer() {
	currentId = null;
	detail = null;
	drawer.classList.remove("open");
	setTimeout(() => {
		if (!currentId) drawer.hidden = true;
	}, 200);
}

$("#drawerClose").addEventListener("click", closeDrawer);
$("#drawerScrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && currentId) closeDrawer();
});

subscribe((kind) => {
	if (!currentId) return;
	if (kind === "dispatches") {
		const fresh = find(currentId);
		// 刚结束：重新取完整结果
		if (fresh && detail && fresh.status !== detail.status) openDispatch(currentId);
		return;
	}
	if (kind === "live" || kind === "tick") {
		const slot = detail && statusOf(detail).slot;
		if (slot) {
			const log = body.querySelector(".log");
			if (log) renderLogInto(log, slot.output);
			else render();
			const pill = $("#drawerTitle .pill");
			const started = slotStart.get(slot.callId);
			if (pill && slot.status === "running" && started) pill.textContent = `执行中 ${duration(Date.now() - started)}`;
		}
	}
});
