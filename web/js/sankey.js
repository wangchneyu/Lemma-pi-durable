// 派工流向图（桑基图）：你 → 总调度 → 各成员 → 结果。
// 带子宽度按所选指标（次数 / 耗时 / 花费）；带子上的光点一直在流，执行中的线路流得更亮更快。
// 自带极简布局，无依赖。结构不变时就地更新几何属性，流动动画不会因为刷新而跳。
import { dispatchRows, store } from "./store.js";
import { slotStart } from "./ticket.js";
import { AGENT_LABEL, KINDS, agentColor, duration, el, esc, money } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const OUTCOMES = [
	{ id: "done", label: "完成", color: "var(--ok)" },
	{ id: "running", label: "执行中", color: "var(--run)" },
	{ id: "error", label: "失败", color: "var(--danger)" },
	{ id: "aborted", label: "中止", color: "var(--muted)" },
	{ id: "open", label: "无结果", color: "var(--line-strong)" },
];
const outcomeOf = (status) => (status === "interrupted" ? "aborted" : OUTCOMES.some((o) => o.id === status) ? status : "open");

function elapsed(d) {
	if (d.status !== "running") return d.durationMs ?? 0;
	const started = slotStart.get(d.callId);
	return started ? Date.now() - started : 0;
}

export const METRICS = {
	count: { label: "次数", value: () => 1, fmt: (v) => `${Math.round(v)} 次` },
	time: { label: "耗时", value: elapsed, fmt: (v) => duration(v) },
	cost: { label: "花费", value: (d) => d.cost ?? 0, fmt: (v) => money(v) },
};
export const RANGES = {
	all: { label: "全部", ms: Infinity },
	day: { label: "24 小时", ms: 86_400_000 },
	hour: { label: "1 小时", ms: 3_600_000 },
};

let uid = 0;

export class Sankey {
	constructor() {
		this.id = `sk${++uid}`;
		this.metric = "count";
		this.range = "all";
		this.node = el("div", "sankey");
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.setAttribute("class", "sk-svg");
		this.svg.setAttribute("role", "img");
		this.empty = el("div", "empty-state sk-empty");
		this.tip = el("div", "sk-tip");
		this.tip.hidden = true;
		this.node.append(this.svg, this.empty, this.tip);
		this.signature = "";
		this.model = null;
		this.observer = new ResizeObserver(() => this.render(true));
		this.observer.observe(this.node);
		this.bindEvents();
	}

	destroy() {
		this.observer.disconnect();
	}

	set(option, value) {
		this[option] = value;
		this.render(true);
	}

	// ---------------- 数据 ----------------
	compute() {
		const now = Date.now();
		const window = RANGES[this.range].ms;
		const rows = dispatchRows().filter((d) => window === Infinity || !d.at || now - d.at <= window);
		const value = METRICS[this.metric].value;
		const nodes = new Map();
		const links = new Map();
		const addNode = (id, label, color, col, href) => {
			if (!nodes.has(id)) nodes.set(id, { id, label, color, col, href, value: 0, inV: 0, outV: 0, stats: blank() });
			return nodes.get(id);
		};
		const addLink = (from, to, d, v) => {
			const id = `${from}>${to}`;
			let l = links.get(id);
			if (!l) links.set(id, (l = { id, from, to, value: 0, hot: false, stats: blank() }));
			l.value += v;
			tally(l.stats, d);
			if (d.status === "running") l.hot = true;
		};
		for (const d of rows) {
			const v = value(d);
			const agent = d.agent;
			const outcome = outcomeOf(d.status);
			addNode("you", "你", "var(--ink)", 0);
			addNode("orch", "总调度", "var(--orch)", 1);
			addNode(`a:${agent}`, AGENT_LABEL[agent] ?? agent, agentColor(agent), 2, `#/dispatches/${agent}`);
			const o = OUTCOMES.find((x) => x.id === outcome);
			addNode(`o:${outcome}`, o.label, o.color, 3, `#/dispatches/all/${outcome}`);
			for (const n of ["you", "orch", `a:${agent}`, `o:${outcome}`]) tally(nodes.get(n).stats, d);
			addLink("you", "orch", d, v);
			addLink("orch", `a:${agent}`, d, v);
			addLink(`a:${agent}`, `o:${outcome}`, d, v);
		}
		if (store.live.busy && links.has("you>orch")) links.get("you>orch").hot = true;
		// 零值的线（比如按花费看时 Codex 不报告花费）不画
		for (const [id, l] of links) if (l.value <= 0) links.delete(id);
		for (const l of links.values()) {
			nodes.get(l.from).outV += l.value;
			nodes.get(l.to).inV += l.value;
		}
		for (const [id, n] of nodes) {
			n.value = Math.max(n.inV, n.outV);
			if (n.value <= 0) nodes.delete(id);
		}
		const order = (n) =>
			n.col === 2 ? KINDS.indexOf(n.id.slice(2)) + 10 : n.col === 3 ? OUTCOMES.findIndex((o) => `o:${o.id}` === n.id) : 0;
		const list = [...nodes.values()].sort((a, b) => a.col - b.col || order(a) - order(b));
		return { nodes: list, links: [...links.values()], rows: rows.length };
	}

