// 路由分配图：你 → 总调度 → 各成员。执行中的线路有流动光点，派工 / 回报 / 回答时有一次性的数据包飞过。
import { callInfo, store } from "./store.js";
import { slotStart } from "./ticket.js";
import { AGENT_LABEL, FAILURE_LABEL, KINDS, STATUS_LABEL, agentColor, duration, el, esc, kindOf } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let uid = 0;

function geometry(narrow) {
	if (!narrow) {
		const agents = {};
		[34, 88, 142].forEach((y, i) => (agents[KINDS[i]] = { x: 600, y, w: 190, h: 46 }));
		return {
			narrow,
			vb: "0 0 760 176",
			user: { x: 46, y: 88, r: 19 },
			orch: { x: 262, y: 88, w: 160, h: 64 },
			userEdge: [69, 88, 178, 88],
			agentEdge: (a) => `M342 88 C424 88 424 ${a.y} ${a.x - a.w / 2} ${a.y}`,
			agentEnds: (a) => [342, 88, a.x - a.w / 2, a.y],
			agents,
		};
	}
	const agents = {};
	[62, 180, 298].forEach((x, i) => (agents[KINDS[i]] = { x, y: 206, w: 108, h: 52 }));
	return {
		narrow,
		vb: "0 0 360 236",
		user: { x: 180, y: 22, r: 17 },
		orch: { x: 180, y: 96, w: 170, h: 54 },
		userEdge: [180, 41, 180, 69],
		agentEdge: (a) => `M180 123 C180 152 ${a.x} 152 ${a.x} ${a.y - a.h / 2}`,
		agentEnds: (a) => [180, 123, a.x, a.y - a.h / 2],
		agents,
	};
}

function setText(node, sel, text) {
	const t = node.querySelector(sel);
	if (t && t.textContent !== text) t.textContent = text;
}

export class RouteMap {
	constructor() {
		this.id = `rm${++uid}`;
		this.node = el("div", "routemap");
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.setAttribute("class", "route-map");
		this.svg.setAttribute("aria-hidden", "true");
		this.lines = el("div", "route-lines");
		this.lines.setAttribute("aria-live", "polite");
		this.node.append(this.svg, this.lines);
		this.layout = null;
		this.observer = new ResizeObserver(() => this.render());
		this.observer.observe(this.node);
	}

	destroy() {
		this.observer.disconnect();
	}

	$(name) {
		return this.svg.querySelector(`[data-n="${name}"]`);
	}

	build() {
		const width = this.node.clientWidth;
		if (!width) return false;
		const narrow = width < 600;
		if (this.layout?.narrow === narrow) return true;
		const g = geometry(narrow);
		this.layout = g;
		this.svg.setAttribute("viewBox", g.vb);
		const pid = (k) => `${this.id}-${k}`;
		const flow = (k) =>
			reduceMotion ? "" : `<circle class="rt-flow" r="3.2"><animateMotion dur="1.3s" repeatCount="indefinite"><mpath href="#${pid(k)}"/></animateMotion></circle>`;
		const port = (x, y) => `<circle class="rt-port" cx="${x}" cy="${y}" r="3"/>`;
		const [ux1, uy1, ux2, uy2] = g.userEdge;
		let edges = `<g class="rt-edge-g" data-n="edge-user" style="--c:var(--orch)"><path class="rt-edge" id="${pid("user")}" d="M${ux1} ${uy1} L${ux2} ${uy2}"/>${port(ux2, uy2)}${flow("user")}</g>`;
		let nodes = "";
		for (const kind of KINDS) {
			const a = g.agents[kind];
			const [x1, y1, x2, y2] = g.agentEnds(a);
			edges += `<g class="rt-edge-g" data-n="edge-${kind}" style="--c:var(--${kind})"><path class="rt-edge" id="${pid(kind)}" d="${g.agentEdge(a)}"/>${port(x1, y1)}${port(x2, y2)}${flow(kind)}</g>`;
			const nameY = narrow ? 21 : 19;
			nodes += `<g class="rt-node rt-agent" data-n="node-${kind}" style="--c:var(--${kind})" transform="translate(${a.x - a.w / 2} ${a.y - a.h / 2})">
				<rect class="rt-box" width="${a.w}" height="${a.h}" rx="8"/>
				<rect class="rt-accent" x="0.5" y="8" width="3" height="${a.h - 16}" rx="1.5"/>
				<circle class="rt-lamp" cx="14" cy="${nameY - 4.5}" r="3.5"/>
				<text class="rt-name" x="24" y="${nameY}">${esc(AGENT_LABEL[kind])}</text>
				<text class="rt-count" x="${a.w - 10}" y="${nameY}" text-anchor="end"></text>
				<text class="rt-state" x="${narrow ? 10 : 24}" y="${narrow ? 39 : 35}"></text>
			</g>`;
		}
		const o = g.orch;
		nodes += `<g class="rt-node rt-orch" data-n="node-orch" transform="translate(${o.x - o.w / 2} ${o.y - o.h / 2})">
			<rect class="rt-box" width="${o.w}" height="${o.h}" rx="10"/>
			<rect class="rt-lamp" x="${o.w / 2 - 40}" y="${o.h / 2 - 12}" width="7" height="7" transform="rotate(45 ${o.w / 2 - 36.5} ${o.h / 2 - 8.5})"/>
			<text class="rt-name" x="${o.w / 2 + 6}" y="${o.h / 2 - 3}" text-anchor="middle">总调度</text>
			<text class="rt-state" x="${o.w / 2}" y="${o.h / 2 + 15}" text-anchor="middle"></text>
		</g>`;
		const u = g.user;
		nodes += `<g class="rt-node rt-user"><circle cx="${u.x}" cy="${u.y}" r="${u.r}"/><text x="${u.x}" y="${u.y + 5}" text-anchor="middle">你</text></g>`;
		this.svg.innerHTML = `<g>${edges}</g><g>${nodes}</g><g data-n="packets"></g>`;
		return true;
	}

