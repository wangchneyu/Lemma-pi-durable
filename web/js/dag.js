// 多 Agent 协作结构可视化：L0/L1/L2 自适应拓扑 DAG、Path Scope 隔离矩阵、Maker-Checker 盲审返工环。
import { openDispatch } from "./drawer.js";
import { AGENT_LABEL, agentColor, clipDisplay, esc, short } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const TASK_STATUS_LABEL = {
	todo: "待执行",
	doing: "进行中",
	review: "待验收",
	blocked: "受阻",
	done: "已完成",
	dropped: "已取消",
};
const taskStatusText = (status) => TASK_STATUS_LABEL[status] ?? status ?? "未知";
const textVisualPx = (str, widePx = 11, asciiPx = 6.6) => {
	let w = 0;
	for (const ch of String(str ?? "")) w += ch.charCodeAt(0) > 0x7f ? widePx : asciiPx;
	return w;
};

function svg(tag, attrs = {}, text) {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
	if (text !== undefined) el.textContent = text;
	return el;
}

/** 识别当前分工表所属自适应协作拓扑层级（L0 / L1 / L2） */
export function classifyTopology(tasks = [], integrations = []) {
	const active = tasks.filter((t) => t.status !== "dropped");
	if (!active.length) return { tier: "L0", title: "等待规划", detail: "总调度拆解分工表后自动识别 L0/L1/L2 协作拓扑" };
	const hasDeps = active.some((t) => t.deps?.length > 0);
	const hasScope = active.some((t) => t.scope && (t.scope.allow?.length || t.scope.forbid?.length));
	const hasInt = active.some((t) => t.integrationId) || integrations.length > 0;
	const hasBlind = active.some((t) => t.reviewer?.blind);
	const hasReview = active.some((t) => !!t.reviewer);
	const parallelCount = active.filter((t) => t.status === "doing").length;

	if (hasDeps || hasScope || hasInt) {
		return {
			tier: "L2",
			title: "L2 · 契约并行集成",
			detail: [
				hasDeps ? "DAG 依赖编排" : "",
				hasScope ? "Path Scope 路径隔离" : "",
				hasBlind ? "代码盲审" : hasReview ? "独立复核" : "",
				hasInt ? `${integrations.length || 1} 项联合集成` : "",
			].filter(Boolean).join(" · "),
		};
	}
	if (hasReview) {
		return {
			tier: "L1",
			title: hasBlind ? "L1 · 异构盲审 (Blind Maker-Checker)" : "L1 · 独立复核 (Maker-Checker)",
			detail: `任务 ${active.length} 项 · ${hasBlind ? "剥离执行者自述，仅审需求与 git_diff" : "独立只读复核"}${parallelCount > 1 ? ` · ${parallelCount} 路并行` : ""}`,
		};
	}
	return {
		tier: "L0",
		title: "L0 · 单成员直派",
		detail: `任务 ${active.length} 项 · 轻量任务快速直连${parallelCount > 1 ? ` · ${parallelCount} 路并行` : ""}`,
	};
}