	// ---------------- 布局 ----------------
	layout(model, width) {
		const narrow = width < 560;
		const cols = narrow ? [1, 2, 3] : [0, 1, 2, 3];
		const nodes = model.nodes.filter((n) => cols.includes(n.col));
		const keep = new Set(nodes.map((n) => n.id));
		const links = model.links.filter((l) => keep.has(l.from) && keep.has(l.to));
		const H = narrow ? 260 : 300;
		const pad = 14;
		const nodeW = 10;
		const gap = narrow ? 12 : 16;
		const left = narrow ? 6 : 44;
		const right = narrow ? 84 : 120;
		const step = (width - left - right - nodeW) / (cols.length - 1);
		const colX = new Map(cols.map((c, i) => [c, left + i * step]));
		const byCol = new Map(cols.map((c) => [c, nodes.filter((n) => n.col === c)]));
		let k = Infinity;
		for (const list of byCol.values()) {
			if (!list.length) continue;
			const total = list.reduce((s, n) => s + n.value, 0);
			k = Math.min(k, (H - 2 * pad - gap * (list.length - 1)) / total);
		}
		for (const list of byCol.values()) {
			for (const n of list) n.h = Math.max(3, n.value * k);
			const used = list.reduce((s, n) => s + n.h, 0) + gap * Math.max(0, list.length - 1);
			let y = pad + (H - 2 * pad - used) / 2;
			for (const n of list) {
				n.x = colX.get(n.col);
				n.y = y;
				y += n.h + gap;
			}
		}
		const byId = new Map(nodes.map((n) => [n.id, n]));
		// 出线按目标的纵向顺序、入线按来源的纵向顺序堆叠，减少交叉
		const outOff = new Map();
		const inOff = new Map();
		for (const l of links.slice().sort((a, b) => byId.get(a.to).y - byId.get(b.to).y)) {
			const s = byId.get(l.from);
			l.h = Math.max(1.5, l.value * k);
			l.sy = s.y + (outOff.get(s.id) ?? 0);
			outOff.set(s.id, (outOff.get(s.id) ?? 0) + l.value * k);
		}
		for (const l of links.slice().sort((a, b) => byId.get(a.from).y - byId.get(b.from).y)) {
			const t = byId.get(l.to);
			l.ty = t.y + (inOff.get(t.id) ?? 0);
			inOff.set(t.id, (inOff.get(t.id) ?? 0) + l.value * k);
			const s = byId.get(l.from);
			const x0 = s.x + nodeW;
			const x1 = t.x;
			const xm = (x0 + x1) / 2;
			const { sy, ty, h } = l;
			l.band = `M${x0} ${sy}C${xm} ${sy} ${xm} ${ty} ${x1} ${ty}L${x1} ${ty + h}C${xm} ${ty + h} ${xm} ${sy + h} ${x0} ${sy + h}Z`;
			l.center = `M${x0} ${sy + h / 2}C${xm} ${sy + h / 2} ${xm} ${ty + h / 2} ${x1} ${ty + h / 2}`;
			l.x0 = x0;
			l.x1 = x1;
			l.fromColor = s.color;
			l.toColor = t.color;
		}
		const last = cols.at(-1);
		for (const n of nodes) {
			n.w = nodeW;
			if (n.col === cols[0] && !narrow) {
				n.lx = n.x - 8;
				n.anchor = "end";
			} else {
				n.lx = n.x + nodeW + 8;
				n.anchor = "start";
			}
			n.ly = n.y + n.h / 2;
			n.edge = n.col === last;
		}
		return { nodes, links, H, narrow };
	}

