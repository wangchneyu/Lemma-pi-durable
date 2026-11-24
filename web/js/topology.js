// 协作拓扑：总调度 → 成员 → 会话（泳道）→ 每次派工（时间条）。
// 同一个成员的多条泳道 = 它开过的多个会话；时间条重叠 = 并行；虚线框 = 后台派工；虚线箭头 = 基于另一次改动开工。
import { openDispatch } from "./drawer.js";
import { runningJobs, store } from "./store.js";
import { AGENT_LABEL, KINDS, agentColor, duration, esc, getJson, money, post, short, stamp, toast } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const LANE_H = 30;
const GROUP_GAP = 18;
const TOP = 50;
const COL = { orch: 18, orchW: 128, member: 196, memberW: 120, lane: 360, laneW: 190, time: 572 };
const WINDOWS = { 20: "最近 20 次", 40: "最近 40 次", 80: "最近 80 次" };
const PREF = "pi-agent-topology-window";

function svg(tag, attrs = {}, text) {
	const node = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
	if (text !== undefined) node.textContent = text;
	return node;
}

function curve(x1, y1, x2, y2) {
	const mx = (x1 + x2) / 2;
	return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** 时间轴刻度：按跨度选合适的间隔 */
function ticks(from, to, width) {
	const span = Math.max(1, to - from);
	const steps = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 24 * 3600e3, 7 * 24 * 3600e3];
	const step = steps.find((s) => (span / s) * 70 <= width) ?? steps.at(-1);
	const out = [];
	for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
	return { list: out, step };
}

/**
 * 时间比例尺：没有任何派工在跑的长空档压缩成一小段（比如终端重启、隔了一阵才下一个任务），
 * 免得早先的派工挤在最左边、现在的挤在最右边。
 */
const GAP_W = 38;
function timeScale(bars, from, to, x0, width) {
	const spans = bars.map((b) => [b.start, b.end]).sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const [s, e] of spans) {
		const last = merged.at(-1);
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else merged.push([s, e]);
	}
	const minGap = Math.max(45e3, (to - from) * 0.06);
	const gaps = [];
	for (let i = 0; i + 1 < merged.length; i++) {
		const a = merged[i][1];
		const b = merged[i + 1][0];
		if (b - a > minGap) gaps.push([a, b]);
	}
	const active = Math.max(1000, to - from - gaps.reduce((n, [a, b]) => n + (b - a), 0));
	const k = (width - gaps.length * GAP_W) / active;
	const xOf = (t) => {
		let x = x0;
		let prev = from;
		for (const [a, b] of gaps) {
			if (t <= a) break;
			if (t < b) return x + (a - prev) * k + ((t - a) / (b - a)) * GAP_W;
			x += (a - prev) * k + GAP_W;
			prev = b;
		}
		return x + (t - prev) * k;
	};
	const inGap = (t) => gaps.some(([a, b]) => t > a && t < b);
	return { xOf, gaps, active, inGap };
}

function gapLabel(ms) {
	if (ms >= 24 * 3600e3) return `${Math.round(ms / (24 * 3600e3))} 天`;
	if (ms >= 3600e3) return `${Math.round(ms / 3600e3)} 小时`;
	return `${Math.max(1, Math.round(ms / 60e3))} 分钟`;
}

