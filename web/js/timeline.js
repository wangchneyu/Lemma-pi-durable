// 一次运行的时间线：你的输入 → 总调度的消息和派工单 → 成员结果 → 最终回答。
import { jobById } from "./store.js";
import { Ticket } from "./ticket.js";
import { clock, el, esc, markdown } from "./util.js";

const STATUS_TEXT = { todo: "待办", doing: "进行中", review: "待验收", done: "完成", blocked: "受阻", dropped: "取消" };

/** 分工表与协作编排操作的一行摘要 */
function boardOpText(call) {
	const a = call.args ?? {};
	if (call.name === "plan_tasks") {
		const tasks = Array.isArray(a.tasks) ? a.tasks : [];
		const autoCount = tasks.filter((t) => t?.automation).length;
		const reviewCount = tasks.filter((t) => t?.reviewer).length;
		const blindCount = tasks.filter((t) => t?.reviewer?.blind).length;
		const scopeCount = tasks.filter((t) => t?.scope && (t.scope.allow?.length || t.scope.forbid?.length)).length;
		const tags = [
			autoCount ? `自动派发 ${autoCount}` : "",
			reviewCount ? `独立${blindCount ? "盲审" : "复核"} ${reviewCount}` : "",
			scopeCount ? `路径契约 ${scopeCount}` : "",
		].filter(Boolean).join(" · ");
		return `<span class="op-icon">📋</span><b>拆解任务${tags ? `（${esc(tags)}）` : ""}</b><span>${tasks.length} 项：${esc(tasks.map((t) => t.title).join("；").slice(0, 140))}</span>`;
	}
	if (call.name === "update_task") {
		return `<span class="op-icon">✔</span><b>${esc(a.id ?? "")}${a.status ? ` → ${esc(STATUS_TEXT[a.status] ?? a.status)}` : ""}</b><span>${esc(String(a.note ?? "").slice(0, 120))}</span>`;
	}
	if (call.name === "review_task") {
		const verdict = { accept: "通过", rework: "打回返工", block: "受阻" }[a.action] ?? a.action ?? "";
		return `<span class="op-icon">🔎</span><b>验收任务 ${esc(a.id ?? "")} → ${esc(verdict)}</b><span>${a.result_id ? `[${esc(a.result_id)}] ` : ""}${esc(String(a.evidence ?? "").slice(0, 130))}</span>`;
	}
	if (call.name === "recover_task") {
		const act = { inspect: "查看缺口", resume: "续接原成员", supply: "补充资料", reassign: "换人接手", cancel: "取消计划" }[a.action] ?? a.action ?? "";
		return `<span class="op-icon">🛟</span><b>恢复任务 ${esc(a.id ?? "")} · ${esc(act)}${a.member ? ` → ${esc(a.member)}` : ""}</b><span>${esc(String(a.note ?? "").slice(0, 120))}</span>`;
	}
	if (call.name === "ready_tasks") {
		return `<span class="op-icon">🚦</span><b>检查就绪队列</b><span>计算各任务前置依赖与阻塞原因</span>`;
	}
	if (call.name === "read_result") {
		return `<span class="op-icon">📄</span><b>读取成果 ${esc(a.result_id ?? "")}</b><span>${a.field ? `字段 ${esc(a.field)} · ` : ""}偏移 ${esc(String(a.offset ?? 0))}</span>`;
	}
	if (call.name === "integrate_changes") {
		const target = a.rerun_id ? `重验 #${a.rerun_id}` : Array.isArray(a.changes) ? a.changes.map((id) => `#${id}`).join(" + ") : "";
		return `<span class="op-icon">🔀</span><b>联合集成与测试</b><span>${esc(target)} · 独立副本合并并运行 autonomy.checks</span>`;
	}
	if (call.name === "read_integration") {
		return `<span class="op-icon">🔍</span><b>查看联合集成${a.id ? ` #${esc(a.id)}` : ""}</b><span>${a.wait ? "原生挂起等待联合检查完成" : "读取集成状态与测试报告"}</span>`;
	}
	if (call.name === "repair_integration") {
		return `<span class="op-icon">🛠</span><b>修复联合集成 #${esc(a.id ?? "")} → ${esc(a.member ?? "")}</b><span>${esc(String(a.note ?? "在独立修复副本解冲突并重跑全量检查").slice(0, 120))}</span>`;
	}
	if (call.name === "set_goal") return `<span class="op-icon">🎯</span><b>起草项目目标</b><span>GOAL.md，待你确认</span>`;
	if (call.name === "wait_jobs") {
		const ids = Array.isArray(a.ids) && a.ids.length ? a.ids.join("、") : "所有进行中的后台派工";
		return `<span class="op-icon">⏳</span><b>等后台结果</b><span>${esc(ids)} · ${a.mode === "all" ? "全部做完才继续" : "做完一个就先处理"}</span>`;
	}
	if (call.name === "delegate_to_lead") {
		return `<span class="op-icon">🧭</span><b>交给子调度「${esc(a.name ?? "子调度")}」${a.task_id ? ` · ${esc(a.task_id)}` : ""}</b><span>${esc(String(a.goal ?? "").slice(0, 140))}${a.scope ? `（范围：${esc(String(a.scope).slice(0, 60))}）` : ""}</span>`;
	}
	if (call.name === "cancel_job") return `<span class="op-icon">✕</span><b>取消后台派工 ${esc(a.id ?? "")}</b><span>改动留在分支里，任务退回待办</span>`;
	return `<span class="op-icon">⚙</span><b>${esc(call.name)}</b>`;
}