	// ---------------- 绘制 ----------------
	render(force = false) {
		const width = this.node.clientWidth;
		if (!width) return;
		const model = this.compute();
		this.model = model;
		const has = model.links.length > 0;
		this.svg.style.display = has ? "" : "none";
		this.empty.hidden = has;
		if (!has) {
			this.empty.textContent =
				model.rows === 0
					? this.range === "all"
						? "还没有派工。在终端里下发任务后，这里显示任务从总调度流向各成员、再到结果的分布。"
						: `最近 ${RANGES[this.range].label}内没有派工。`
					: "这个指标下没有数据（Codex、Gemini 不报告花费）。";
			this.signature = "";
			return;
		}
		const g = this.layout(model, width);
		const signature = `${width}|${g.narrow}|${g.nodes.map((n) => n.id).join(",")}|${g.links.map((l) => l.id).join(",")}`;
		const fmt = METRICS[this.metric].fmt;
		const label = (n) => `<tspan class="sk-name">${esc(n.label)}</tspan><tspan class="sk-val" dx="6">${esc(fmt(n.value))}</tspan>`;
		this.svg.setAttribute("aria-label", `派工流向：${g.nodes.map((n) => `${n.label} ${fmt(n.value)}`).join("，")}`);

		if (force || signature !== this.signature) {
			this.signature = signature;
			this.svg.setAttribute("viewBox", `0 0 ${width} ${g.H}`);
			this.svg.style.height = `${g.H}px`;
			const defs = g.links
				.map(
					(l) => `<linearGradient id="${this.id}-${gid(l.id)}" gradientUnits="userSpaceOnUse" x1="${l.x0}" x2="${l.x1}" y1="0" y2="0">
					<stop offset="0" style="stop-color:${l.fromColor}"/><stop offset="1" style="stop-color:${l.toColor}"/></linearGradient>`,
				)
				.join("");
			const links = g.links
				.map(
					(l) => `<g class="sk-link${l.hot ? " hot" : ""}" data-link="${esc(l.id)}">
					<path class="sk-band" style="d:path('${l.band}')" fill="url(#${this.id}-${gid(l.id)})"/>
					${reduceMotion ? "" : `<path class="sk-flow" style="d:path('${l.center}');stroke-width:${Math.max(1.2, Math.min(l.h * 0.5, 7))}px"/>`}
				</g>`,
				)
				.join("");
			const nodes = g.nodes
				.map(
					(n) => `<g class="sk-node${n.href ? " link" : ""}" data-node="${esc(n.id)}" style="--c:${n.color}">
					<rect class="sk-bar" x="${n.x}" width="${n.w}" rx="2" style="y:${n.y}px;height:${n.h}px"/>
					<text class="sk-label" x="${n.lx}" y="${n.ly}" text-anchor="${n.anchor}" dominant-baseline="middle">${label(n)}</text>
				</g>`,
				)
				.join("");
			this.svg.innerHTML = `<defs>${defs}</defs><g class="sk-links">${links}</g><g class="sk-nodes">${nodes}</g>`;
		} else {
			// 结构没变：只更新几何和状态（CSS transition 让带子平滑变化，流动动画不中断）
			for (const l of g.links) {
				const node = this.svg.querySelector(`[data-link="${CSS.escape(l.id)}"]`);
				if (!node) continue;
				node.classList.toggle("hot", l.hot);
				node.querySelector(".sk-band").style.d = `path('${l.band}')`;
				const flow = node.querySelector(".sk-flow");
				if (flow) {
					flow.style.d = `path('${l.center}')`;
					flow.style.strokeWidth = `${Math.max(1.2, Math.min(l.h * 0.5, 7))}px`;
				}
			}
			for (const n of g.nodes) {
				const node = this.svg.querySelector(`[data-node="${CSS.escape(n.id)}"]`);
				if (!node) continue;
				const bar = node.querySelector(".sk-bar");
				bar.style.y = `${n.y}px`;
				bar.style.height = `${n.h}px`;
				const text = node.querySelector(".sk-label");
				text.setAttribute("y", String(n.ly));
				text.innerHTML = label(n);
			}
		}
		this.layoutCache = g;
		if (this.hovered) this.showTip(this.hovered.kind, this.hovered.id, this.hovered.x, this.hovered.y);
	}

