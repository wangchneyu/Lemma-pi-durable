// 一次运行的时间线：你的输入 → 总调度的消息和派工单 → 成员结果 → 最终回答。
import { Ticket } from "./ticket.js";
import { clock, el, esc, markdown } from "./util.js";

const STATUS_TEXT = { todo: "待办", doing: "进行中", review: "待验收", done: "完成", blocked: "受阻", dropped: "取消" };

/** 分工表操作的一行摘要 */
function boardOpText(call) {
	const a = call.args ?? {};
	if (call.name === "plan_tasks") {
		const tasks = Array.isArray(a.tasks) ? a.tasks : [];
		return `<span class="op-icon">📋</span><b>拆解任务</b><span>${tasks.length} 项：${esc(tasks.map((t) => t.title).join("；").slice(0, 140))}</span>`;
	}
	if (call.name === "update_task") {
		return `<span class="op-icon">✔</span><b>${esc(a.id ?? "")}${a.status ? ` → ${esc(STATUS_TEXT[a.status] ?? a.status)}` : ""}</b><span>${esc(String(a.note ?? "").slice(0, 120))}</span>`;
	}
	if (call.name === "set_goal") return `<span class="op-icon">🎯</span><b>起草项目目标</b><span>GOAL.md，待你确认</span>`;
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
			const slot = slots.get(callId);
			if (slot) ticket.update(slot);
			else if (!live.busy || !current) ticket.markOpen();
		}
	}
}
