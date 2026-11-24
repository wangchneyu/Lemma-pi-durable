// 多 Agent 协作结构可视化：L0/L1/L2 自适应拓扑 DAG、Path Scope 隔离矩阵、Maker-Checker 盲审返工环。
import { openDispatch } from "./drawer.js";
import { AGENT_LABEL, STATUS_LABEL, agentColor, esc, short } from "./util.js";

const NS = "http://www.w3.org/2000/svg";

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
			title: "L2 · 契约并行与联合集成",
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

	const NODE_W = 212;
	const NODE_H = 82;
	const COL_GAP = 56;
	const ROW_GAP = 16;
	const PAD_X = 16;
	const PAD_Y = 30;
	const maxRows = Math.max(1, ...cols.map((c) => c.length));
	const width = Math.max(540, PAD_X * 2 + totalCols * NODE_W + Math.max(0, totalCols - 1) * COL_GAP);
	const height = Math.max(180, PAD_Y * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP);

	const pos = new Map();
	const s = svg("svg", { class: "dag-svg", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": "任务依赖 DAG 图" });
	const defs = svg("defs");
	const mkMarker = (id, cls) => {
		const m = svg("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
		m.append(svg("path", { d: "M1,2 L9,5 L1,8 z", class: cls }));
		return m;
	};
	defs.append(mkMarker("dagArrowDep", "dag-arrow-dep"), mkMarker("dagArrowInt", "dag-arrow-int"));
	s.append(defs);

	for (let c = 0; c < cols.length; c++) {
		const list = cols[c];
		const colH = list.length * NODE_H + Math.max(0, list.length - 1) * ROW_GAP;
		const startY = PAD_Y + (height - PAD_Y * 2 - colH) / 2;
		const x = PAD_X + c * (NODE_W + COL_GAP);
		const label = intNodes.length && c === cols.length - 1 ? "联合集成汇流" : c === 0 ? "起点 / 契约层" : `阶段 ${c + 1}`;
		s.append(svg("text", { x: x + NODE_W / 2, y: 16, class: "dag-col-label", "text-anchor": "middle" }, label));
		list.forEach((node, r) => {
			pos.set(node.id, { x, y: startY + r * (NODE_H + ROW_GAP), node });
		});
	}

	// 连线层（节点下方）
	const edgesG = svg("g", { class: "dag-edges" });
	for (const t of active) {
		const to = pos.get(t.id);
		if (!to) continue;
		for (const dep of t.deps ?? []) {
			const from = pos.get(dep);
			if (!from) continue;
			const x1 = from.x + NODE_W;
			const y1 = from.y + NODE_H / 2;
			const x2 = to.x - 3;
			const y2 = to.y + NODE_H / 2;
			const mx = (x1 + x2) / 2;
			const blocking = byId.get(dep)?.status !== "done";
			edgesG.append(svg("path", {
				d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
				class: `dag-edge dep${blocking ? " blocking" : " done"}`,
				"marker-end": "url(#dagArrowDep)",
			}));
		}
	}
	for (const entry of intNodes) {
		const to = pos.get(`int:${entry.it.id}`);
		if (!to) continue;
		const sources = entry.upstreamIds.length ? entry.upstreamIds : cols[Math.max(0, totalCols - 2)]?.map((n) => n.id) ?? [];
		for (const upId of sources) {
			const from = pos.get(upId);
			if (!from) continue;
			const x1 = from.x + NODE_W;
			const y1 = from.y + NODE_H / 2;
			const x2 = to.x - 3;
			const y2 = to.y + NODE_H / 2;
			const mx = (x1 + x2) / 2;
			edgesG.append(svg("path", {
				d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
				class: "dag-edge int",
				"marker-end": "url(#dagArrowInt)",
			}));
		}
	}
	s.append(edgesG);

	// 节点层
	const nodesG = svg("g", { class: "dag-nodes" });
	for (const { x, y, node } of pos.values()) {
		if (node.kind === "integration") {
			const it = node.data;
			const st = it.status ?? it.changeStatus;
			const ok = st === "passed" || it.changeStatus === "applied";
			const g = svg("g", { class: `dag-node integration ${ok ? "s-done" : st === "conflict" || st === "failed" ? "s-blocked" : "s-doing"}`, tabindex: 0 });
			g.append(svg("rect", { x, y, width: NODE_W, height: NODE_H, rx: 9, class: "box" }));
			g.append(svg("text", { x: x + 12, y: y + 21, class: "nid" }, `集成 #${it.id}`));
			g.append(svg("text", { x: x + NODE_W - 12, y: y + 21, class: "nstat", "text-anchor": "end" }, it.changeStatus === "applied" ? "已合并" : st));
			g.append(svg("text", { x: x + 12, y: y + 43, class: "ntitle" }, short((it.sources ?? []).map((src) => `#${src.id}`).join(" + ") || it.task, 24)));
			g.append(svg("text", { x: x + 12, y: y + 64, class: "nmeta" }, `检查 ${it.passed ?? 0}/${it.total ?? 0}${it.conflicts?.length ? ` · 冲突 ${it.conflicts.length}` : ""}`));
			g.addEventListener("click", () => { location.hash = `#/changes/${encodeURIComponent(it.id)}`; });
			nodesG.append(g);
			continue;
		}
		const t = node.data;
		const readiness = readinessMap?.get(t.id);
		const color = t.owner ? agentColor(t.owner) : "var(--orch)";
		const g = svg("g", { class: `dag-node s-${t.status}`, style: `--c:${color}`, tabindex: 0 });
		g.append(svg("rect", { x, y, width: NODE_W, height: NODE_H, rx: 9, class: "box" }));
		g.append(svg("rect", { x, y: y + 8, width: 3.5, height: NODE_H - 16, rx: 2, class: "bar" }));
		g.append(svg("text", { x: x + 12, y: y + 21, class: "nid" }, `${t.id}${t.automation ? " ⚡" : ""}`));
		g.append(svg("text", { x: x + NODE_W - 10, y: y + 21, class: "nstat", "text-anchor": "end" }, STATUS_LABEL[t.status] ?? t.status));
		g.append(svg("text", { x: x + 12, y: y + 43, class: "ntitle" }, short(t.title, 22)));
		const scopeTag = t.scope?.allow?.length ? `🔒 ${t.scope.allow[0]}` : "";
		const ownerLabel = t.owner ? AGENT_LABEL[t.owner] ?? t.owner : "未指派";
		const revTag = t.reviewer ? ` · 🔎${t.reviewer.blind ? "盲审" : "复核"}${t.checksByMember?.length ? `×${t.checksByMember.length}` : ""}` : "";
		const waitHint = t.status === "todo" && readiness && !readiness.ready ? " · 等待中" : "";
		g.append(svg("text", { x: x + 12, y: y + 64, class: "nmeta" }, short(`${ownerLabel}${revTag}${scopeTag ? ` · ${scopeTag}` : ""}${waitHint}`, 32)));
		g.append(svg("title", {}, `${t.id}: ${t.title}\n状态: ${STATUS_LABEL[t.status] ?? t.status}${t.scope ? `\n路径契约: allow=${(t.scope.allow ?? []).join(",")} forbid=${(t.scope.forbid ?? []).join(",")}` : ""}`));
		g.addEventListener("click", () => onSelectTask?.(t));
		nodesG.append(g);
	}
	s.append(nodesG);
	container.innerHTML = "";
	container.append(s);
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
					<td><span class="pill" data-s="${t.status === "done" ? "done" : t.status === "doing" || t.status === "review" ? "running" : t.status === "blocked" ? "error" : "aborted"}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span></td>
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