function whoLine(label, at) {
	return `<div class="who"><span>${label}</span>${at ? `<time>${clock(at)}</time>` : ""}</div>`;
}

export class Timeline {
	constructor() {
		this.node = el("div", "timeline");
		this.tickets = new Map();
		this.ops = new Map();
		this.ids = new Set();
		this.ghost = null;
	}

	add(items, { animate = false } = {}) {
		for (const item of items) {
			if (this.ids.has(item.id)) continue;
			this.ids.add(item.id);
			const node = this.render(item);
			if (!node) continue;
			if (!animate) node.classList.add("still");
			this.node.append(node);
		}
		if (this.ghost) this.node.append(this.ghost);
	}

	render(item) {
		if (item.type === "user") {
			const node = el("div", `item user${item.steer ? " steer" : ""}`, `${whoLine(item.steer ? "你 · 插话" : "你 · 终端", item.at)}<div class="bubble"></div>`);
			node.querySelector(".bubble").textContent = item.text;
			return node;
		}
		if (item.type === "divider") return el("div", "item divider", esc(item.label));
		if (item.type === "job") {
			// 后台派工或自动协作推进的结果发回总调度
			const isWorkflow = String(item.job ?? "").startsWith("workflow:");
			const [head = "", ...rest] = item.text.split("\n");
			const body = rest.join("\n").replace(/\n*（这是后台派工的结果[\s\S]*$/, "").trim();
			const failed = item.status === "failed" || item.status === "cancelled";
			const who = isWorkflow ? "协作推进汇总 · 自动工作流" : `后台结果 · ${esc(item.job)}`;
			const node = el("div", `item job${failed ? " failed" : ""}`, `${whoLine(who, item.at)}<div class="job-card" style="--c:var(--${esc(item.agent)}, var(--lead))"><div class="job-head"></div><div class="job-body md"></div></div>`);
			node.querySelector(".job-head").textContent = head;
			const bodyEl = node.querySelector(".job-body");
			bodyEl.innerHTML = markdown(body.length > 1200 ? `${body.slice(0, 1200)}…` : body);
			return node;
		}
		if (item.type === "assistant") {
			if (!item.text.trim() && !item.toolCalls.length && !item.error) return null;
			const node = el("div", "item orch", whoLine("总调度", item.at));
			if (item.text.trim()) node.append(el("div", "md", markdown(item.text)));
			if (item.error) node.append(el("div", "error", esc(item.error)));
			// 分工表操作（plan_tasks / update_task / set_goal）：一行摘要；派给成员的：派工单
			const ops = item.toolCalls.filter((c) => !c.name.startsWith("ask_"));
			const calls = item.toolCalls.filter((c) => c.name.startsWith("ask_"));
			if (ops.length) {
				const list = el("div", "board-ops");
				for (const call of ops) {
					const op = el("div", "board-op", boardOpText(call));
					this.ops.set(call.id, op);
					list.append(op);
				}
				node.append(list);
			}
			if (calls.length) {
				const wrap = el("div", `tickets${calls.length > 1 ? " multi" : ""}`);
				for (const call of calls) {
					const t = new Ticket(call);
					this.tickets.set(call.id, t);
					wrap.append(t.node);
				}
				node.append(wrap);
			}
			return node;
		}
		if (item.type === "tool") {
			const op = this.ops.get(item.callId);
			if (op) {
				op.dataset.s = item.isError ? "error" : "done";
				op.title = item.text;
				return null;
			}
			if (!item.name.startsWith("ask_")) return null;
			const ticket = this.tickets.get(item.callId);
			if (ticket) {
				ticket.settle(item);
				return null;
			}
			// 派工单不在这次加载的范围里：单独显示结果
			const node = el("div", "item orch", whoLine("成员结果", item.at));
			const t = new Ticket({ id: item.callId, name: item.name, args: { task: "（派工记录在更早的历史里）" } });
			t.settle(item);
			this.tickets.set(item.callId, t);
			node.append(t.node);
			return node;
		}
		return null;
	}

	/** current：这是不是最新一次运行（只有它显示总调度的流式草稿） */
	live(live, current) {
		if (current && live.busy && live.partial.trim()) {
			if (!this.ghost) {
				this.ghost = el("div", "item orch ghost", `${whoLine("总调度")}<div class="md typing"></div>`);
				this.node.append(this.ghost);
			}
			this.ghost.querySelector(".md").innerHTML = markdown(live.partial);
		} else if (this.ghost) {
			this.ghost.remove();
			this.ghost = null;
		}
		const slots = new Map(live.tools.map((t) => [t.callId, t]));
		for (const [callId, ticket] of this.tickets) {
			if (ticket.jobId) {
				ticket.updateJob(jobById(ticket.jobId));
				continue;
			}
			const slot = slots.get(callId);
			if (slot) ticket.update(slot);
			else if (!live.busy || !current) ticket.markOpen();
		}
	}
}
