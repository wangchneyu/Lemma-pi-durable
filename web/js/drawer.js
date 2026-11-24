// 右侧抽屉：一次派工的完整任务、实时输出、结果和元信息。
import { jobById, store, subscribe } from "./store.js";
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
	const job = jobById(d.job);
	if (job?.status === "running") return { status: "running", job };
	const slot = d.status === "open" ? store.live.tools.find((t) => t.callId === d.callId) : undefined;
	if (slot && slot.status !== "done") return { status: slot.status === "running" ? "running" : "open", slot };
	return { status: d.status, slot: undefined };
}

function render() {
	if (!detail) return;
	const d = detail;
	const { status, slot, job } = statusOf(d);
	const started = slot ? slotStart.get(d.callId) : job?.startedAt;
	drawer.style.setProperty("--c", agentColor(d.agent));
	$("#drawerTitle").innerHTML = `<span class="agent-chip">${esc(AGENT_LABEL[d.agent] ?? d.agent)}</span><span class="ticket-no">#${esc(d.callId.slice(-6))}</span><span class="pill" data-s="${status === "running" ? "running" : status === "done" ? "done" : status === "error" ? "error" : "aborted"}">${esc(STATUS_LABEL[status] ?? status)}${status === "running" && started ? ` ${duration(Date.now() - started)}` : ""}</span>`;
	const roleLabel = d.callId?.startsWith("checker:")
		? "独立复核（Maker-Checker）"
		: d.callId?.startsWith("integration-repair:")
			? "联合集成冲突/联调修复"
			: d.callId?.startsWith("workflow:")
				? "Durable 自动依赖推进"
				: d.job
					? `后台派工 <code>${esc(d.job)}</code>`
					: "同步（总调度等结果）";
	const boardTask = d.taskId ? (store.state?.project?.tasks ?? []).find((t) => t.id === d.taskId) : undefined;
	const scopeText = boardTask?.scope && (boardTask.scope.allow?.length || boardTask.scope.forbid?.length)
		? [
				boardTask.scope.allow?.length ? `允许: <code>${esc(boardTask.scope.allow.join(", "))}</code>` : "",
				boardTask.scope.forbid?.length ? `禁止: <code>${esc(boardTask.scope.forbid.join(", "))}</code>` : "",
			].filter(Boolean).join(" · ")
		: null;
	const rows = [
		["方式", roleLabel + (d.job && !roleLabel.includes(d.job) ? ` · <code>${esc(d.job)}</code>` : "")],
		["分工任务", d.taskId ? `${esc(d.taskId)}${boardTask ? ` · ${esc(boardTask.title)}` : ""}` : "—"],
		...(scopeText ? [["路径契约", scopeText]] : []),
		["模型", d.model ? `<code>${esc(d.model)}</code>` : "CLI 默认"],
		["派工时间", stamp(d.at)],
		["结束时间", d.endAt ? stamp(d.endAt) : "—"],
		["耗时", duration(d.durationMs)],
		["花费", `${money(d.cost)}${d.costEstimated ? "（按单价估算）" : ""}`],
		["改动", d.changeId ? `<a class="linkish" href="#/changes/${esc(d.changeId)}">#${esc(d.changeId)}</a>` : d.basedOn ? "—" : "没有隔离（不在 git 仓库或没开启）"],
		["基于", d.basedOn ? `<a class="linkish" href="#/changes/${esc(d.basedOn)}">#${esc(d.basedOn)}</a>` : "—"],
		["会话", d.sessionId ? `<button type="button" class="linkish" data-copy="${esc(d.sessionId)}">${esc(d.sessionId)}</button>` : "—"],
		["续接自", d.resume ? esc(d.resume) : "—"],
		["目录", d.cwd ? `<code>${esc(d.cwd)}</code>` : "—"],
		["退出码", d.exitCode ?? "—"],
	];
	body.innerHTML = `
		<section><h3 class="eyebrow">任务</h3><div class="drawer-task"></div></section>
		${slot || job ? `<section><h3 class="eyebrow">实时输出</h3><div class="log tall"></div></section>` : ""}
		<section><h3 class="eyebrow">结果</h3><div class="drawer-result md">${d.result !== undefined ? markdown(d.result || "（没有文字输出）") : `<span class="muted">${status === "running" ? "还在执行…" : "没有结果"}</span>`}</div></section>
		<section><h3 class="eyebrow">信息</h3><dl class="kvs">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></section>`;
	body.querySelector(".drawer-task").textContent = d.task || "（派工记录不在历史里）";
	if (slot) renderLogInto(body.querySelector(".log"), slot.output);
	if (job) renderLogInto(body.querySelector(".log"), (job.output ?? d.output ?? []).join("\n"));
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
	if (kind === "jobs") {
		// 后台派工结束：重新取完整结果
		const job = detail?.job ? jobById(detail.job) : undefined;
		if (job && job.status !== "running" && detail.status === "open") openDispatch(currentId);
		return;
	}
	if (kind === "job-output" || (kind === "tick" && detail?.job)) {
		const job = detail?.job ? jobById(detail.job) : undefined;
		const log = body.querySelector(".log");
		if (job && log) renderLogInto(log, (job.output ?? []).join("\n"));
		const pill = $("#drawerTitle .pill");
		if (job?.status === "running" && pill) pill.textContent = `后台执行中 ${duration(Date.now() - job.startedAt)}`;
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