	// ---------------- 交互：悬停高亮 + 提示，点击跳到派工明细 ----------------
	bindEvents() {
		this.svg.addEventListener("pointermove", (e) => {
			const target = e.target instanceof Element ? e.target.closest("[data-link],[data-node]") : null;
			if (!target) return this.clearHover();
			const kind = target.hasAttribute("data-link") ? "link" : "node";
			const id = target.getAttribute(kind === "link" ? "data-link" : "data-node");
			const box = this.node.getBoundingClientRect();
			this.hovered = { kind, id, x: e.clientX - box.left, y: e.clientY - box.top };
			this.highlight(kind, id);
			this.showTip(kind, id, this.hovered.x, this.hovered.y);
		});
		this.svg.addEventListener("pointerleave", () => this.clearHover());
		this.svg.addEventListener("click", (e) => {
			const target = e.target instanceof Element ? e.target.closest("[data-link],[data-node]") : null;
			if (!target) return;
			const href = target.hasAttribute("data-node") ? this.nodeHref(target.getAttribute("data-node")) : this.linkHref(target.getAttribute("data-link"));
			if (href) location.hash = href;
		});
	}

	nodeHref(id) {
		return this.model?.nodes.find((n) => n.id === id)?.href;
	}
	linkHref(id) {
		const [from, to] = id.split(">");
		if (from.startsWith("a:") && to.startsWith("o:")) return `#/dispatches/${from.slice(2)}/${to.slice(2)}`;
		if (to.startsWith("a:")) return `#/dispatches/${to.slice(2)}`;
		return "#/dispatches";
	}

	highlight(kind, id) {
		this.svg.classList.add("focus");
		for (const node of this.svg.querySelectorAll("[data-link]")) {
			const [from, to] = node.getAttribute("data-link").split(">");
			node.classList.toggle("on", kind === "link" ? node.getAttribute("data-link") === id : from === id || to === id);
		}
		for (const node of this.svg.querySelectorAll("[data-node]")) {
			const nid = node.getAttribute("data-node");
			const [from, to] = kind === "link" ? id.split(">") : [id, id];
			node.classList.toggle("on", nid === from || nid === to);
		}
	}

	clearHover() {
		this.hovered = null;
		this.svg.classList.remove("focus");
		for (const n of this.svg.querySelectorAll(".on")) n.classList.remove("on");
		this.tip.hidden = true;
	}

	showTip(kind, id, x, y) {
		const model = this.model;
		if (!model) return;
		const fmt = METRICS[this.metric].fmt;
		let title;
		let stats;
		let value;
		let share = "";
		if (kind === "link") {
			const l = model.links.find((v) => v.id === id);
			if (!l) return;
			const from = model.nodes.find((n) => n.id === l.from);
			const to = model.nodes.find((n) => n.id === l.to);
			title = `<span style="color:${from.color}">${esc(from.label)}</span> → <span style="color:${to.color}">${esc(to.label)}</span>`;
			stats = l.stats;
			value = l.value;
			if (from.outV > 0) share = `占 ${esc(from.label)} 流出的 ${Math.round((l.value / from.outV) * 100)}%`;
		} else {
			const n = model.nodes.find((v) => v.id === id);
			if (!n) return;
			title = `<span style="color:${n.color}">${esc(n.label)}</span>`;
			stats = n.stats;
			value = n.value;
		}
		this.tip.innerHTML = `<div class="sk-tip-title">${title}</div>
			<div class="sk-tip-main">${esc(fmt(value))}<span>${esc(METRICS[this.metric].label)}</span></div>
			<div class="sk-tip-rows"><span>派工 ${stats.count} 次</span><span>耗时 ${duration(stats.time)}</span><span>花费 ${money(stats.cost)}</span>${stats.running ? `<span class="hot">执行中 ${stats.running}</span>` : ""}</div>
			${share ? `<div class="sk-tip-share">${share}</div>` : ""}
			${kind === "node" && this.nodeHref(id) ? `<div class="sk-tip-hint">点击查看这些派工 →</div>` : kind === "link" ? `<div class="sk-tip-hint">点击查看这些派工 →</div>` : ""}`;
		this.tip.hidden = false;
		const box = this.node.getBoundingClientRect();
		const tw = this.tip.offsetWidth;
		const th = this.tip.offsetHeight;
		const left = Math.min(Math.max(8, x + 14), box.width - tw - 8);
		const top = y + th + 20 > box.height ? Math.max(4, y - th - 12) : y + 16;
		this.tip.style.transform = `translate(${left}px, ${top}px)`;
	}
}

function blank() {
	return { count: 0, time: 0, cost: 0, running: 0 };
}
function tally(stats, d) {
	stats.count++;
	stats.time += elapsed(d);
	stats.cost += d.cost ?? 0;
	if (d.status === "running") stats.running++;
}
function gid(id) {
	return id.replace(/[^a-zA-Z0-9]/g, "_");
}
