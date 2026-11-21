// 派工单：一次 ask_* 调用的卡片，执行中显示实时日志和计时，结束后显示结果。
import { AGENT_LABEL, SLOT_LABEL, STATUS_LABEL, duration, el, esc, kindOf, markdown, money, parseResult } from "./util.js";

/** callId -> 首次看到"执行中"的时间（所有视图共用） */
export const slotStart = new Map();
export function noteSlots(tools) {
	for (const t of tools) if (t.status === "running" && !slotStart.has(t.callId)) slotStart.set(t.callId, Date.now());
}

function logClass(line) {
	if (/^[▶ℹ]/.test(line)) return "l-start";
	if (/^(🔧|⚙️|📝)/u.test(line)) return "l-tool";
	if (/^❌/u.test(line)) return "l-err";
	return "";
}

export function renderLogInto(box, output) {
	if (!output || box.dataset.len === String(output.length)) return;
	box.dataset.len = String(output.length);
	const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
	box.replaceChildren(
		...output
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const d = el("div", logClass(l));
				d.textContent = l;
				return d;
			}),
	);
	if (stick) box.scrollTop = box.scrollHeight;
}

const JOB_LABEL = { done: "完成", failed: "失败", cancelled: "已取消" };

export class Ticket {
	constructor(call) {
		this.callId = call.id;
		this.kind = kindOf(call.name);
		this.settled = false;
		const task = String(call.args?.task ?? JSON.stringify(call.args ?? {}));
		const node = el("article", "ticket");
		node.dataset.kind = this.kind;
		const resume = call.args?.session_id ? `<span class="resume">续接 ${esc(String(call.args.session_id).slice(0, 8))}</span>` : "";
		node.innerHTML = `
			<header class="ticket-head">
				<span class="agent-chip">${esc(AGENT_LABEL[this.kind] ?? call.name)}</span>
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
		this.node = node;
		this.pill = node.querySelector(".pill");
		this.log = node.querySelector(".log");
		this.result = node.querySelector(".result");
		this.meta = node.querySelector(".meta");
	}

	update(slot) {
		if (this.settled || !slot) return;
		const started = slotStart.get(slot.callId);
		const running = slot.status === "running";
		this.pill.dataset.s = running ? "running" : "pending";
		this.pill.textContent = `${SLOT_LABEL[slot.status] ?? slot.status}${running && started ? ` ${duration(Date.now() - started)}` : ""}`;
		renderLogInto(this.log, slot.output);
	}

	/** 没有结果、也不在执行中：多半是进程中断后还没续上 */
	markOpen() {
		if (this.settled) return;
		this.pill.dataset.s = "aborted";
		this.pill.textContent = "无结果";
	}

	settle(item) {
		// 后台派工：这条结果只表示「已开工」，之后按后台记录更新（updateJob）
		if (item.details?.job) return this.background(item.details.job);
		this.settled = true;
		this.node.classList.add("settled");
		const r = parseResult(item);
		this.pill.dataset.s = r.status === "done" ? "done" : r.status === "error" ? "error" : "aborted";
		this.pill.textContent = `${STATUS_LABEL[r.status]}${r.durationMs ? ` · ${duration(r.durationMs)}` : ""}`;
		this.showResult(r.body, r.status === "error");
		this.showMeta(r);
	}

	background(jobId) {
		this.jobId = jobId;
		this.settled = true;
		this.node.classList.add("bg");
		this.pill.dataset.s = "running";
		this.pill.textContent = `后台 ${jobId}`;
		this.node.querySelector(".ticket-no").textContent = jobId;
	}

	/** 后台派工的状态和实时输出 */
	updateJob(job) {
		if (!job || this.jobDone) return;
		if (job.status === "running") {
			this.pill.dataset.s = "running";
			this.pill.textContent = `后台执行中 ${duration(Date.now() - job.startedAt)}`;
			renderLogInto(this.log, (job.output ?? []).join("\n"));
			return;
		}
		this.jobDone = true;
		this.node.classList.add("settled");
		this.pill.dataset.s = job.status === "done" ? "done" : job.status === "failed" ? "error" : "aborted";
		this.pill.textContent = `后台${JOB_LABEL[job.status] ?? job.status}${job.durationMs ? ` · ${duration(job.durationMs)}` : ""}`;
		this.showResult(job.result ?? "", job.status === "failed");
		this.showMeta({ sessionId: job.sessionId, cost: job.costUsd });
	}

	showResult(text, isError) {
		this.result.hidden = false;
		this.result.classList.toggle("err", isError);
		const r = { body: text };
		const body = el("div", "result-body md", markdown(r.body || "（没有文字输出）"));
		this.result.replaceChildren(body);
		if (r.body.length > 900) {
			body.classList.add("collapsed");
			const more = el("button", "expand", "展开全部 ↓");
			more.type = "button";
			more.addEventListener("click", () => {
				const collapsed = body.classList.toggle("collapsed");
				more.textContent = collapsed ? "展开全部 ↓" : "收起 ↑";
			});
			this.result.append(more);
		}
	}

	showMeta(r) {
		const parts = [];
		if (r.sessionId) parts.push(`会话 <button type="button" data-copy="${esc(r.sessionId)}">${esc(String(r.sessionId).slice(0, 8))}</button>`);
		if (r.cost !== undefined && r.cost !== null) parts.push(`花费 ${esc(money(r.cost))}`);
		if (r.cwd) parts.push(`<span title="${esc(r.cwd)}">${esc(String(r.cwd).split(/[\\/]/).filter(Boolean).pop() ?? r.cwd)}</span>`);
		if (r.exitCode !== undefined && r.exitCode !== null && r.exitCode !== 0) parts.push(`退出码 ${esc(r.exitCode)}`);
		if (parts.length) {
			this.meta.hidden = false;
			this.meta.innerHTML = parts.join("");
		}
	}
}
