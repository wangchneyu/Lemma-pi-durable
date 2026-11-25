// 派工流向图（桑基图）：总调度 → 各成员 → 结果。
// 经典桑基样式：细实色竖条做节点，名称和数值写在竖条旁边，带子是浅色半透明、彼此交叠；
// 列名放在底部。带子按成员着色，结果由右侧竖条的颜色区分。
// 只有正在执行的线路带流光；结构不变时就地更新几何，变化平滑、动画不跳。
// 自带极简布局，无依赖。
import { dispatchRows } from "./store.js";
import { slotStart } from "./ticket.js";
import { AGENT_LABEL, KINDS, agentColor, duration, el, esc, money } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const OUTCOMES = [
	{ id: "done", label: "完成", color: "var(--ok)" },
	{ id: "running", label: "执行中", color: "var(--run)" },
	{ id: "error", label: "失败", color: "var(--danger)" },
	{ id: "aborted", label: "中止", color: "var(--muted)" },
	{ id: "open", label: "无结果", color: "var(--muted)" },
];
const outcomeOf = (status) => (status === "interrupted" ? "aborted" : OUTCOMES.some((o) => o.id === status) ? status : "open");

function elapsed(d) {
	if (d.status !== "running") return d.durationMs ?? 0;
	const started = slotStart.get(d.callId);
	return started ? Date.now() - started : 0;
}

export const MODES = {
	member: { label: "按成员" },
	role: { label: "按协作角色" },
};
export const METRICS = {
	count: { label: "次数", value: () => 1, fmt: (v) => `${Math.round(v)} 次` },
	time: { label: "耗时", value: elapsed, fmt: (v) => duration(v) },
	cost: { label: "花费", value: (d) => d.cost ?? 0, fmt: (v) => money(v) },
};
const COLLAB_ROLES = [
	{ id: "exec", label: "直接执行交付", color: "var(--claude)" },
	{ id: "workflow", label: "Durable 依赖推进", color: "var(--signal)" },
	{ id: "checker", label: "独立盲审 / 复核", color: "var(--gemini)" },
	{ id: "repair", label: "集成联调修复", color: "var(--lead)" },
	{ id: "recovery", label: "受阻任务恢复", color: "var(--codex)" },
];
function roleOfDispatch(d) {
	const cid = String(d.callId ?? "");
	if (cid.startsWith("checker:")) return COLLAB_ROLES[2];
	if (cid.startsWith("integration-repair:")) return COLLAB_ROLES[3];
	if (cid.startsWith("recovery:")) return COLLAB_ROLES[4];
	if (cid.startsWith("workflow:")) return COLLAB_ROLES[1];
	return COLLAB_ROLES[0];
}
export const RANGES = {
	all: { label: "全部", ms: Infinity },
	day: { label: "24h", ms: 86_400_000 },
	hour: { label: "1h", ms: 3_600_000 },
};
const COLUMNS = [
	{ col: 1, label: "调度" },
	{ col: 2, label: "成员 / 角色" },
	{ col: 3, label: "结果" },
];

let uid = 0;