	render() {
		if (!this.build()) return;
		const { live, state, dispatches } = store;
		const narrow = this.layout.narrow;
		const active = live.tools.filter((t) => t.status !== "done");
		const running = active.filter((t) => t.status === "running");

		for (const kind of KINDS) {
			const node = this.$(`node-${kind}`);
			const edge = this.$(`edge-${kind}`);
			const mine = active.filter((t) => kindOf(t.name) === kind);
			const mineRunning = mine.filter((t) => t.status === "running");
			const agent = state?.agents.find((a) => a.kind === kind);
			const total = state?.agentStats?.[kind]?.total ?? 0;
			const last = dispatches.find((d) => d.agent === kind && d.status !== "open");
			let status = "idle";
			let text = last ? `上次${STATUS_LABEL[last.status]}${last.durationMs ? ` · ${duration(last.durationMs)}` : ""}` : "待命";
			if (agent && !agent.available) {
				status = "off";
				text = "不可用";
			} else if (mineRunning.length) {
				status = "running";
				const since = Math.min(...mineRunning.map((t) => slotStart.get(t.callId) ?? Date.now()));
				text = `执行中${mineRunning.length > 1 ? ` ×${mineRunning.length}` : ""} ${duration(Date.now() - since)}`;
			} else if (mine.length) {
				status = "pending";
				text = "排队中";
			}
			node.dataset.state = status;
			edge.dataset.state = status === "running" ? "active" : status === "pending" ? "queued" : "idle";
			setText(node, ".rt-state", text);
			setText(node, ".rt-count", total ? (narrow ? `${total}次` : `派工 ${total}`) : "");
		}

		const orch = this.$("node-orch");
		let orchState = "idle";
		let orchText = "待命";
		if (live.busy && running.length) {
			orchState = "dispatching";
			orchText = running.length > 1 ? `派工中 · ${running.length} 路并行` : "派工中 · 等待回报";
		} else if (live.busy) {
			orchState = "thinking";
			orchText = live.retry ? "模型重试中" : live.partial.trim() ? "输出中" : "规划中";
		} else if (live.runFailure?.reason === "aborted") {
			orchText = "上一轮已中止";
		} else if (live.runFailure) {
			orchState = "failed";
			orchText = FAILURE_LABEL[live.runFailure.reason] ?? live.runFailure.reason;
		}
		orch.dataset.state = orchState;
		setText(orch, ".rt-state", orchText);
		this.$("edge-user").dataset.state = live.busy ? "active" : "idle";

		if (active.length) {
			this.lines.replaceChildren(
				...active.map((t) => {
					const kind = kindOf(t.name);
					const row = el("div", "route-line");
					row.dataset.s = t.status === "running" ? "running" : "pending";
					row.style.setProperty("--c", agentColor(kind));
					const started = slotStart.get(t.callId);
					const task = callInfo(t.callId)?.task ?? "";
					row.innerHTML = `<b>→ ${esc(AGENT_LABEL[kind] ?? t.name)}</b><span class="task"></span><time>${t.status === "running" && started ? duration(Date.now() - started) : "排队"}</time>`;
					row.querySelector(".task").textContent = task.replace(/\s+/g, " ");
					row.title = task;
					return row;
				}),
			);
		} else {
			const hint = live.busy ? "总调度正在规划，还没有派工" : "空闲 · 在终端里下发任务后，这里显示每条线路正在处理什么";
			if (this.lines.textContent !== hint) this.lines.innerHTML = `<span class="idle">${esc(hint)}</span>`;
		}
	}

	/** 一次性的数据包：沿某条线路飞过（reverse 表示从末端飞回起点） */
	packet(route, color, reverse = false) {
		if (reduceMotion || !this.layout) return;
		const path = this.svg.querySelector(`#${this.id}-${route}`);
		const layer = this.$("packets");
		if (!path || !layer) return;
		const dot = document.createElementNS(SVG_NS, "circle");
		dot.setAttribute("class", "rt-packet");
		dot.setAttribute("r", "4.5");
		dot.style.setProperty("--c", color);
		const motion = document.createElementNS(SVG_NS, "animateMotion");
		for (const [k, v] of Object.entries({ dur: "0.9s", begin: "indefinite", fill: "freeze", keyPoints: reverse ? "1;0" : "0;1", keyTimes: "0;1", calcMode: "linear" }))
			motion.setAttribute(k, v);
		const mpath = document.createElementNS(SVG_NS, "mpath");
		mpath.setAttribute("href", `#${this.id}-${route}`);
		motion.append(mpath);
		dot.append(motion);
		layer.append(dot);
		motion.beginElement();
		setTimeout(() => dot.remove(), 950);
	}

	/** 新条目到达时播放对应的转发动画 */
	animate(items) {
		for (const item of items) {
			if (item.type === "user") this.packet("user", "var(--ink)");
			else if (item.type === "assistant") {
				if (item.toolCalls.length) for (const call of item.toolCalls) this.packet(kindOf(call.name), agentColor(kindOf(call.name)));
				else if (item.text.trim()) this.packet("user", "var(--orch)", true);
			} else if (item.type === "tool") this.packet(kindOf(item.name), agentColor(kindOf(item.name)), true);
		}
	}
}
