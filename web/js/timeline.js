// 一次运行的时间线：你的输入 → 总调度的消息和派工单 → 成员结果 → 最终回答。
import { Ticket } from "./ticket.js";
import { clock, el, esc, markdown } from "./util.js";

function whoLine(label, at) {
	return `<div class="who"><span>${label}</span>${at ? `<time>${clock(at)}</time>` : ""}</div>`;
}

export class Timeline {
	constructor() {
		this.node = el("div", "timeline");
		this.tickets = new Map();
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
			if (item.toolCalls.length) {
				const wrap = el("div", `tickets${item.toolCalls.length > 1 ? " multi" : ""}`);
				for (const call of item.toolCalls) {
					const t = new Ticket(call);
					this.tickets.set(call.id, t);
					wrap.append(t.node);
				}
				node.append(wrap);
			}
			return node;
		}
		if (item.type === "tool") {
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