export class Sankey {
	constructor() {
		this.id = `sk${++uid}`;
		this.mode = "member";
		this.metric = "count";
		this.range = "all";
		this.node = el("div", "sankey");
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.setAttribute("class", "sk-svg");
		this.svg.setAttribute("role", "img");
		this.empty = el("div", "sk-empty");
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

	/** 给卡片头部用的摘要 */
	summary() {
		const m = this.model;
		if (!m) return null;
		const s = m.totals;
		const finished = s.done + s.error + s.aborted;
		return { total: s.count, running: s.running, rate: finished ? Math.round((s.done / finished) * 100) : null };
	}

	// ---------------- 数据 ----------------
	compute() {
		const now = Date.now();
		const window = RANGES[this.range].ms;
		const rows = dispatchRows().filter((d) => window === Infinity || !d.at || now - d.at <= window);
		const value = METRICS[this.metric].value;
		const nodes = new Map();
		const links = new Map();
		const totals = { count: 0, running: 0, done: 0, error: 0, aborted: 0 };
		const node = (id, label, color, col, href) => {
			if (!nodes.has(id)) nodes.set(id, { id, label, color, col, href, value: 0, inV: 0, outV: 0, stats: blank() });
			return nodes.get(id);
		};
		const link = (from, to, color, d, v) => {
			const id = `${from}>${to}`;
			let l = links.get(id);
			if (!l) links.set(id, (l = { id, from, to, color, value: 0, hotValue: 0, hot: false, stats: blank() }));
			l.value += v;
			tally(l.stats, d);
			if (d.status === "running") {
				l.hot = true;
				l.hotValue += v;
			}
		};
		for (const d of rows) {
			const v = value(d);
			const outcome = OUTCOMES.find((o) => o.id === outcomeOf(d.status));
			totals.count++;
			if (outcome.id === "running") totals.running++;
			else if (outcome.id === "done") totals.done++;
			else if (outcome.id === "error") totals.error++;
			else if (outcome.id === "aborted") totals.aborted++;
			const roleMode = this.mode === "role";
			const role = roleMode ? roleOfDispatch(d) : null;
			const a = roleMode ? `r:${role.id}` : `a:${d.agent}`;
			const o = `o:${outcome.id}`;
			const srcId = roleMode && ["workflow", "checker", "repair"].includes(role.id) ? "durable" : "orch";
			node(srcId, srcId === "durable" ? "Durable 自动流转" : "总调度", srcId === "durable" ? "var(--signal)" : "var(--orch)", 1, "#/dispatches");
			node(a, roleMode ? role.label : AGENT_LABEL[d.agent] ?? d.agent, roleMode ? role.color : agentColor(d.agent), 2, roleMode ? "#/dispatches" : `#/dispatches/${d.agent}`);
			node(o, outcome.label, outcome.color, 3, `#/dispatches/all/${outcome.id}`);
			for (const n of [srcId, a, o]) tally(nodes.get(n).stats, d);
			const edgeColor = roleMode ? role.color : agentColor(d.agent);
			link(srcId, a, edgeColor, d, v);
			link(a, o, edgeColor, d, v);
		}
		for (const [id, l] of links) if (l.value <= 0) links.delete(id);
		for (const l of links.values()) {
			nodes.get(l.from).outV += l.value;
			nodes.get(l.to).inV += l.value;
		}
		for (const [id, n] of nodes) {
			n.value = Math.max(n.inV, n.outV);
			if (n.value <= 0) nodes.delete(id);
		}
		const order = (n) => (n.col === 1 ? (n.id === "orch" ? 0 : 1) : n.col === 2 ? (this.mode === "role" ? COLLAB_ROLES.findIndex((r) => `r:${r.id}` === n.id) : KINDS.indexOf(n.id.slice(2))) : n.col === 3 ? OUTCOMES.findIndex((o) => `o:${o.id}` === n.id) : 0);
		const list = [...nodes.values()].sort((x, y) => x.col - y.col || order(x) - order(y));
		const grand = list.filter((n) => n.col === 1).reduce((s, n) => s + n.value, 0);
		for (const n of list) n.share = grand ? n.value / grand : 0;
		return { nodes: list, links: [...links.values()], rows: rows.length, totals };
	}

	// ---------------- 布局 ----------------
	layout(model, width) {
		const narrow = width < 620;
		const barW = narrow ? 8 : 10;
		const H = this.height ? Math.max(narrow ? 300 : 340, this.height) : narrow ? 300 : 340;
		const padT = 4;
		const padB = 30; // 底部列名
		const gap = narrow ? 14 : 18;
		const colX = new Map([
			[1, 0],
			[2, Math.round((width - barW) / 2)],
			[3, width - barW],
		]);
		const byCol = new Map(COLUMNS.map((c) => [c.col, model.nodes.filter((n) => n.col === c.col)]));
		let k = Infinity;
		for (const list of byCol.values()) {
			if (!list.length) continue;
			const total = list.reduce((s, n) => s + n.value, 0);
			k = Math.min(k, (H - padT - padB - gap * (list.length - 1)) / total);
		}
		for (const [col, list] of byCol) {
			for (const n of list) n.h = Math.max(2, n.value * k);
			const used = list.reduce((s, n) => s + n.h, 0) + gap * Math.max(0, list.length - 1);
			let y = padT + (H - padT - padB - used) / 2;
			for (const n of list) {
				n.x = colX.get(col);
				n.y = y;
				n.w = barW;
				// 前两列标签在竖条右边，最后一列在左边
				n.lx = col === 3 ? n.x - 8 : n.x + barW + 8;
				n.anchor = col === 3 ? "end" : "start";
				n.ly = n.y + n.h / 2;
				y += n.h + gap;
			}
		}
		const byId = new Map(model.nodes.map((n) => [n.id, n]));
		// 出线按目标的上下顺序、入线按来源的上下顺序堆叠，减少交叉
		const outOff = new Map();
		const inOff = new Map();
		for (const l of model.links.slice().sort((a, b) => byId.get(a.to).y - byId.get(b.to).y)) {
			l.h = Math.max(1, l.value * k);
			l.sy = byId.get(l.from).y + (outOff.get(l.from) ?? 0);
			outOff.set(l.from, (outOff.get(l.from) ?? 0) + l.value * k);
		}
		for (const l of model.links.slice().sort((a, b) => byId.get(a.from).y - byId.get(b.from).y)) {
			const s = byId.get(l.from);
			const t = byId.get(l.to);
			l.ty = t.y + (inOff.get(l.to) ?? 0);
			inOff.set(l.to, (inOff.get(l.to) ?? 0) + l.value * k);
			const x0 = s.x + s.w;
			const x1 = t.x;
			const cx = (x0 + x1) / 2;
			const { sy, ty, h } = l;
			l.band = `M${x0} ${sy}C${cx} ${sy} ${cx} ${ty} ${x1} ${ty}L${x1} ${ty + h}C${cx} ${ty + h} ${cx} ${sy + h} ${x0} ${sy + h}Z`;
		}
		const flows = [];
		const oRun = byId.get("o:running");
		if (oRun) {
			for (const mid of byCol.get(2) ?? []) {
				const outRun = model.links.find((l) => l.from === mid.id && l.to === "o:running");
				if (!outRun) continue;
				const hotIns = model.links
					.filter((l) => l.to === mid.id && l.hotValue > 0)
					.sort((a, b) => byId.get(a.from).y - byId.get(b.from).y);
				if (!hotIns.length) continue;
				const totalHot = hotIns.reduce((s, l) => s + l.hotValue, 0);
				let syOff = 0;
				let tyOff = 0;
				for (const inL of hotIns) {
					const share = totalHot > 0 ? inL.hotValue / totalHot : 1 / hotIns.length;
					const sliceH = outRun.h * share;
					const yMidOut = outRun.sy + syOff + sliceH / 2;
					const yEnd = outRun.ty + tyOff + sliceH / 2;
					syOff += sliceH;
					tyOff += sliceH;
					const src = byId.get(inL.from);
					const padIn = Math.min(inL.h * 0.25, 2);
					const yMidIn = Math.max(inL.ty + padIn, Math.min(inL.ty + inL.h - padIn, yMidOut));
					const ratio = inL.h > 0 ? (yMidIn - inL.ty) / inL.h : 0.5;
					const yStart = inL.sy + ratio * inL.h;
					const x0 = src.x + src.w;
					const x1 = mid.x;
					const x2 = mid.x + mid.w;
					const x3 = oRun.x;
					const cx01 = (x0 + x1) / 2;
					const cx23 = (x2 + x3) / 2;
					const bridge =
						Math.abs(yMidIn - yMidOut) < 0.25
							? `L${x2} ${yMidOut}`
							: `C${(x1 + x2) / 2} ${yMidIn} ${(x1 + x2) / 2} ${yMidOut} ${x2} ${yMidOut}`;
					const path = `M${x0} ${yStart}C${cx01} ${yStart} ${cx01} ${yMidIn} ${x1} ${yMidIn}${bridge}C${cx23} ${yMidOut} ${cx23} ${yEnd} ${x3} ${yEnd}`;
					const w = Math.max(1.5, Math.min(sliceH * 0.32, inL.h * 0.32, 3.5));
					flows.push({ id: `${inL.from}>${mid.id}>o:running`, from: inL.from, mid: mid.id, to: "o:running", color: inL.color, path, w });
				}
			}
		}
		const axis = [
			{ label: COLUMNS[0].label, x: 0, anchor: "start" },
			{ label: COLUMNS[1].label, x: colX.get(2) + barW / 2, anchor: "middle" },
			{ label: COLUMNS[2].label, x: width, anchor: "end" },
		];
		return { nodes: model.nodes, links: model.links, flows, H, narrow, axis };
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
			this.signature = "";
			this.empty.innerHTML =
				model.rows === 0
					? this.range === "all"
						? `<strong>还没有派工</strong><span>在终端里下发任务后，这里显示任务从总调度流向各成员、再到结果的分布。</span>`
						: `<strong>最近 ${RANGES[this.range].label} 没有派工</strong><span>切换到"全部"查看完整历史。</span>`
					: `<strong>这个指标下没有数据</strong><span>只有 Claude 会报告花费，Codex、Gemini 不报告。</span>`;
			return;
		}
		const g = this.layout(model, width);
		const fmt = METRICS[this.metric].fmt;
		// 执行中的连续流线跨越中间列，因此活动链路集合也是结构的一部分
		const signature = `${width}x${g.H}|${g.nodes.map((n) => n.id).join(",")}|${g.links.map((l) => `${l.id}${l.hot ? "*" : ""}`).join(",")}|${g.flows.map((f) => f.id).join(",")}`;
		this.svg.setAttribute("aria-label", `派工流向：${g.nodes.map((n) => `${n.label} ${fmt(n.value)}`).join("，")}`);

		if (force || signature !== this.signature) {
			this.signature = signature;
			this.svg.setAttribute("viewBox", `0 0 ${width} ${g.H}`);
			this.svg.style.height = `${g.H}px`;
			const links = g.links
				.map(
					(l) => `<g class="sk-link${l.hot ? " hot" : ""}" data-link="${esc(l.id)}" style="--c:${l.color}">
						<path class="sk-band" style="d:path('${l.band}')"/>
					</g>`,
				)
				.join("");
			const nodes = g.nodes
				.map(
					(n) => `<g class="sk-node${n.href ? " link" : ""}${n.stats.running ? " hot" : ""}" data-node="${esc(n.id)}" style="--c:${n.color}">
						<rect class="sk-bar" x="${n.x}" width="${n.w}" rx="1.5" style="y:${n.y}px;height:${n.h}px"/>
					</g>`,
				)
				.join("");
			const flows = g.flows
				.map(
					(f) => `<g class="sk-flow-wrap" data-flow="${esc(f.id)}" data-from="${esc(f.from)}" data-mid="${esc(f.mid)}" data-to="${esc(f.to)}" style="--c:${f.color}">
						<path class="sk-flow-track" style="d:path('${f.path}')"/>
						${!reduceMotion ? `<path class="sk-flow" style="d:path('${f.path}');stroke-width:${f.w}px"/>` : ""}
					</g>`,
				)
				.join("");
			const labels = g.nodes
				.map(
					(n) => `<text class="sk-label" data-label="${esc(n.id)}" x="${n.lx}" y="0" text-anchor="${n.anchor}" dominant-baseline="central" style="transform:translateY(${n.ly}px)"><tspan class="sk-name">${esc(n.label)}</tspan><tspan class="sk-val" dx="6">${esc(fmt(n.value))}</tspan></text>`,
				)
				.join("");
			const axis = g.axis.map((a) => `<text class="sk-axis" x="${a.x}" y="${g.H - 6}" text-anchor="${a.anchor}">${a.label}</text>`).join("");
			this.svg.innerHTML = `<g class="sk-links">${links}</g><g class="sk-nodes">${nodes}</g><g class="sk-flows">${flows}</g><g class="sk-labels">${labels}</g>${axis}`;
		} else {
			// 结构没变：只更新几何和数值（CSS transition 让变化平滑，流光动画不中断）
			for (const l of g.links) {
				const node = this.svg.querySelector(`[data-link="${CSS.escape(l.id)}"]`);
				if (!node) continue;
				node.querySelector(".sk-band").style.d = `path('${l.band}')`;
			}
			for (const f of g.flows) {
				const wrap = this.svg.querySelector(`[data-flow="${CSS.escape(f.id)}"]`);
				if (!wrap) continue;
				const track = wrap.querySelector(".sk-flow-track");
				if (track) track.style.d = `path('${f.path}')`;
				const flow = wrap.querySelector(".sk-flow");
				if (flow) {
					flow.style.d = `path('${f.path}')`;
					flow.style.strokeWidth = `${f.w}px`;
				}
			}
			for (const n of g.nodes) {
				const node = this.svg.querySelector(`[data-node="${CSS.escape(n.id)}"]`);
				if (!node) continue;
				node.classList.toggle("hot", n.stats.running > 0);
				const bar = node.querySelector(".sk-bar");
				bar.style.y = `${n.y}px`;
				bar.style.height = `${n.h}px`;
				const label = this.svg.querySelector(`[data-label="${CSS.escape(n.id)}"]`);
				if (label) {
					label.style.transform = `translateY(${n.ly}px)`;
					label.querySelector(".sk-val").textContent = fmt(n.value);
				}
			}
		}
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
		const ends = kind === "link" ? id.split(">") : [id];
		for (const node of this.svg.querySelectorAll("[data-link]")) {
			const lid = node.getAttribute("data-link");
			const [from, to] = lid.split(">");
			node.classList.toggle("on", kind === "link" ? lid === id : from === id || to === id);
		}
		for (const node of this.svg.querySelectorAll("[data-node]")) {
			const nid = node.getAttribute("data-node");
			const linked = kind === "node" && this.model.links.some((l) => (l.from === id && l.to === nid) || (l.to === id && l.from === nid));
			const on = ends.includes(nid) || linked;
			node.classList.toggle("on", on);
			this.svg.querySelector(`[data-label="${CSS.escape(nid)}"]`)?.classList.toggle("on", on);
		}
		for (const flow of this.svg.querySelectorAll("[data-flow]")) {
			const from = flow.getAttribute("data-from");
			const mid = flow.getAttribute("data-mid");
			const to = flow.getAttribute("data-to");
			const on = kind === "link" ? `${from}>${mid}` === id || `${mid}>${to}` === id : from === id || mid === id || to === id;
			flow.classList.toggle("on", on);
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
			if (!l) return this.clearHover();
			const from = model.nodes.find((n) => n.id === l.from);
			const to = model.nodes.find((n) => n.id === l.to);
			title = `<i style="background:${from.color}"></i>${esc(from.label)}<span class="arrow">→</span><i style="background:${to.color}"></i>${esc(to.label)}`;
			stats = l.stats;
			value = l.value;
			if (from.outV > 0) share = `占 ${esc(from.label)} 的 ${Math.round((l.value / from.outV) * 100)}%`;
		} else {
			const n = model.nodes.find((v) => v.id === id);
			if (!n) return this.clearHover();
			title = `<i style="background:${n.color}"></i>${esc(n.label)}`;
			stats = n.stats;
			value = n.value;
			share = `占全部的 ${Math.round(n.share * 100)}%`;
		}
		const avg = stats.timed ? duration(stats.time / stats.timed) : "—";
		this.tip.innerHTML = `<div class="sk-tip-title">${title}</div>
			<div class="sk-tip-main">${esc(fmt(value))}<span>${esc(share)}</span></div>
			<dl class="sk-tip-grid">
				<dt>派工</dt><dd>${stats.count} 次</dd>
				<dt>平均耗时</dt><dd>${avg}</dd>
				<dt>花费</dt><dd>${money(stats.cost)}</dd>
				${stats.running ? `<dt>执行中</dt><dd class="hot">${stats.running}</dd>` : ""}
			</dl>
			<div class="sk-tip-hint">点击查看这些派工</div>`;
		this.tip.hidden = false;
		const box = this.node.getBoundingClientRect();
		const tw = this.tip.offsetWidth;
		const th = this.tip.offsetHeight;
		const left = Math.min(Math.max(4, x + 16), box.width - tw - 4);
		const top = y + th + 24 > box.height ? Math.max(0, y - th - 14) : y + 18;
		this.tip.style.transform = `translate(${left}px, ${top}px)`;
	}
}

function blank() {
	return { count: 0, time: 0, timed: 0, cost: 0, running: 0 };
}
function tally(stats, d) {
	stats.count++;
	const t = elapsed(d);
	if (t > 0) {
		stats.time += t;
		stats.timed++;
	}
	stats.cost += d.cost ?? 0;
	if (d.status === "running") stats.running++;
}