/** 检测两个相对路径前缀是否可能重叠 */
function prefixOverlaps(a, b) {
	const norm = (s) => String(s ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const x = norm(a);
	const y = norm(b);
	if (!x || !y) return false;
	return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

export function findScopeOverlaps(tasks = []) {
	const scoped = tasks.filter((t) => t.status !== "dropped" && t.status !== "done" && t.scope?.allow?.length);
	const warnings = [];
	for (let i = 0; i < scoped.length; i++) {
		for (let j = i + 1; j < scoped.length; j++) {
			const a = scoped[i];
			const b = scoped[j];
			// 若存在先后硬依赖，则不是并行写同一区域
			if (a.deps?.includes(b.id) || b.deps?.includes(a.id)) continue;
			const hits = [];
			for (const pa of a.scope.allow) {
				for (const pb of b.scope.allow) {
					if (prefixOverlaps(pa, pb)) hits.push(`${pa} ↔ ${pb}`);
				}
			}
			if (hits.length) warnings.push({ a: a.id, b: b.id, hits });
		}
	}
	return warnings;
}

/** 渲染 L0/L1/L2 任务依赖 DAG 图（含 Maker-Checker 环徽标与集成节点） */
export function renderTaskDag(container, { tasks = [], integrations = [], readinessMap, onSelectTask } = {}) {
	const active = tasks.filter((t) => t.status !== "dropped");
	if (!active.length) {
		container.innerHTML = `<div class="empty-inline"><span class="dot"></span>当前没有任务节点；总调度通过 <code>plan_tasks</code> 创建分工表后，这里会生成依赖 DAG 与拓扑层级图。</div>`;
		return;
	}
	const byId = new Map(active.map((t) => [t.id, t]));
	const depthCache = new Map();
	const visiting = new Set();
	const depthOf = (id) => {
		if (depthCache.has(id)) return depthCache.get(id);
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const t = byId.get(id);
		let d = 0;
		for (const dep of t?.deps ?? []) {
			if (byId.has(dep)) d = Math.max(d, depthOf(dep) + 1);
		}
		visiting.delete(id);
		depthCache.set(id, d);
		return d;
	};
	for (const t of active) depthOf(t.id);

	// 将活跃联合集成（且其 source 命中当前任务改动）挂到 DAG 最右侧一列
	const intNodes = integrations
		.filter((it) => !it.supersededBy && it.changeStatus !== "dropped")
		.slice(0, 6)
		.map((it) => {
			const sourceChangeIds = new Set((it.sources ?? []).map((s) => s.id));
			const upstreamTasks = active.filter((t) => (t.changes ?? []).some((cid) => sourceChangeIds.has(cid)) || t.integrationId === it.id);
			return { it, upstreamIds: upstreamTasks.map((t) => t.id) };
		});

	const maxTaskDepth = Math.max(0, ...active.map((t) => depthCache.get(t.id) ?? 0));
	const totalCols = maxTaskDepth + 1 + (intNodes.length ? 1 : 0);
	const cols = Array.from({ length: totalCols }, () => []);
	for (const t of active) cols[depthCache.get(t.id) ?? 0].push({ kind: "task", id: t.id, data: t });
	if (intNodes.length) {
		for (const entry of intNodes) cols[totalCols - 1].push({ kind: "integration", id: `int:${entry.it.id}`, data: entry.it, upstreamIds: entry.upstreamIds });
	}

	const NODE_W = 236;
	const NODE_H = 96;
	const COL_GAP = 82;
	const ROW_GAP = 24;
	const PAD_X = 24;
	const PAD_TOP = 64;
	const PAD_BOTTOM = 24;
	const maxRows = Math.max(1, ...cols.map((c) => c.length));
	const width = Math.max(620, PAD_X * 2 + totalCols * NODE_W + Math.max(0, totalCols - 1) * COL_GAP);
	const height = Math.max(228, PAD_TOP + PAD_BOTTOM + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP);

	const pos = new Map();
	for (let c = 0; c < cols.length; c++) {
		const list = cols[c];
		const colH = list.length * NODE_H + Math.max(0, list.length - 1) * ROW_GAP;
		const startY = PAD_TOP + (height - PAD_TOP - PAD_BOTTOM - colH) / 2;
		const x = PAD_X + c * (NODE_W + COL_GAP);
		list.forEach((node, r) => {
			pos.set(node.id, { x, y: startY + r * (NODE_H + ROW_GAP), col: c, row: r, node });
		});
	}

	// 汇总所有边，区分相邻列与跨列绕行，并为每个节点的出入端口按相对高低排序
	const rawEdges = [];
	for (const t of active) {
		if (!pos.has(t.id)) continue;
		for (const dep of t.deps ?? []) {
			if (!pos.has(dep)) continue;
			const src = byId.get(dep);
			const activeFlow = src?.status === "done" && (t.status === "doing" || t.status === "review");
			rawEdges.push({ fromId: dep, toId: t.id, kind: src?.status === "done" ? "done" : "wait", active: activeFlow });
		}
	}
	for (const entry of intNodes) {
		const iid = `int:${entry.it.id}`;
		if (!pos.has(iid)) continue;
		const sources = entry.upstreamIds.length ? entry.upstreamIds : cols[Math.max(0, totalCols - 2)]?.map((n) => n.id) ?? [];
		for (const upId of sources) if (pos.has(upId)) rawEdges.push({ fromId: upId, toId: iid, kind: "int", active: false });
	}

	// 为跨列边（col2 - col1 > 1）分配避开中间列节点的顶部/底部平滑走廊
	let topDetours = 0;
	let botDetours = 0;
	const colBounds = cols.map((list) => {
		const boxes = list.map((n) => pos.get(n.id)).filter(Boolean);
		return boxes.length
			? { minY: Math.min(...boxes.map((b) => b.y)), maxY: Math.max(...boxes.map((b) => b.y + NODE_H)) }
			: { minY: PAD_TOP + NODE_H, maxY: height - PAD_BOTTOM };
	});
	for (const e of rawEdges) {
		const f = pos.get(e.fromId);
		const t = pos.get(e.toId);
		if (t.col - f.col > 1) {
			let obsTop = Infinity;
			let obsBot = -Infinity;
			for (let c = f.col + 1; c < t.col; c++) {
				obsTop = Math.min(obsTop, colBounds[c].minY);
				obsBot = Math.max(obsBot, colBounds[c].maxY);
			}
			const midY = (f.y + t.y + NODE_H) / 2;
			const topCandidate = obsTop - 28 - topDetours * 14;
			const botCandidate = obsBot + 28 + botDetours * 14;
			const goTop = Math.abs(midY - topCandidate) <= Math.abs(midY - botCandidate);
			if (goTop) {
				topDetours++;
				e.corridorY = topCandidate;
			} else {
				botDetours++;
				e.corridorY = botCandidate;
			}
		}
	}

	// 若走廊超出画布上下沿，整体微调画布扩展留白
	const minNeededY = Math.min(PAD_TOP, ...rawEdges.map((e) => (e.corridorY !== undefined ? e.corridorY - 16 : Infinity)));
	const extraTop = minNeededY < 48 ? 48 - minNeededY : 0;
	const maxNeededY = Math.max(height, ...rawEdges.map((e) => (e.corridorY !== undefined ? e.corridorY + 20 : 0)));
	const finalH = maxNeededY + extraTop;
	if (extraTop > 0) {
		for (const p of pos.values()) p.y += extraTop;
		for (const e of rawEdges) if (e.corridorY !== undefined) e.corridorY += extraTop;
	}

	// 双端端口排序错位：留足间距避免入口箭头拥挤
	const outMap = new Map();
	const inMap = new Map();
	for (const e of rawEdges) {
		(outMap.get(e.fromId) ?? outMap.set(e.fromId, []).get(e.fromId)).push(e);
		(inMap.get(e.toId) ?? inMap.set(e.toId, []).get(e.toId)).push(e);
	}
	const portOffset = (idx, total) => {
		if (total <= 1) return 0;
		const span = Math.min(44, (total - 1) * 18);
		return -span / 2 + (span * idx) / (total - 1);
	};
	for (const [id, list] of outMap) {
		list.sort((a, b) => (a.corridorY ?? pos.get(a.toId).y + NODE_H / 2) - (b.corridorY ?? pos.get(b.toId).y + NODE_H / 2));
		list.forEach((e, i) => { e.y1 = pos.get(id).y + NODE_H / 2 + portOffset(i, list.length); });
	}
	for (const [id, list] of inMap) {
		list.sort((a, b) => (a.corridorY ?? pos.get(a.fromId).y + NODE_H / 2) - (b.corridorY ?? pos.get(b.fromId).y + NODE_H / 2));
		list.forEach((e, i) => { e.y2 = pos.get(id).y + NODE_H / 2 + portOffset(i, list.length); });
	}

	/** 与相邻连线一致的丝滑 S 形跨列曲线：沿间隙平滑抬升、水平掠过中间列、平滑落回目标端口 */
	function detourPath(x1, y1, laneY, x2, y2, fromColRight, toColLeft) {
		const liftX = fromColRight + COL_GAP * 0.66;
		const dropX = toColLeft - COL_GAP * 0.66;
		const c1 = Math.max(14, (liftX - x1) * 0.48);
		const c2 = Math.max(14, (x2 - dropX) * 0.48);
		return [
			`M${x1},${y1}`,
			`C${x1 + c1},${y1} ${liftX - c1},${laneY} ${liftX},${laneY}`,
			`L${dropX},${laneY}`,
			`C${dropX + c2},${laneY} ${x2 - c2},${y2} ${x2},${y2}`,
		].join(" ");
	}

	const s = svg("svg", {
		class: "dag-svg",
		viewBox: `0 0 ${width} ${finalH}`,
		width,
		height: finalH,
		style: `min-width: min(100%, ${Math.min(width, 760)}px)`,
		role: "img",
		"aria-label": "任务依赖 DAG 图",
	});
	const defs = svg("defs");
	const mkMarker = (id, cls) => {
		const m = svg("marker", { id, viewBox: "0 0 10 10", refX: 8.6, refY: 5, markerWidth: 5.2, markerHeight: 5.2, orient: "auto" });
		m.append(svg("path", { d: "M1.6,2.2 L8.6,5 L1.6,7.8 L3.4,5 z", class: cls }));
		return m;
	};
	defs.append(mkMarker("dagArrowDone", "dag-arrow-done"), mkMarker("dagArrowWait", "dag-arrow-wait"), mkMarker("dagArrowInt", "dag-arrow-int"));
	s.append(defs);

	// 阶段泳道底板与居中胶囊阶段徽标
	const lanesG = svg("g", { class: "dag-lanes" });
	const laneTop = 44;
	const laneH = Math.max(NODE_H + 24, finalH - laneTop - 10);
	for (let c = 0; c < cols.length; c++) {
		const x = PAD_X + c * (NODE_W + COL_GAP);
		lanesG.append(svg("rect", { x: x - 10, y: laneTop, width: NODE_W + 20, height: laneH, rx: 14, class: "dag-lane" }));
		const label = intNodes.length && c === cols.length - 1 ? "联合集成" : c === 0 ? "起点 · 契约" : `阶段 ${c + 1}`;
		const pw = Math.max(76, Math.round(textVisualPx(label, 11.5, 7) + 24));
		const px = x + (NODE_W - pw) / 2;
		lanesG.append(svg("rect", { x: px, y: 12, width: pw, height: 22, rx: 11, class: "dag-col-pill" }));
		lanesG.append(svg("text", { x: x + NODE_W / 2, y: 23.5, class: "dag-col-label", "text-anchor": "middle", "dominant-baseline": "central" }, label));
	}
	s.append(lanesG);

	// 连线层（先画跨列平滑曲线，再画相邻 S 曲线；通向进行中节点的已完成边附带微流光）
	const edgesG = svg("g", { class: "dag-edges" });
	const sortedEdges = [...rawEdges].sort((a, b) => Number(a.corridorY === undefined) - Number(b.corridorY === undefined));
	for (const e of sortedEdges) {
		const from = pos.get(e.fromId);
		const to = pos.get(e.toId);
		const x1 = from.x + NODE_W + 1;
		const x2 = to.x - 2.5;
		let d;
		if (e.corridorY !== undefined) {
			d = detourPath(x1, e.y1, e.corridorY, x2, e.y2, from.x + NODE_W, to.x);
		} else {
			const dx = Math.max(30, (x2 - x1) * 0.5);
			d = `M${x1},${e.y1} C${x1 + dx},${e.y1} ${x2 - dx},${e.y2} ${x2},${e.y2}`;
		}
		const marker = e.kind === "done" ? "url(#dagArrowDone)" : e.kind === "int" ? "url(#dagArrowInt)" : "url(#dagArrowWait)";
		edgesG.append(svg("path", {
			d,
			class: `dag-edge ${e.kind}${e.corridorY !== undefined ? " detour" : ""}${e.active ? " active" : ""}`,
			"data-from": e.fromId,
			"data-to": e.toId,
			"marker-end": marker,
		}));
		if (e.active) {
			edgesG.append(svg("path", {
				d,
				class: "dag-edge-pulse",
				"data-from": e.fromId,
				"data-to": e.toId,
			}));
		}
	}
	s.append(edgesG);

	// 节点层（现代卡片、状态胶囊、成员色点与平滑端口联动）
	const nodesG = svg("g", { class: "dag-nodes" });
	let clipIdx = 0;
	for (const { x, y, node } of pos.values()) {
		const clipId = `dagClip-${++clipIdx}`;
		const cp = svg("clipPath", { id: clipId });
		cp.append(svg("rect", { x: x + 10, y: y + 4, width: NODE_W - 20, height: NODE_H - 8, rx: 8 }));
		defs.append(cp);

		const attachHover = (g, nid) => {
			g.addEventListener("pointerenter", () => {
				s.classList.add("dag-hover");
				const neighbors = new Set([nid]);
				for (const p of edgesG.children) {
					const pf = p.getAttribute("data-from");
					const pt = p.getAttribute("data-to");
					const match = pf === nid || pt === nid;
					p.classList.toggle("hi", match);
					if (match) { neighbors.add(pf); neighbors.add(pt); }
				}
				for (const nEl of nodesG.children) nEl.classList.toggle("hi-node", neighbors.has(nEl.getAttribute("data-nid")));
			});
			g.addEventListener("pointerleave", () => {
				s.classList.remove("dag-hover");
				for (const p of edgesG.children) p.classList.remove("hi");
				for (const nEl of nodesG.children) nEl.classList.remove("hi-node");
			});
		};
		const renderOriginPorts = (g, nid) => {
			for (const e of outMap.get(nid) ?? []) g.append(svg("circle", { cx: x + NODE_W, cy: e.y1, r: 2.3, class: `dag-port out ${e.kind}` }));
		};
		const renderStatusPill = (parent, label, pillCls) => {
			const pw = Math.max(48, Math.round(textVisualPx(label, 10.5, 6.4) + 25));
			const px = x + NODE_W - 12 - pw;
			const py = y + 12;
			const pg = svg("g", { class: `dag-pill ${pillCls}` });
			pg.append(svg("rect", { x: px, y: py, width: pw, height: 20, rx: 10, class: "pill-bg" }));
			pg.append(svg("circle", { cx: px + 9, cy: py + 10, r: 2.6, class: "pill-dot" }));
			pg.append(svg("text", { x: px + 15 + (pw - 21) / 2, y: py + 10.2, class: "nstat", "text-anchor": "middle", "dominant-baseline": "central" }, label));
			parent.append(pg);
			return pw;
		};

		if (node.kind === "integration") {
			const it = node.data;
			const st = it.status ?? it.changeStatus;
			const ok = st === "passed" || it.changeStatus === "applied";
			const fail = st === "conflict" || st === "failed";
			const pillCls = ok ? "s-done" : fail ? "s-blocked" : "s-doing";
			const pillText = it.changeStatus === "applied" ? "已合并" : ok ? "通过" : fail ? "需处理" : "检查中";
			const g = svg("g", { class: `dag-node integration ${pillCls}`, "data-nid": node.id, tabindex: 0 });
			g.append(svg("rect", { x, y, width: NODE_W, height: NODE_H, rx: 12, class: "box" }));
			const content = svg("g", { "clip-path": `url(#${clipId})` });
			content.append(svg("circle", { cx: x + 17, cy: y + 22, r: 3.8, class: "owner-dot int" }));
			content.append(svg("text", { x: x + 26, y: y + 22.2, class: "nid", "dominant-baseline": "central" }, clipDisplay(`集成 #${it.id}`, 14)));
			renderStatusPill(content, pillText, pillCls);
			content.append(svg("text", { x: x + 13, y: y + 49, class: "ntitle", "dominant-baseline": "central" }, clipDisplay((it.sources ?? []).map((src) => `#${src.id}`).join(" + ") || it.task, 27)));
			content.append(svg("line", { x1: x + 13, y1: y + 66, x2: x + NODE_W - 13, y2: y + 66, class: "card-sep" }));
			content.append(svg("text", { x: x + 13, y: y + 81, class: "nmeta", "dominant-baseline": "central" }, clipDisplay(`联合检查 ${it.passed ?? 0}/${it.total ?? 0}${it.conflicts?.length ? ` · 冲突 ${it.conflicts.length}` : ""}`, 32)));
			g.append(content);
			renderOriginPorts(g, node.id);
			attachHover(g, node.id);
			g.addEventListener("click", () => { location.hash = `#/changes/${encodeURIComponent(it.id)}`; });
			nodesG.append(g);
			continue;
		}
		const t = node.data;
		const readiness = readinessMap?.get(t.id);
		const color = t.owner ? agentColor(t.owner) : "var(--orch)";
		const g = svg("g", { class: `dag-node s-${t.status}`, "data-nid": t.id, style: `--c:${color}`, tabindex: 0 });
		g.append(svg("rect", { x, y, width: NODE_W, height: NODE_H, rx: 12, class: "box" }));
		if (t.status === "doing" || t.status === "review") {
			g.append(svg("rect", { x: x + 16, y: y + 0.5, width: NODE_W - 32, height: 2.2, rx: 1.1, class: "top-glow" }));
		}
		const content = svg("g", { "clip-path": `url(#${clipId})` });
		content.append(svg("circle", { cx: x + 17, cy: y + 22, r: 3.8, class: "owner-dot" }));
		content.append(svg("text", { x: x + 26, y: y + 22.2, class: "nid", "dominant-baseline": "central" }, clipDisplay(`${t.id}${t.automation ? " ⚡" : ""}`, 14)));
		renderStatusPill(content, taskStatusText(t.status), `s-${t.status}`);
		content.append(svg("text", { x: x + 13, y: y + 49, class: "ntitle", "dominant-baseline": "central" }, clipDisplay(t.title, 28)));
		content.append(svg("line", { x1: x + 13, y1: y + 66, x2: x + NODE_W - 13, y2: y + 66, class: "card-sep" }));
		const scopeTag = t.scope?.allow?.length ? `🔒 ${t.scope.allow[0]}` : "";
		const ownerLabel = t.owner ? AGENT_LABEL[t.owner] ?? t.owner : "未指派";
		const revTag = t.reviewer ? ` · 🔎${t.reviewer.blind ? "盲审" : "复核"}${t.checksByMember?.length ? `×${t.checksByMember.length}` : ""}` : "";
		const waitHint = t.status === "todo" && readiness && !readiness.ready ? " · 等待前置" : "";
		content.append(svg("text", { x: x + 13, y: y + 81, class: "nmeta", "dominant-baseline": "central" }, clipDisplay(`${ownerLabel}${revTag}${scopeTag ? ` · ${scopeTag}` : ""}${waitHint}`, 29)));
		g.append(content);
		renderOriginPorts(g, t.id);
		attachHover(g, t.id);
		g.append(svg("title", {}, `${t.id}: ${t.title}\n状态: ${taskStatusText(t.status)}${t.scope ? `\n路径契约: allow=${(t.scope.allow ?? []).join(",")} forbid=${(t.scope.forbid ?? []).join(",")}` : ""}`));
		g.addEventListener("click", () => onSelectTask?.(t));
		nodesG.append(g);
	}
	s.append(nodesG);
	const legend = document.createElement("div");
	legend.className = "dag-legend";
	legend.innerHTML = `<span><i class="dl done"></i>已完成传递</span><span><i class="dl wait"></i>待前置完成</span><span><i class="dl int"></i>联合集成汇流</span><span class="muted">悬停节点高亮上下游与相邻节点</span>`;
	container.replaceChildren(s, legend);
}

/** 渲染 Path Scope 路径契约隔离矩阵 */
export function renderScopeMatrix(tasks = []) {
	const scoped = tasks.filter((t) => t.status !== "dropped" && t.scope && (t.scope.allow?.length || t.scope.forbid?.length));
	if (!scoped.length) return "";
	const overlaps = findScopeOverlaps(tasks);
	return `
		<section class="card">
			<header class="card-head">
				<div class="card-heading">
					<h2 class="card-title">路径契约与写入隔离矩阵（Scope Guard）</h2>
					<div class="card-sub">硬性路径边界防止并行写冲突与测试篡改 · ${scoped.length} 项任务已锁定写域${overlaps.length ? ` · <span class="err-t">发现 ${overlaps.length} 组潜在路径重叠</span>` : " · 无并行写入重叠"}</div>
				</div>
			</header>
			${overlaps.length ? `<div class="scope-warn">${overlaps.map((w) => `<p>⚠ 并行任务 <code>${esc(w.a)}</code> 与 <code>${esc(w.b)}</code> 允许写域重叠：<code>${esc(w.hits.join("、"))}</code></p>`).join("")}</div>` : ""}
			<div class="table-wrap"><table class="table">
				<thead><tr><th>任务</th><th>状态</th><th>执行者</th><th>允许写入 (Allow)</th><th>严禁修改 (Forbid)</th></tr></thead>
				<tbody>${scoped.map((t) => `<tr>
					<td class="mono nowrap">${esc(t.id)}</td>
					<td><span class="pill" data-s="${t.status === "done" ? "done" : t.status === "doing" || t.status === "review" ? "running" : t.status === "blocked" ? "error" : "aborted"}">${esc(taskStatusText(t.status))}</span></td>
					<td>${t.owner ? esc(AGENT_LABEL[t.owner] ?? t.owner) : "—"}</td>
					<td>${(t.scope.allow ?? []).map((p) => `<code class="scope-allow">${esc(p)}</code>`).join(" ") || `<span class="muted">不限</span>`}</td>
					<td>${(t.scope.forbid ?? []).map((p) => `<code class="scope-forbid">${esc(p)}</code>`).join(" ") || `<span class="muted">无</span>`}</td>
				</tr>`).join("")}</tbody>
			</table></div>
		</section>`;
}

/** 渲染独立盲审与返工循环面板 */
export function renderReviewLoopPanel(tasks = [], dispatches = []) {
	const reviewed = tasks.filter((t) => t.status !== "dropped" && (t.reviewer || t.verification || t.checksByMember?.length));
	if (!reviewed.length) return "";
	const dispatchByJob = new Map(dispatches.filter((d) => d.job).map((d) => [d.job, d]));
	return `
		<section class="card">
			<header class="card-head">
				<div class="card-heading">
					<h2 class="card-title">独立复核与盲审返工环（Maker-Checker-Rework）</h2>
					<div class="card-sub">执行者交付后先过机器检查，再交只读复核成员独立裁决；开启 <code>blind</code> 时自动剥离执行者话术，仅看契约与 <code>git_diff</code></div>
				</div>
			</header>
			<div class="card-body review-loop-list">
				${reviewed.map((t) => {
					const checks = t.checksByMember ?? [];
					const latest = checks.at(-1);
					const execOk = !!t.latestResult;
					const machineOk = t.verification ? t.verification.passed : null;
					return `<div class="review-loop-row">
						<div class="review-loop-head">
							<span class="mono task-id">${esc(t.id)}</span>
							<strong>${esc(t.title)}</strong>
							${t.reviewer?.blind ? `<span class="blind-badge" title="不向复核员传递执行者自述，仅投喂需求契约与客观 git_diff">🕶 代码盲审</span>` : ""}
						</div>
						<div class="loop-steps">
							<span class="loop-step ${execOk ? "done" : t.status === "doing" ? "run" : ""}">1. 执行 (${esc(t.owner ?? "未定")})${t.changes?.length ? ` · #${esc(t.changes.at(-1))}` : ""}</span>
							<span class="loop-sep">→</span>
							<span class="loop-step ${machineOk === true ? "done" : machineOk === false ? "err" : ""}">2. 机器检查 ${machineOk === true ? "通过" : machineOk === false ? "失败" : "待查"}</span>
							<span class="loop-sep">→</span>
							<span class="loop-step ${latest?.status === "accepted" ? "done" : latest?.status === "running" ? "run" : latest?.status === "rework" || latest?.status === "blocked" || latest?.status === "failed" ? "err" : ""}">3. 独立复核 (${esc(t.reviewer?.member ?? "人工")}) · ${esc(latest?.status ?? "等待交付")}</span>
						</div>
						${checks.length ? `<div class="loop-history">${checks.map((ck, idx) => {
							const d = ck.jobId ? dispatchByJob.get(ck.jobId) : undefined;
							return `<div class="loop-round"><span class="mono">第 ${idx + 1} 轮 · ${esc(ck.status)}</span>${ck.evidence ? `<span class="muted">${esc(short(ck.evidence, 110))}</span>` : ""}${d ? `<button type="button" class="linkish" data-open-dispatch="${esc(d.key)}">看复核记录</button>` : ""}</div>`;
						}).join("")}</div>` : ""}
					</div>`;
				}).join("")}
			</div>
		</section>`;
}

export function bindDagPanelEvents(container) {
	container.querySelectorAll("[data-open-dispatch]").forEach((btn) => {
		btn.addEventListener("click", () => openDispatch(btn.dataset.openDispatch));
	});
}