function tickLabel(t, step) {
	const d = new Date(t);
	const pad = (n) => String(n).padStart(2, "0");
	if (step >= 24 * 3600e3) return `${d.getMonth() + 1}/${d.getDate()}`;
	if (step >= 60e3) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function topology() {
	let root;
	let data = null;
	let loading = false;
	let timer;
	let windowSize = 40;
	try {
		windowSize = Number(localStorage.getItem(PREF)) || 40;
	} catch {
		/* 默认 */
	}

	async function load() {
		if (loading) return;
		loading = true;
		try {
			data = await getJson(`/api/topology?limit=${windowSize}`);
			render();
		} catch {
			/* 断线时由连接状态提示 */
		} finally {
			loading = false;
		}
	}
	const reload = (delay = 250) => {
		clearTimeout(timer);
		timer = setTimeout(load, delay);
	};

	function stats() {
		const box = root.querySelector('[data-n="stats"]');
		if (!data) return;
		const s = data.stats;
		const jobs = runningJobs().length;
		const integrationsCount = data.bars.filter((b) => b.mode === "integration").length;
		const reviewsCount = data.bars.filter((b) => b.reviewRole).length;
		box.innerHTML = [
			[`总调度`, data.orchestrator.busy ? `<b class="live">调度中</b>` : "待命"],
			[`正在执行`, `<b>${s.running}</b> 路${jobs ? `（后台 ${jobs}）` : ""}`],
			[`并行峰值`, `<b>${s.peak}</b> 路`],
			[`会话`, `<b>${data.lanes.filter((l) => l.session && l.agent !== "integration").length}</b> 个`],
			[`后台 / 复核 / 集成`, `<b>${s.async}</b> 后台${reviewsCount ? ` · <b>${reviewsCount}</b> 复核` : ""}${integrationsCount ? ` · <b>${integrationsCount}</b> 集成` : ""}`],
		]
			.map(([k, v]) => `<div class="topo-stat"><span>${k}</span><strong>${v}</strong></div>`)
			.join("");
	}

	function render() {
		if (!root || !data) return;
		stats();
		const stage = root.querySelector('[data-n="stage"]');
		if (!data.bars.length) {
			stage.innerHTML = `<div class="empty-inline"><span class="dot"></span>还没有派工。总调度派活后，这里会显示谁在哪个会话里、什么时候、和谁并行。</div>`;
			return;
		}
		const width = Math.max(980, stage.clientWidth - 12);
		const timeW = width - COL.time - 24;
		// ---- 布局：成员分组，组内按会话最早开始时间排 ----
		const members = [...new Set(["lead", "integration", ...KINDS, ...data.members.map((m) => m.kind), ...data.lanes.map((lane) => lane.agent)])].map((k) => ({ kind: k, info: data.members.find((m) => m.kind === k), lanes: data.lanes.filter((l) => l.agent === k).sort((a, b) => a.first - b.first) })).filter(
			(m) => m.lanes.length || m.info?.available,
		);
		let y = TOP;
		const laneY = new Map();
		for (const m of members) {
			m.y0 = y;
			const rows = Math.max(1, m.lanes.length);
			m.lanes.forEach((l, i) => laneY.set(l.id, y + i * LANE_H + LANE_H / 2));
			y += rows * LANE_H;
			m.y1 = y;
			m.cy = (m.y0 + m.y1) / 2;
			y += GROUP_GAP;
		}
		const height = y + 6;
		const from = Math.min(...data.bars.map((b) => b.start));
		const anyRunning = data.bars.some((b) => b.running);
		const to = Math.max(anyRunning ? data.now : 0, ...data.bars.map((b) => b.end));
		const scale = timeScale(data.bars, from, to, COL.time, timeW);
		const xOf = scale.xOf;

		const s = svg("svg", { class: "topo-svg", width, height, viewBox: `0 0 ${width} ${height}` });
		const defs = svg("defs");
		defs.innerHTML = `<marker id="topoArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker>
			<pattern id="topoStripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="currentColor" opacity=".28"/></pattern>`;
		s.append(defs);

		// ---- 时间轴 ----
		const axis = svg("g", { class: "topo-axis" });
		// 刻度按「有活动的时长」选间隔，落在空档里的不画
		const t = ticks(from, from + scale.active, timeW - scale.gaps.length * GAP_W);
		const step = t.step;
		let lastX = -Infinity;
		for (let tick = Math.ceil(from / step) * step; tick <= to; tick += step) {
			if (scale.inGap(tick)) continue;
			const x = xOf(tick);
			if (x - lastX < 46) continue;
			lastX = x;
			axis.append(svg("line", { x1: x, x2: x, y1: TOP - 8, y2: height - 4 }));
			axis.append(svg("text", { x, y: TOP - 14, "text-anchor": "middle" }, tickLabel(tick, step)));
		}
		for (const [a, b] of scale.gaps) {
			const x1 = xOf(a);
			const x2 = xOf(b);
			axis.append(svg("rect", { class: "gap", x: x1 + 3, y: TOP - 6, width: Math.max(2, x2 - x1 - 6), height: height - TOP + 2, rx: 3 }));
			axis.append(svg("text", { class: "gap-t", x: (x1 + x2) / 2, y: TOP - 14, "text-anchor": "middle" }, `⋯${gapLabel(b - a)}`));
		}
		if (anyRunning) {
			const x = xOf(data.now);
			axis.append(svg("line", { class: "now", x1: x, x2: x, y1: TOP - 8, y2: height - 4 }));
			axis.append(svg("text", { class: "now", x, y: TOP - 14, "text-anchor": "end" }, "现在"));
		}
		s.append(axis);

		// ---- 列标题 ----
		const heads = svg("g", { class: "topo-heads" });
		heads.append(svg("text", { x: COL.orch, y: 14 }, "总调度"));
		heads.append(svg("text", { x: COL.member, y: 14 }, "成员"));
		heads.append(svg("text", { x: COL.lane, y: 14 }, "会话"));
		heads.append(svg("text", { x: COL.time, y: 14 }, "派工时间线（重叠 = 并行，虚线框 = 后台）"));
		s.append(heads);

		// ---- 总调度 → 成员 → 会话 的连线 ----
		const orchY = Math.max(TOP + 24, Math.min(height - 30, (members[0]?.cy + members.at(-1)?.cy) / 2 || TOP + 24));
		const wires = svg("g", { class: "topo-wires" });
		for (const m of members) {
			const count = data.bars.filter((b) => b.agent === m.kind).length;
			const running = data.bars.some((b) => b.agent === m.kind && b.running);
			wires.append(
				svg("path", {
					d: curve(COL.orch + COL.orchW, orchY, COL.member, m.cy),
					class: running ? "flow" : "",
					style: `--c:${agentColor(m.kind)};stroke-width:${Math.min(9, 1.5 + Math.sqrt(count) * 1.4)}`,
				}),
			);
			for (const l of m.lanes) {
				wires.append(
					svg("path", {
						d: curve(COL.member + COL.memberW, m.cy, COL.lane, laneY.get(l.id)),
						class: l.running ? "flow thin" : "thin",
						style: `--c:${agentColor(m.kind)}`,
					}),
				);
			}
		}
		s.append(wires);

		// ---- 总调度节点 ----
		const orch = svg("g", { class: `topo-node orch${data.orchestrator.busy ? " busy" : ""}`, transform: `translate(${COL.orch},${orchY - 22})` });
		orch.append(svg("rect", { width: COL.orchW, height: 44, rx: 9 }));
		orch.append(svg("text", { x: 12, y: 19, class: "name" }, "总调度"));
		orch.append(svg("text", { x: 12, y: 34, class: "sub" }, short(data.orchestrator.model ?? "", 18)));
		orch.append(svg("circle", { cx: COL.orchW - 14, cy: 15, r: 4, class: "lamp" }));
		s.append(orch);

		// ---- 成员节点 ----
		for (const m of members) {
			const running = data.bars.filter((b) => b.agent === m.kind && b.running).length;
			const g = svg("g", { class: `topo-node member${running ? " busy" : ""}${m.info?.available === false ? " off" : ""}`, transform: `translate(${COL.member},${m.cy - 20})`, style: `--c:${agentColor(m.kind)}` });
			g.append(svg("rect", { width: COL.memberW, height: 40, rx: 8 }));
			g.append(svg("rect", { width: 4, height: 40, rx: 2, class: "bar" }));
			g.append(svg("text", { x: 14, y: 17, class: "name" }, AGENT_LABEL[m.kind] ?? m.kind));
			g.append(svg("text", { x: 14, y: 32, class: "sub" }, `${m.lanes.filter((l) => l.session).length} 个会话${running ? ` · ${running} 路在跑` : ""}`));
			s.append(g);
		}

		// ---- 会话泳道 ----
		const lanes = svg("g", { class: "topo-lanes" });
		for (const m of members) {
			for (const l of m.lanes) {
				const cy = laneY.get(l.id);
				const g = svg("g", { class: `topo-lane${l.running ? " busy" : ""}`, transform: `translate(${COL.lane},${cy - LANE_H / 2 + 3})`, style: `--c:${agentColor(m.kind)}` });
				g.append(svg("rect", { width: width - COL.lane - 16, height: LANE_H - 6, rx: 6, class: "track" }));
				const label = m.kind === "integration"
					? `集成 #${(l.session ?? l.id).slice(0, 8)}`
					: m.kind === "lead"
						? `子调度 ${l.model ?? ""}`
						: l.session
							? `会话 ${l.session.slice(0, 8)}`
							: "一次性";
				g.append(svg("text", { x: 10, y: 12, class: "name" }, label));
				g.append(svg("text", { x: 10, y: 22, class: "sub" }, `${l.rounds} 轮${l.tasks.length ? ` · ${l.tasks.join(" ")}` : ""}${l.model ? ` · ${short(l.model, 16)}` : ""}`));
				const title = svg("title", {}, `${label}\n${l.rounds} 轮，最近：${l.lastTask ?? ""}${l.session ? `\n${l.session}` : ""}`);
				g.append(title);
				lanes.append(g);
			}
		}
		s.append(lanes);

		// ---- 依赖箭头（基于某次改动开工） ----
		const barAt = new Map(data.bars.map((b) => [b.key, b]));
		const links = svg("g", { class: "topo-links" });
		for (const link of data.links) {
			const a = barAt.get(link.from);
			const b = barAt.get(link.to);
			if (!a || !b || !laneY.has(a.lane) || !laneY.has(b.lane)) continue;
			const x1 = xOf(a.end);
			const y1 = laneY.get(a.lane);
			const x2 = Math.max(xOf(b.start), x1 + 8);
			const y2 = laneY.get(b.lane);
			if (link.type === "spawn") {
				// 子调度 → 它派的工：从子调度时间条上、派工开始的时刻垂直连下去
				const xs = Math.max(xOf(a.start), Math.min(xOf(b.start), xOf(a.end)));
				links.append(svg("path", { class: "spawn", d: `M${xs},${y1 + 8} C${xs},${(y1 + y2) / 2} ${xOf(b.start)},${(y1 + y2) / 2} ${xOf(b.start)},${y2 - 8}`, "marker-end": "url(#topoArrow)" }));
				continue;
			}
			links.append(svg("path", { class: link.type === "integrate" || link.type === "review" ? link.type : "", d: curve(x1, y1, x2, y2), "marker-end": "url(#topoArrow)" }));
			if (link.change) links.append(svg("text", { x: (x1 + x2) / 2 + 4, y: (y1 + y2) / 2 - 3 }, link.type === "review" ? `复核 ${link.change}` : `#${link.change}`));
		}

		// ---- 派工时间条 ----
		const bars = svg("g", { class: "topo-bars" });
		for (const b of data.bars) {
			if (!laneY.has(b.lane)) continue;
			const cy = laneY.get(b.lane);
			const x = xOf(b.start);
			const w = Math.max(6, xOf(b.end) - x);
			const g = svg("g", {
				class: `topo-bar ${b.mode} s-${b.status}${b.running ? " running" : ""}`,
				transform: `translate(${x},${cy - 8})`,
				style: `--c:${agentColor(b.agent)};color:${agentColor(b.agent)}`,
				tabindex: 0,
				role: "button",
			});
			g.append(svg("rect", { width: w, height: 16, rx: 4, class: "body" }));
			if (b.mode === "async") g.append(svg("rect", { width: w, height: 16, rx: 4, class: "stripe", fill: "url(#topoStripe)" }));
			const label = b.mode === "lead"
				? `🧭 ${b.task.split("：")[0]}${b.taskId ? ` ${b.taskId}` : ""}`
				: b.mode === "integration"
					? `🔀 #${b.changeId}`
					: b.reviewRole
						? `🔎 ${[b.job, b.taskId].filter(Boolean).join(" ")}`
						: [b.job, b.taskId].filter(Boolean).join(" ") || (b.resume ? "续" : "");
			if (label && w > 26) g.append(svg("text", { x: 5, y: 12 }, short(label, Math.max(2, Math.floor(w / 7)))));
			g.append(
				svg(
					"title",
					{},
					[
						`${AGENT_LABEL[b.agent] ?? b.agent}${b.mode === "lead" ? " · 接手子目标，自己拆任务派工" : b.mode === "integration" ? " · 多分支合并与联合测试" : b.reviewRole ? ` · 独立复核 ${b.job ?? ""}` : b.job ? ` · 后台 ${b.job}` : " · 同步"}${b.lead ? " · 由子调度派出" : ""}${b.taskId ? ` · ${b.taskId}` : ""}`,
						b.task,
						`${stamp(b.start)} → ${b.running ? "进行中" : stamp(b.end)}（${duration(b.end - b.start)}）`,
						[b.model, b.cost != null ? money(b.cost) : null, b.changeId ? `改动 #${b.changeId}` : null, b.basedOn ? `基于 #${b.basedOn}` : null].filter(Boolean).join(" · "),
					]
						.filter(Boolean)
						.join("\n"),
				),
			);
			g.addEventListener("click", () => (b.mode === "lead" ? toast("子调度：它派出的工见下方连线；点那些时间条看详情") : b.mode === "integration" ? (location.hash = `#/changes/${encodeURIComponent(b.changeId)}`) : openDispatch(b.key)));
			g.addEventListener("keydown", (e) => {
				if (e.key === "Enter") openDispatch(b.key);
			});
			bars.append(g);
		}
		s.append(bars);
		s.append(links);
		stage.replaceChildren(s);
	}

	function jobsPanel() {
		const box = root.querySelector('[data-n="jobs"]');
		const list = store.jobs.slice(0, 12);
		if (!list.length) {
			box.innerHTML = `<div class="empty-inline"><span class="dot"></span>还没有后台派工。耗时长、互不依赖的任务，总调度会用 background: true 放到后台，自己接着干别的。</div>`;
			return;
		}
		box.innerHTML = list
			.map((j) => {
				const running = j.status === "running";
				const last = (j.output ?? []).at(-1) ?? "";
				return `<div class="job-row" data-s="${j.status}" style="--c:${agentColor(j.agent)}">
					<span class="job-id">${esc(j.id)}</span>
					<span class="agent-chip">${esc(AGENT_LABEL[j.agent] ?? j.agent)}</span>
					<span class="job-task">${j.taskId ? `<b>${esc(j.taskId)}</b> ` : ""}${esc(short(j.task, 70))}${running && last ? `<span class="job-last">${esc(short(last, 90))}</span>` : ""}</span>
					<span class="job-time mono">${running ? duration(Date.now() - j.startedAt) : duration(j.durationMs)}</span>
					<span class="pill" data-s="${running ? "running" : j.status === "done" ? "done" : j.status === "failed" ? "error" : "aborted"}">${running ? "执行中" : { done: "完成", failed: "失败", cancelled: "已取消" }[j.status]}</span>
					${running ? `<button type="button" class="ghost-btn tiny" data-cancel="${esc(j.id)}">取消</button>` : `<span></span>`}
				</div>`;
			})
			.join("");
	}

	return {
		title: "协作拓扑",
		sub: "",
		mount(r) {
			root = r;
			root.innerHTML = `<div class="topo-stats" data-n="stats"></div>
				<section class="card topo-card">
					<header class="card-head">
						<div class="card-heading"><h2 class="card-title">拓扑与时间线</h2><div class="card-sub">点时间条看这次派工的详情</div></div>
						<div class="seg" data-n="win">${Object.entries(WINDOWS)
							.map(([k, v]) => `<button type="button" data-k="${k}" class="${Number(k) === windowSize ? "on" : ""}">${v}</button>`)
							.join("")}</div>
					</header>
					<div class="card-body topo-stage" data-n="stage"><div class="empty-inline"><span class="dot"></span>加载中…</div></div>
					<footer class="topo-legend">
						<span><i class="lg sync"></i>同步派工</span><span><i class="lg async"></i>后台派工</span><span><i class="lg run"></i>进行中</span><span><i class="lg dep"></i>基于另一次改动</span><span><i class="lg integrate"></i>多分支合流集成</span><span><i class="lg review"></i>独立复核 / 盲审</span><span><i class="lg spawn"></i>子调度派出的工</span>
					</footer>
				</section>
				<section class="card"><header class="card-head"><h2 class="card-title">后台派工</h2><span class="card-note">终端：/jobs、/jobs cancel &lt;编号&gt;</span></header><div class="card-body flush" data-n="jobs"></div></section>`;
			root.querySelector('[data-n="win"]').addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest("button") : null;
				if (!b) return;
				windowSize = Number(b.dataset.k);
				try {
					localStorage.setItem(PREF, String(windowSize));
				} catch {
					/* 忽略 */
				}
				for (const x of root.querySelectorAll('[data-n="win"] button')) x.classList.toggle("on", x === b);
				load();
			});
			root.querySelector('[data-n="jobs"]').addEventListener("click", async (e) => {
				const b = e.target instanceof Element ? e.target.closest("[data-cancel]") : null;
				if (!b) return;
				const id = b.dataset.cancel;
				if (!confirm(`取消后台派工 ${id}？已有的改动会留在它的分支里，任务退回待办，总调度会收到通知。`)) return;
				b.disabled = true;
				try {
					await post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
					toast(`已取消 ${id}`);
				} catch (err) {
					toast(`取消失败：${err.message}`);
					b.disabled = false;
				}
			});
			this.resize = () => render();
			addEventListener("resize", this.resize);
			jobsPanel();
			load();
		},
		unmount() {
			clearTimeout(timer);
			removeEventListener("resize", this.resize);
			root = null;
		},
		update(kind) {
			if (!root) return;
			if (kind === "job-output") return jobsPanel();
			if (kind === "tick") {
				jobsPanel();
				// 有派工在跑时，时间条随时间伸长
				if (data?.bars.some((b) => b.running)) {
					data.now = Date.now();
					for (const b of data.bars) if (b.running) b.end = data.now;
					render();
				}
				return;
			}
			if (kind === "jobs" || kind === "dispatches" || kind === "changes" || kind === "state" || kind === "live" || kind === "items") {
				jobsPanel();
				reload(kind === "live" ? 600 : 250);
			}
		},
	};
}
