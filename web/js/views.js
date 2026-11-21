// 后台各页面。每个页面：mount(root, params) 渲染，update(kind, payload) 响应数据变化，unmount() 清理。
import { openDispatch } from "./drawer.js";
import { METRICS, RANGES, Sankey } from "./sankey.js";
import { buildRuns, callInfo, dispatchRows, loadEarlier, pendingChanges, store } from "./store.js";
import { Ticket, slotStart } from "./ticket.js";
import { Timeline } from "./timeline.js";
import {
	AGENT_LABEL,
	FAILURE_LABEL,
	KINDS,
	STATUS_LABEL,
	agentColor,
	ago,
	duration,
	el,
	esc,
	kindOf,
	money,
	num,
	short,
	stamp,
	toast,
	getJson,
} from "./util.js";

const RUN_LABEL = { running: "进行中", done: "完成", partial: "有失败", error: "失败", aborted: "已中止", open: "未完成" };
const PILL = { running: "running", done: "done", partial: "error", error: "error", aborted: "aborted", interrupted: "aborted", open: "aborted" };

function empty(text) {
	return `<div class="empty-state">${esc(text)}</div>`;
}
function agentTag(kind) {
	return `<span class="agent-tag" style="--c:${agentColor(kind)}"><i></i>${esc(AGENT_LABEL[kind] ?? kind)}</span>`;
}
const TIER = { economy: "经济", standard: "标准", premium: "强力" };
/** 成员可选的模型：档位、默认、用了多少次 */
function modelList(agent) {
	if (!agent.models?.length) return `<div class="model-list"><span class="muted">没有配置模型清单，使用 CLI 自己的默认模型</span></div>`;
	const stats = (store.state?.modelStats ?? []).filter((m) => m.agent === agent.kind);
	return `<div class="model-list">${agent.models
		.map((m) => {
			const st = stats.find((x) => x.model === m.id);
			return `<div class="model-row" data-tier="${m.tier}">
				<span class="tier">${TIER[m.tier] ?? m.tier}</span>
				<span class="model-id mono">${esc(m.id)}${m.id === agent.defaultModel ? `<em>默认</em>` : ""}</span>
				<span class="mono muted">${st ? `${st.total} 次 · ${money(st.cost)}${st.estimated ? "≈" : ""}` : "未使用"}</span>
				<span class="model-note">${esc(m.note ?? "")}</span>
			</div>`;
		})
		.join("")}</div>`;
}

/** 改动编号链接，带状态颜色 */
function changeLink(id) {
	const c = store.changes.find((x) => x.id === id);
	const s = c?.status ?? "pending";
	return `<a class="change-link" data-s="${esc(s)}" href="#/changes/${esc(id)}" title="${esc({ pending: "待合并", conflict: "有冲突", applied: "已合并", empty: "无改动", dropped: "已丢弃", running: "进行中" }[s] ?? s)}">#${esc(id)}</a>`;
}
function totals() {
	const stats = store.state?.agentStats ?? {};
	const t = { total: 0, done: 0, error: 0, aborted: 0, cost: 0, durationMs: 0 };
	for (const s of Object.values(stats)) {
		t.total += s.total;
		t.done += s.done;
		t.error += s.error;
		t.aborted += s.aborted;
		t.cost += s.cost;
		t.durationMs += s.durationMs;
	}
	return t;
}

// =====================================================================
// 总览
// =====================================================================
const PREF_KEY = "pi-agent-routes-view";
function loadPrefs() {
	try {
		return { metric: "count", range: "all", ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
	} catch {
		return { metric: "count", range: "all" };
	}
}
function savePrefs(prefs) {
	try {
		localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
	} catch {
		/* 忽略 */
	}
}
function segButtons(entries, current) {
	return entries.map(([k, label]) => `<button type="button" data-k="${k}" class="${k === current ? "on" : ""}">${label}</button>`).join("");
}

// ---------- 小图：24 小时柱状迷你图、分段条 ----------
function hourly(rows, hours = 24) {
	const now = Date.now();
	const buckets = Array.from({ length: hours }, () => 0);
	for (const d of rows) {
		if (!d.at) continue;
		const i = hours - 1 - Math.floor((now - d.at) / 3_600_000);
		if (i >= 0 && i < hours) buckets[i]++;
	}
	return buckets;
}
function sparkBars(values, color = "var(--signal)") {
	const max = Math.max(1, ...values);
	const w = 4;
	const gap = 2;
	const h = 30;
	const bars = values
		.map((v, i) => {
			if (!v) return `<rect x="${i * (w + gap)}" y="${h - 1}" width="${w}" height="1" style="fill:var(--line)"/>`;
			const bh = Math.max(3, (v / max) * h);
			return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1" style="fill:${color};opacity:${0.45 + 0.55 * (i / values.length)}"><title>${v} 次</title></rect>`;
		})
		.join("");
	return `<svg class="spark" viewBox="0 0 ${values.length * (w + gap) - gap} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}
function segBar(parts) {
	const total = parts.reduce((s, p) => s + p.value, 0);
	if (!total) return `<div class="segbar empty"></div>`;
	return `<div class="segbar">${parts
		.filter((p) => p.value > 0)
		.map((p) => `<i style="flex:${p.value};background:${p.color}" title="${esc(p.label)} ${esc(p.text ?? p.value)}"></i>`)
		.join("")}</div>`;
}

function overview() {
	let root;
	let sankey;
	const tickets = new Map();
	return {
		title: "总览",
		sub: "调度状态、任务流向和最近活动",
		mount(r) {
			root = r;
			root.innerHTML = `<div class="kpis" data-n="kpis"></div>`;
			const prefs = loadPrefs();
			const routes = el("section", "card routes-card");
			routes.innerHTML = `<header class="card-head">
					<div class="card-heading"><h2 class="card-title">路由分配</h2><div class="card-sub" data-n="routeSum"></div></div>
					<div class="route-controls">
						<div class="seg" data-n="metric" title="带子宽度按什么算">${segButtons(Object.entries(METRICS).map(([k, m]) => [k, m.label]), prefs.metric)}</div>
						<div class="seg" data-n="range" title="时间范围">${segButtons(Object.entries(RANGES).map(([k, m]) => [k, m.label]), prefs.range)}</div>
					</div>
				</header>
				<div class="card-body chart-body"></div>`;
			const body = routes.querySelector(".chart-body");
			sankey = new Sankey();
			sankey.metric = prefs.metric in METRICS ? prefs.metric : "count";
			sankey.range = prefs.range in RANGES ? prefs.range : "all";
			body.append(sankey.node);
			const apply = () => {
				for (const seg of routes.querySelectorAll(".seg")) {
					const value = prefs[seg.dataset.n];
					for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.k === value);
				}
				sankey.render(true);
				this.routeSummary();
			};
			routes.querySelector(".route-controls").addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest(".seg button") : null;
				if (!b) return;
				const which = b.closest(".seg").dataset.n;
				prefs[which] = b.dataset.k;
				savePrefs(prefs);
				sankey[which] = b.dataset.k;
				apply();
			});
			root.append(routes);

			const grid = el("div", "ov-grid");
			grid.innerHTML = `<div class="ov-main">
					<section class="card"><header class="card-head"><h2 class="card-title">正在执行</h2><span class="card-note" data-n="runningNote"></span></header><div class="card-body" data-n="running"></div></section>
					<section class="card"><header class="card-head"><h2 class="card-title">最近运行</h2><a class="card-link" href="#/runs">全部运行 →</a></header><div class="card-body flush" data-n="recent"></div></section>
				</div>
				<div class="ov-main">
					<section class="card"><header class="card-head"><h2 class="card-title">待合并改动</h2><a class="card-link" href="#/changes">全部改动 →</a></header><div class="card-body flush" data-n="changes"></div></section>
					<section class="card ov-side"><header class="card-head"><h2 class="card-title">成员</h2><a class="card-link" href="#/agents">详情 →</a></header><div class="card-body" data-n="members"></div></section>
				</div>`;
			root.append(grid);
			apply();
			this.update("all");
		},
		unmount() {
			sankey?.destroy();
			tickets.clear();
		},
		update(kind) {
			const q = (n) => root.querySelector(`[data-n="${n}"]`);
			// 按次数看时，计时刷新不改变流向，跳过；按耗时看时每秒更新带子宽度
			if (kind !== "tick" || sankey.metric === "time") sankey.render();
			this.routeSummary();
			if (kind !== "tick") this.kpis(q("kpis"));
			this.running(q("running"), q("runningNote"));
			if (kind !== "tick" && kind !== "live") {
				this.recent(q("recent"));
				this.members(q("members"));
				this.pending(q("changes"));
			}
		},
		pending(box) {
			const list = pendingChanges();
			box.innerHTML = list.length
				? `<div class="recent-list">${list
						.slice(0, 5)
						.map(
							(c) => `<a class="recent-row change-mini" href="#/changes/${c.id}">
						<span class="state-dot" data-s="${c.status === "conflict" ? "error" : "pending"}"></span>
						<span class="recent-text"><span class="mono muted">#${esc(c.id)}</span> ${esc(short(c.task, 40))}</span>
						<span class="mono"><b class="ok-t">+${c.add}</b> <b class="err-t">−${c.del}</b></span>
					</a>`,
						)
						.join("")}</div>${list.length > 5 ? `<p class="footnote">还有 ${list.length - 5} 个…</p>` : ""}`
				: `<div class="empty-inline"><span class="dot"></span>${store.changes.length ? "没有待合并的改动" : "成员的改动会出现在这里，等你在终端确认合并"}</div>`;
		},
		routeSummary() {
			const box = root.querySelector('[data-n="routeSum"]');
			if (!box) return;
			const s = sankey.summary();
			box.innerHTML = s?.total
				? `<span><b>${s.total}</b> 次派工</span>${s.rate !== null ? `<span><b>${s.rate}%</b> 成功</span>` : ""}${s.running ? `<span class="live"><b>${s.running}</b> 执行中</span>` : ""}`
				: `<span>${RANGES[sankey.range].label === "全部" ? "还没有派工" : `最近 ${RANGES[sankey.range].label} 没有派工`}</span>`;
		},
		kpis(box) {
			const { live, state } = store;
			const t = totals();
			const finished = t.done + t.error + t.aborted;
			const running = live.tools.filter((x) => x.status === "running").length;
			const rows = dispatchRows();
			const day = hourly(rows);
			const dayTotal = day.reduce((s, v) => s + v, 0);
			let status = "待命";
			let statusSub = "等待终端下发任务";
			let tone = "idle";
			if (live.busy) {
				status = running ? `${running} 路执行中` : "规划中";
				statusSub = `调度中 · 第 ${live.turns + 1} 轮`;
				tone = "busy";
			} else if (live.runFailure && live.runFailure.reason !== "aborted") {
				status = "上一轮未完成";
				statusSub = FAILURE_LABEL[live.runFailure.reason] ?? live.runFailure.reason;
				tone = "failed";
			} else if (live.runFailure) {
				statusSub = "上一轮已中止";
			}
			const tokens = (state?.usage ?? []).reduce((n, u) => n + u.input + u.output, 0);
			const stats = state?.agentStats ?? {};
			const costParts = KINDS.map((k) => ({ value: stats[k]?.cost ?? 0, color: agentColor(k), label: AGENT_LABEL[k], text: money(stats[k]?.cost ?? 0) }));
			const lastAt = Math.max(0, ...rows.map((d) => d.endAt ?? d.at ?? 0));
			box.innerHTML = `
				<div class="kpi kpi-status" data-tone="${tone}">
					<div class="kpi-top"><span class="kpi-label">调度状态</span><span class="pulse"></span></div>
					<strong>${esc(status)}</strong>
					<span class="kpi-sub">${esc(statusSub)}${lastAt && !live.busy ? ` · 上次活动 ${ago(lastAt)}` : ""}</span>
				</div>
				<div class="kpi">
					<div class="kpi-top"><span class="kpi-label">累计派工</span><span class="kpi-trend">近 24h ${dayTotal}</span></div>
					<strong>${num(t.total)}</strong>
					${sparkBars(day)}
				</div>
				<div class="kpi">
					<div class="kpi-top"><span class="kpi-label">成功率</span><span class="kpi-trend">${finished} 次已结束</span></div>
					<strong>${finished ? `${Math.round((t.done / finished) * 100)}%` : "—"}</strong>
					${segBar([
						{ value: t.done, color: "var(--ok)", label: "完成" },
						{ value: t.error, color: "var(--danger)", label: "失败" },
						{ value: t.aborted, color: "var(--muted)", label: "中止" },
					])}
					<span class="kpi-legend"><i style="background:var(--ok)"></i>完成 ${t.done}<i style="background:var(--danger)"></i>失败 ${t.error}<i style="background:var(--muted)"></i>中止 ${t.aborted}</span>
				</div>
				<div class="kpi">
					<div class="kpi-top"><span class="kpi-label">成员花费</span><span class="kpi-trend">${
						state?.budget?.perRunUsd != null && state.budget.runKey
							? `本轮 ${money(state.budget.spent)} / ${money(state.budget.perRunUsd)}`
							: `总调度 ${num(tokens)} tokens`
					}</span></div>
					<strong>${money(t.cost)}</strong>
					${segBar(costParts)}
					<span class="kpi-legend">${
						KINDS.filter((k) => (stats[k]?.cost ?? 0) > 0)
							.map((k) => `<i style="background:${agentColor(k)}"></i>${AGENT_LABEL[k]} ${money(stats[k].cost)}`)
							.join("") || "成员还没有报告花费"
					}</span>
				</div>`;
		},
		running(box, note) {
			const active = store.live.tools.filter((t) => t.status !== "done");
			note.textContent = active.length ? `${active.length} 项` : "";
			if (!active.length) {
				tickets.clear();
				const text = store.live.busy ? "总调度正在规划，还没有派工" : "没有正在执行的派工";
				if (box.textContent.trim() !== text) box.innerHTML = `<div class="empty-inline"><span class="dot"></span>${esc(text)}</div>`;
				return;
			}
			box.querySelector(".empty-inline")?.remove();
			let wrap = box.querySelector(".tickets");
			if (!wrap) {
				wrap = el("div", "tickets multi");
				box.append(wrap);
			}
			for (const slot of active) {
				let t = tickets.get(slot.callId);
				if (!t) {
					const info = callInfo(slot.callId);
					t = new Ticket({ id: slot.callId, name: slot.name, args: { task: info?.task ?? "", session_id: info?.resume } });
					t.node.classList.add("clickable");
					t.node.addEventListener("click", (e) => {
						if (!(e.target instanceof Element && e.target.closest("button"))) openDispatch(slot.callId);
					});
					tickets.set(slot.callId, t);
					wrap.append(t.node);
				}
				t.update(slot);
			}
			for (const [id, t] of tickets) {
				if (!active.some((s) => s.callId === id)) {
					t.node.remove();
					tickets.delete(id);
				}
			}
		},
		recent(box) {
			const runs = buildRuns().filter((r) => !r.divider).slice(-5).reverse();
			box.innerHTML = runs.length
				? `<div class="recent-list">${runs
						.map(
							(run) => `<a class="recent-row" href="#/runs/${run.id}">
						<span class="state-dot" data-s="${PILL[run.status]}"></span>
						<span class="recent-text">${esc(run.user ? short(run.user.text, 80) : "（输入在更早的历史里）")}</span>
						<span class="recent-agents">${run.agents.map((k) => `<i style="background:${agentColor(k)}" title="${esc(AGENT_LABEL[k] ?? k)}"></i>`).join("")}</span>
						<span class="recent-meta">${run.endAt && run.at ? duration(run.endAt - run.at) : "—"}</span>
						<time>${ago(run.at)}</time>
					</a>`,
						)
						.join("")}</div>`
				: `<div class="empty-inline"><span class="dot"></span>还没有运行记录，在终端里输入任务开始。</div>`;
		},
		members(box) {
			const agents = store.state?.agents ?? [];
			const stats = store.state?.agentStats ?? {};
			const busy = new Set(store.live.tools.filter((t) => t.status === "running").map((t) => kindOf(t.name)));
			box.innerHTML = `<div class="member-list">${agents
				.map((a) => {
					const s = stats[a.kind] ?? { total: 0, done: 0, error: 0, aborted: 0, durationMs: 0, timed: 0, cost: 0 };
					const state = !a.available ? "off" : busy.has(a.kind) ? "busy" : "idle";
					const finished = s.done + s.error + s.aborted;
					return `<a class="member-row" href="#/dispatches/${a.kind}" data-state="${state}" style="--c:${agentColor(a.kind)}">
						<span class="lamp"></span>
						<span class="member-main"><span class="member-name">${esc(AGENT_LABEL[a.kind] ?? a.label)}</span><span class="member-state">${state === "busy" ? "执行中" : state === "off" ? "不可用" : "待命"}</span></span>
						<span class="member-figs"><b>${s.total}</b> 次 · ${finished ? `${Math.round((s.done / finished) * 100)}%` : "—"} · ${s.timed ? duration(s.durationMs / s.timed) : "—"}</span>
						${segBar([
							{ value: s.done, color: "var(--ok)", label: "完成" },
							{ value: s.error, color: "var(--danger)", label: "失败" },
							{ value: s.aborted, color: "var(--muted)", label: "中止" },
						])}
					</a>`;
				})
				.join("")}</div>`;
		},
	};
}

function runRow(run) {
	const text = run.user ? short(run.user.text, 90) : "（输入在更早的历史里）";
	return `<a class="run-row" href="#/runs/${run.id}" data-id="${run.id}">
		<span class="run-top"><time>${stamp(run.at)}</time><span class="pill" data-s="${PILL[run.status]}">${RUN_LABEL[run.status]}</span></span>
		<span class="run-input">${esc(text)}</span>
		<span class="run-foot">${run.agents.map(agentTag).join("")}<span class="run-meta">${run.dispatchCount ? `派工 ${run.dispatchCount}` : "直接回答"}${run.endAt && run.at ? ` · ${duration(run.endAt - run.at)}` : ""}</span></span>
	</a>`;
}

// =====================================================================
// 运行记录
// =====================================================================
function runs() {
	let root;
	let selected = null; // 选中的运行 id；null = 跟随最新
	let timeline = null;
	let shownId = null;
	return {
		title: "运行记录",
		sub: "每次在终端里的输入，以及总调度如何派工、各成员返回了什么",
		mount(r, params) {
			root = r;
			selected = params[0] ?? null;
			root.innerHTML = `<div class="runs-layout">
				<section class="card run-list"><header class="card-head"><h2 class="card-title">运行</h2><span class="card-note" data-n="count"></span></header>
					<div class="run-scroll" data-n="list"></div></section>
				<section class="card run-detail" data-n="detail"></section>
			</div>`;
			this.update("all");
		},
		unmount() {
			timeline = null;
			shownId = null;
		},
		update(kind) {
			if (kind === "tick" || kind === "state" || kind === "dispatches") {
				if (timeline && kind === "tick") timeline.live(store.live, shownId === this.latestId);
				return;
			}
			const all = buildRuns();
			const real = all.filter((x) => !x.divider);
			this.latestId = real.at(-1)?.id;
			const list = root.querySelector('[data-n="list"]');
			const target = selected ?? this.latestId;
			root.querySelector('[data-n="count"]').textContent = `${real.length} 次${store.hasMore ? "（已加载部分）" : ""}`;
			if (kind !== "live" || real.some((x) => x.status === "running")) {
				const html = all
					.slice()
					.reverse()
					.map((run) => (run.divider ? `<div class="run-divider">${esc(run.label)}</div>` : runRow(run)))
					.join("");
				list.innerHTML = (html || empty("还没有运行记录。在终端里输入任务开始。")) + (store.hasMore ? `<button class="ghost-btn load-more" type="button">加载更早的记录</button>` : "");
				list.querySelector(`[data-id="${CSS.escape(String(target))}"]`)?.classList.add("active");
				list.querySelector(".load-more")?.addEventListener("click", async (e) => {
					e.currentTarget.disabled = true;
					try {
						const n = await loadEarlier();
						toast(n ? `加载了 ${n} 条更早的记录` : "没有更早的记录了");
					} catch (err) {
						toast(`加载失败：${err.message}`);
					}
				});
			}
			this.detail(real.find((x) => x.id === target), kind);
		},
		detail(run, kind) {
			const box = root.querySelector('[data-n="detail"]');
			if (!run) {
				timeline = null;
				shownId = null;
				box.innerHTML = empty(store.loaded ? "选择左侧的一次运行查看详情" : "加载中…");
				return;
			}
			const current = run.id === this.latestId;
			if (shownId !== run.id) {
				shownId = run.id;
				timeline = new Timeline();
				box.innerHTML = `<header class="detail-head"><div><h2 class="eyebrow">运行详情</h2><p class="detail-title"></p></div><span class="pill" data-n="pill"></span></header><div class="detail-meta" data-n="meta"></div>`;
				box.querySelector(".detail-title").textContent = run.user ? short(run.user.text, 120) : "（输入在更早的历史里）";
				const scroll = el("div", "detail-scroll");
				scroll.append(timeline.node);
				box.append(scroll);
				timeline.add(run.items);
			} else {
				const scroll = box.querySelector(".detail-scroll");
				const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
				timeline.add(run.items, { animate: kind === "items" });
				if (near && kind === "items") scroll.scrollTop = scroll.scrollHeight;
			}
			const pill = box.querySelector('[data-n="pill"]');
			pill.dataset.s = PILL[run.status];
			pill.textContent = RUN_LABEL[run.status];
			box.querySelector('[data-n="meta"]').innerHTML = [
				`开始 ${stamp(run.at)}`,
				run.endAt && run.at ? `耗时 ${duration(run.endAt - run.at)}` : "",
				run.dispatchCount ? `派工 ${run.dispatchCount} 次` : "没有派工",
				run.agents.length ? run.agents.map(agentTag).join("") : "",
			]
				.filter(Boolean)
				.join('<span class="sep"></span>');
			timeline.live(store.live, current);
		},
	};
}

// =====================================================================
// 派工明细
// =====================================================================
function dispatches() {
	let root;
	const filter = { agent: "all", status: "all", q: "" };
	return {
		title: "派工明细",
		sub: "总调度每一次把任务交给成员 CLI 的记录，点一行查看完整任务和结果",
		mount(r, params) {
			root = r;
			filter.agent = KINDS.includes(params[0]) ? params[0] : "all";
			filter.status = ["running", "done", "error", "aborted", "open"].includes(params[1]) ? params[1] : "all";
			root.innerHTML = `<section class="card">
				<div class="toolbar">
					<div class="seg" data-n="agents"></div>
					<select class="select" data-n="status" aria-label="按状态筛选">
						<option value="all">全部状态</option><option value="running">执行中</option><option value="done">完成</option>
						<option value="error">失败</option><option value="aborted">中止 / 中断</option><option value="open">无结果</option>
					</select>
					<input class="search" data-n="q" type="search" placeholder="搜索任务、会话、目录…" />
					<span class="card-note" data-n="count"></span>
				</div>
				<div class="table-wrap"><table class="table">
					<thead><tr><th>时间</th><th>成员</th><th class="hide-sm">模型</th><th class="w-task">任务</th><th>状态</th><th class="num">耗时</th><th class="num hide-sm">花费</th><th class="hide-sm">改动</th></tr></thead>
					<tbody data-n="rows"></tbody>
				</table></div>
			</section>`;
			const seg = root.querySelector('[data-n="agents"]');
			seg.innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${k}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : AGENT_LABEL[k]}</button>`).join("");
			seg.addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest("button") : null;
				if (!b) return;
				filter.agent = b.dataset.k;
				this.update("all");
			});
			root.querySelector('[data-n="status"]').value = filter.status;
			root.querySelector('[data-n="status"]').addEventListener("change", (e) => {
				filter.status = e.target.value;
				this.update("all");
			});
			root.querySelector('[data-n="q"]').addEventListener("input", (e) => {
				filter.q = e.target.value.trim().toLowerCase();
				this.update("all");
			});
			root.querySelector('[data-n="rows"]').addEventListener("click", (e) => {
				if (e.target instanceof Element && e.target.closest("button")) return;
				const tr = e.target instanceof Element ? e.target.closest("tr[data-id]") : null;
				if (tr) openDispatch(tr.dataset.id);
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "state") return;
			for (const b of root.querySelectorAll('[data-n="agents"] button')) b.classList.toggle("on", b.dataset.k === filter.agent);
			const all = dispatchRows();
			const rows = all.filter((d) => {
				if (filter.agent !== "all" && d.agent !== filter.agent) return false;
				if (filter.status !== "all") {
					if (filter.status === "aborted" ? !(d.status === "aborted" || d.status === "interrupted") : d.status !== filter.status) return false;
				}
				if (filter.q && ![d.task, d.sessionId, d.cwd, d.callId].some((v) => String(v ?? "").toLowerCase().includes(filter.q))) return false;
				return true;
			});
			root.querySelector('[data-n="count"]').textContent = `${rows.length} / ${all.length}`;
			const tbody = root.querySelector('[data-n="rows"]');
			if (!rows.length) {
				tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${all.length ? "没有符合条件的派工" : "还没有派工记录"}</td></tr>`;
				return;
			}
			tbody.innerHTML = rows
				.map((d) => {
					const started = d.slot ? slotStart.get(d.callId) : undefined;
					const took = d.status === "running" && started ? duration(Date.now() - started) : duration(d.durationMs);
					return `<tr data-id="${esc(d.key ?? d.callId)}" data-s="${d.status}">
						<td class="mono">${stamp(d.at)}</td>
						<td>${agentTag(d.agent)}</td>
						<td class="hide-sm">${d.model ? `<span class="model-chip">${esc(d.model)}</span>` : `<span class="muted">—</span>`}</td>
						<td class="w-task"><span class="cell-task">${d.resume ? `<span class="resume-tag">续接</span>` : ""}${d.basedOn ? `<span class="resume-tag">基于 #${esc(d.basedOn)}</span>` : ""}${esc(short(d.task, 140) || "—")}</span></td>
						<td><span class="pill" data-s="${PILL[d.status]}">${STATUS_LABEL[d.status]}</span></td>
						<td class="num mono">${took}</td>
						<td class="num mono hide-sm" title="${d.costEstimated ? "按单价估算" : ""}">${money(d.cost)}${d.costEstimated ? "≈" : ""}</td>
						<td class="hide-sm">${d.changeId ? changeLink(d.changeId) : `<span class="muted">—</span>`}</td>
					</tr>`;
				})
				.join("");
		},
	};
}

// =====================================================================
// 改动（工作区隔离）
// =====================================================================
const CHANGE_LABEL = { running: "进行中", pending: "待合并", conflict: "有冲突", applied: "已合并", empty: "无改动", dropped: "已丢弃" };
const CHANGE_PILL = { running: "running", pending: "pending", conflict: "error", applied: "done", empty: "aborted", dropped: "aborted" };

/** 统一差异 → 带行号的着色视图（先转义，不信任内容） */
function renderDiff(text) {
	if (!text.trim()) return `<div class="empty-inline"><span class="dot"></span>没有差异</div>`;
	const out = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git")) {
			const file = line.replace(/^diff --git a\/(.+?) b\/.+$/, "$1");
			out.push(`<div class="df-file">${esc(file)}</div>`);
			continue;
		}
		if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			out.push(`<div class="df-hunk"><span></span><span></span><code>${esc(line)}</code></div>`);
			continue;
		}
		if (line.startsWith("+")) out.push(`<div class="df-line add"><span></span><span>${newNo++}</span><code>${esc(line)}</code></div>`);
		else if (line.startsWith("-")) out.push(`<div class="df-line del"><span>${oldNo++}</span><span></span><code>${esc(line)}</code></div>`);
		else if (line.startsWith("\\")) out.push(`<div class="df-line meta"><span></span><span></span><code>${esc(line)}</code></div>`);
		else if (line.length || oldNo) out.push(`<div class="df-line"><span>${oldNo++}</span><span>${newNo++}</span><code>${esc(line || " ")}</code></div>`);
	}
	return `<div class="diff">${out.join("")}</div>`;
}

function changes() {
	let root;
	let selected = null;
	let filter = "active";
	let shown = null;
	const diffs = new Map(); // id@head -> 差异文本
	return {
		title: "改动",
		sub: "每次派工都在独立的 git worktree 里干活；改动要你在终端确认后才合并到主目录",
		mount(r, params) {
			root = r;
			selected = params[0] ?? null;
			root.innerHTML = `<div class="runs-layout changes-layout">
				<section class="card run-list"><header class="card-head"><h2 class="card-title">改动</h2>
					<div class="seg" data-n="filter">${segButtons([["active", "待处理"], ["all", "全部"]], filter)}</div></header>
					<div class="run-scroll" data-n="list"></div></section>
				<section class="card run-detail" data-n="detail"></section>
			</div>`;
			root.querySelector('[data-n="filter"]').addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest("button") : null;
				if (!b) return;
				filter = b.dataset.k;
				for (const x of root.querySelectorAll('[data-n="filter"] button')) x.classList.toggle("on", x === b);
				this.update("all");
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "tick" || kind === "live" || kind === "items") return;
			const all = store.changes;
			const list = filter === "all" ? all : all.filter((c) => ["pending", "conflict", "running"].includes(c.status));
			const target = all.find((c) => c.id === selected) ?? list[0];
			const box = root.querySelector('[data-n="list"]');
			box.innerHTML = list.length
				? list
						.map(
							(c) => `<a class="run-row change-row${target && c.id === target.id ? " active" : ""}" href="#/changes/${c.id}">
						<span class="run-top"><span class="mono">#${esc(c.id)}</span><span class="pill" data-s="${CHANGE_PILL[c.status]}">${CHANGE_LABEL[c.status] ?? c.status}</span></span>
						<span class="run-input">${esc(short(c.task, 80))}</span>
						<span class="run-foot">${agentTag(c.agent)}${c.model ? `<span class="model-chip">${esc(c.model)}</span>` : ""}<span class="run-meta">${c.files.length} 个文件 <b class="ok-t">+${c.add}</b> <b class="err-t">−${c.del}</b></span></span>
					</a>`,
						)
						.join("")
				: `<div class="empty-inline"><span class="dot"></span>${all.length ? "没有待处理的改动" : store.state?.isolation?.enabled === false ? "工作区隔离没有开启" : "还没有隔离派工的改动"}</div>`;
			this.detail(target);
		},
		async detail(c) {
			const box = root.querySelector('[data-n="detail"]');
			if (!c) {
				shown = null;
				box.innerHTML = `<div class="card-body">${empty("选择左侧的一个改动查看差异")}</div>`;
				return;
			}
			const key = `${c.id}@${c.head}@${c.status}`;
			if (shown === key) return;
			shown = key;
			const cmd = (verb) => `/${verb} ${c.id}`;
			const actionable = c.status === "pending" || c.status === "conflict";
			const dispatch = store.dispatches.find((d) => d.changeId === c.id);
			box.innerHTML = `<header class="detail-head">
					<div><h2 class="eyebrow">改动 #${esc(c.id)}</h2><p class="detail-title"></p></div>
					<span class="pill" data-s="${CHANGE_PILL[c.status]}">${CHANGE_LABEL[c.status] ?? c.status}</span>
				</header>
				<div class="detail-meta">${[
					agentTag(c.agent),
					c.model ? `<span class="model-chip">${esc(c.model)}</span>` : "",
					`<span class="mono" title="分支">${esc(c.branch)}</span>`,
					c.basedOn ? `<a class="card-link inline" href="#/changes/${esc(c.basedOn)}">基于 #${esc(c.basedOn)}</a>` : "",
					`${ago(c.createdAt)}`,
					dispatch ? `<button type="button" class="linkish" data-open-dispatch="${esc(dispatch.key)}">查看派工</button>` : "",
				]
					.filter(Boolean)
					.join('<span class="sep"></span>')}</div>
				<div class="detail-scroll">
					${
						actionable
							? `<div class="apply-hint"><span>在终端里确认：</span>
								<button type="button" class="copy-cmd mono" data-copy="${cmd("apply")}" title="复制">${cmd("apply")}</button>
								<button type="button" class="copy-cmd mono" data-copy="${cmd("drop")}" title="复制">${cmd("drop")}</button>
								<span class="muted">合并只改工作区、不提交；冲突时不会动你的文件。</span></div>`
							: ""
					}
					${c.message ? `<div class="change-msg${c.status === "conflict" ? " err" : ""}">${esc(c.message)}</div>` : ""}
					<h3 class="eyebrow">改了哪些文件 <span class="eyebrow-note">${c.files.length} 个 · +${c.add} −${c.del}</span></h3>
					<div class="file-list">${
						c.files.length
							? c.files
									.map(
										(f) => `<div class="file-row"><span class="mono">${esc(f.path)}</span><span class="file-bar"><i class="a" style="flex:${f.add}"></i><i class="d" style="flex:${f.del}"></i></span><span class="mono"><b class="ok-t">+${f.add}</b> <b class="err-t">−${f.del}</b></span></div>`,
									)
									.join("")
							: `<div class="empty-inline"><span class="dot"></span>${c.status === "running" ? "还在进行中" : "没有修改文件"}</div>`
					}</div>
					<h3 class="eyebrow">差异</h3>
					<div data-n="diff"><div class="empty-inline"><span class="dot"></span>加载中…</div></div>
				</div>`;
			const title = box.querySelector(".detail-title");
			title.textContent = c.task;
			// 真实总调度写的任务说明常常很长：默认两行，点击展开
			if (c.task.length > 90) {
				title.classList.add("clamp");
				title.title = "点击展开 / 收起";
				title.addEventListener("click", () => title.classList.toggle("clamp"));
			}
			box.querySelector("[data-open-dispatch]")?.addEventListener("click", (e) => openDispatch(e.currentTarget.dataset.openDispatch));
			if (!c.files.length) {
				box.querySelector('[data-n="diff"]').innerHTML = "";
				return;
			}
			let data = diffs.get(key);
			if (!data) {
				try {
					data = await getJson(`/api/changes/${encodeURIComponent(c.id)}/diff`);
					diffs.set(key, data);
				} catch (err) {
					data = { text: "", error: err.message };
				}
			}
			if (shown !== key) return;
			box.querySelector('[data-n="diff"]').innerHTML =
				(data.error ? `<div class="change-msg err">${esc(data.error)}</div>` : renderDiff(data.text)) +
				(data.truncated ? `<p class="footnote">差异太长，只显示了前一部分。完整内容：git diff ${esc(c.base.slice(0, 8))} ${esc(c.branch)}</p>` : "");
		},
	};
}

// =====================================================================
// 成员
// =====================================================================
function agents() {
	let root;
	return {
		title: "成员",
		sub: "本机 CLI 的可用性、实际生效的参数和工作统计（配置只读，修改请编辑配置文件后重启终端）",
		mount(r) {
			root = r;
			this.update("all");
		},
		update(kind) {
			if (kind === "tick") return;
			const list = store.state?.agents;
			if (!list) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const stats = store.state.agentStats ?? {};
			const busy = new Set(store.live.tools.filter((t) => t.status === "running").map((t) => kindOf(t.name)));
			root.innerHTML = `<div class="agent-grid">${list
				.map((a) => {
					const s = stats[a.kind] ?? { total: 0, done: 0, error: 0, aborted: 0, open: 0, durationMs: 0, timed: 0, cost: 0 };
					const state = !a.available ? "off" : busy.has(a.kind) ? "busy" : "idle";
					const finished = s.done + s.error + s.aborted;
					const figures = [
						["派工", s.total],
						["完成", s.done],
						["失败", s.error],
						["中止", s.aborted],
						["成功率", finished ? `${Math.round((s.done / finished) * 100)}%` : "—"],
						["平均耗时", s.timed ? duration(s.durationMs / s.timed) : "—"],
						["累计花费", money(s.cost)],
						["最近", s.lastAt ? ago(s.lastAt) : "—"],
					];
					const config = [
						[
							"启动命令",
							a.command
								? `<button type="button" class="cmd-chip" data-copy="${esc(a.command.join(" "))}" title="${esc(a.command.join(" "))}（点击复制）"><span>${esc(a.command.map((p) => p.split(/[\\/]/).pop()).join(" "))}</span></button>`
								: `<span class="muted">${esc(a.reason ?? "未找到")}</span>`,
						],
						["附加参数", a.extraArgs.length ? `<code>${esc(a.extraArgs.join(" "))}</code>` : "—"],
						["超时", `${a.timeoutMinutes} 分钟`],
						["输出上限", `${num(a.maxOutputChars)} 字符`],
						["会话续接", a.canResume ? "支持" : "不支持"],
						["启用", a.enabled ? "是" : "否（配置中禁用）"],
					];
					return `<section class="card agent-card" data-state="${state}" style="--c:${agentColor(a.kind)}">
						<header class="agent-head"><span class="lamp"></span><h2>${esc(a.label)}</h2>
							<span class="pill" data-s="${state === "busy" ? "running" : state === "off" ? "error" : "done"}">${state === "busy" ? "执行中" : state === "off" ? "不可用" : "可用"}</span></header>
						<p class="agent-desc">${esc(a.available ? a.description : a.reason)}</p>
						<div class="figures">${figures.map(([k, v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div>
						${segBar([
							{ value: s.done, color: "var(--ok)", label: "完成" },
							{ value: s.error, color: "var(--danger)", label: "失败" },
							{ value: s.aborted, color: "var(--muted)", label: "中止" },
						])}
						${modelList(a)}
						<dl class="kvs">${config.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
						<a class="card-link" href="#/dispatches/${a.kind}">查看 ${esc(a.label)} 的派工 →</a>
					</section>`;
				})
				.join("")}</div>`;
		},
	};
}

// =====================================================================
// CLI 会话
// =====================================================================
function sessions() {
	let root;
	let agent = "all";
	return {
		title: "CLI 会话",
		sub: "各成员 CLI 的会话登记表。总调度续接时会自动回到会话建立时的目录",
		mount(r) {
			root = r;
			root.innerHTML = `<section class="card"><div class="toolbar"><div class="seg" data-n="agents"></div><span class="card-note" data-n="count"></span></div>
				<div class="table-wrap"><table class="table"><thead><tr><th>成员</th><th>会话 ID</th><th>目录</th><th>最近使用</th><th class="num hide-sm">派工</th><th>续接命令</th></tr></thead><tbody data-n="rows"></tbody></table></div></section>`;
			const seg = root.querySelector('[data-n="agents"]');
			seg.innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${k}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : AGENT_LABEL[k]}</button>`).join("");
			seg.addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest("button") : null;
				if (!b) return;
				agent = b.dataset.k;
				this.update("all");
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "tick" || kind === "live") return;
			for (const b of root.querySelectorAll('[data-n="agents"] button')) b.classList.toggle("on", b.dataset.k === agent);
			const all = store.state?.sessions ?? [];
			const list = all.filter((s) => agent === "all" || s.agent === agent);
			root.querySelector('[data-n="count"]').textContent = `${list.length} / ${all.length}`;
			root.querySelector('[data-n="rows"]').innerHTML = list.length
				? list
						.map(
							(s) => `<tr>
						<td>${agentTag(s.agent)}</td>
						<td><button type="button" class="linkish mono" data-copy="${esc(s.id)}" title="复制">${esc(s.id)}</button></td>
						<td class="mono dim" title="${esc(s.cwd)}">${esc(s.cwd)}</td>
						<td title="${esc(stamp(s.updatedAt))}">${ago(s.updatedAt)}</td>
						<td class="num mono hide-sm">${s.uses}</td>
						<td>${s.resume ? `<button type="button" class="copy-cmd mono" data-copy="${esc(s.resume)}" title="在 ${esc(s.cwd)} 里执行">${esc(s.resume)}</button>` : "—"}</td>
					</tr>`,
						)
						.join("")
				: `<tr class="empty-row"><td colspan="6">${store.state ? "还没有会话" : "加载中…"}</td></tr>`;
		},
	};
}

// =====================================================================
// 用量
// =====================================================================
/** 活动柱状图：按小时（24 根）或按天（14 根），每根按成员堆叠 */
function activityChart(rows, mode) {
	const hours = mode === "day";
	const n = hours ? 24 : 14;
	const span = hours ? 3_600_000 : 86_400_000;
	const now = new Date();
	// 对齐到整点 / 当天零点，最后一根是"当前这一小时/今天"
	const end = hours ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1).getTime() : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
	const buckets = Array.from({ length: n }, (_, i) => ({ start: end - (n - i) * span, by: Object.fromEntries(KINDS.map((k) => [k, 0])), total: 0 }));
	for (const d of rows) {
		if (!d.at) continue;
		const i = n - 1 - Math.floor((end - 1 - d.at) / span);
		if (i < 0 || i >= n) continue;
		buckets[i].by[d.agent] = (buckets[i].by[d.agent] ?? 0) + 1;
		buckets[i].total++;
	}
	const max = Math.max(1, ...buckets.map((b) => b.total));
	const W = 100 / n;
	const label = (b, i) => {
		const d = new Date(b.start);
		if (hours) return i % 3 === 0 ? `${String(d.getHours()).padStart(2, "0")}:00` : "";
		return i % 2 === 0 || n <= 7 ? `${d.getMonth() + 1}/${d.getDate()}` : "";
	};
	const cols = buckets
		.map((b, i) => {
			const segs = KINDS.filter((k) => b.by[k] > 0)
				.map((k) => `<i style="flex:${b.by[k]};background:${agentColor(k)}"></i>`)
				.join("");
			const tip = `${hours ? `${String(new Date(b.start).getHours()).padStart(2, "0")}:00–${String(new Date(b.start + span).getHours()).padStart(2, "0")}:00` : `${new Date(b.start).getMonth() + 1} 月 ${new Date(b.start).getDate()} 日`}：${b.total} 次${b.total ? `（${KINDS.filter((k) => b.by[k]).map((k) => `${AGENT_LABEL[k]} ${b.by[k]}`).join("、")}）` : ""}`;
			return `<div class="act-col" style="width:${W}%" title="${esc(tip)}">
				<div class="act-bar" style="height:${(b.total / max) * 100}%">${segs}</div>
				<span class="act-label">${label(b, i)}</span>
			</div>`;
		})
		.join("");
	const total = buckets.reduce((s, b) => s + b.total, 0);
	return { html: `<div class="act-chart"><div class="act-grid"><span>${max}</span><span>${Math.round(max / 2)}</span><span>0</span></div><div class="act-cols">${cols}</div></div>`, total };
}

function usage() {
	let root;
	let mode = "day";
	return {
		title: "用量",
		sub: "总调度模型的 token，以及成员 CLI 的派工量、耗时和花费",
		mount(r) {
			root = r;
			root.addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest('[data-n="actMode"] button') : null;
				if (!b) return;
				mode = b.dataset.k;
				this.update("all");
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "tick" || kind === "live") return;
			const state = store.state;
			if (!state) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const models = state.usage;
			const stats = state.agentStats ?? {};
			const sum = (f) => models.reduce((s, u) => s + f(u), 0);
			const input = sum((u) => u.input);
			const output = sum((u) => u.output);
			const cacheRead = sum((u) => u.cacheRead);
			const orchCost = sum((u) => u.cost);
			const t = totals();
			const hit = input + cacheRead ? Math.round((cacheRead / (input + cacheRead)) * 100) : null;
			const act = activityChart(dispatchRows(), mode);
			const maxTotal = Math.max(1, ...KINDS.map((k) => stats[k]?.total ?? 0));
			const maxTime = Math.max(1, ...KINDS.map((k) => stats[k]?.durationMs ?? 0));
			const maxCost = Math.max(1e-9, ...KINDS.map((k) => stats[k]?.cost ?? 0));
			const inline = (v, max, color, text) => `<span class="inline-bar"><i style="width:${max ? Math.max(v ? 3 : 0, (v / max) * 100) : 0}%;background:${color}"></i></span><span class="mono">${text}</span>`;
			root.innerHTML = `
				<div class="kpis kpis-4">
					<div class="kpi"><div class="kpi-top"><span class="kpi-label">总调度 tokens</span></div><strong>${num(input + output)}</strong><span class="kpi-sub">输入 ${num(input)} · 输出 ${num(output)}</span></div>
					<div class="kpi"><div class="kpi-top"><span class="kpi-label">缓存命中</span></div><strong>${hit === null ? "—" : `${hit}%`}</strong><span class="kpi-sub">缓存读 ${num(cacheRead)} tokens</span></div>
					<div class="kpi"><div class="kpi-top"><span class="kpi-label">花费</span></div><strong>${money(t.cost + orchCost)}</strong><span class="kpi-sub">成员 ${money(t.cost)} · 总调度 ${orchCost ? money(orchCost) : "—"}</span></div>
					<div class="kpi"><div class="kpi-top"><span class="kpi-label">成员累计耗时</span></div><strong>${duration(t.durationMs)}</strong><span class="kpi-sub">${t.total} 次派工</span></div>
				</div>
				<section class="card">
					<header class="card-head"><div class="card-heading"><h2 class="card-title">派工活动</h2><div class="card-sub"><span><b>${act.total}</b> 次 · ${mode === "day" ? "最近 24 小时，每小时" : "最近 14 天，每天"}</span></div></div>
						<div class="act-legend">${KINDS.map((k) => `<span><i style="background:${agentColor(k)}"></i>${AGENT_LABEL[k]}</span>`).join("")}</div>
						<div class="seg" data-n="actMode">${segButtons([["day", "24 小时"], ["week", "14 天"]], mode)}</div></header>
					<div class="card-body">${act.html}</div>
				</section>
				<section class="card">
					<header class="card-head"><h2 class="card-title">成员明细</h2><span class="card-note">花费：Claude 自报；Codex、Gemini 按配置的单价估算，没配单价计为 0</span></header>
					<div class="table-wrap"><table class="table">
						<thead><tr><th>成员</th><th>派工</th><th class="hide-sm">完成 / 失败 / 中止</th><th>成功率</th><th class="hide-sm">平均耗时</th><th>累计耗时</th><th>花费</th></tr></thead>
						<tbody>${KINDS.map((k) => {
							const s = stats[k] ?? { total: 0, done: 0, error: 0, aborted: 0, durationMs: 0, timed: 0, cost: 0 };
							const finished = s.done + s.error + s.aborted;
							return `<tr>
								<td>${agentTag(k)}</td>
								<td class="cell-bar">${inline(s.total, maxTotal, agentColor(k), `${s.total}`)}</td>
								<td class="mono hide-sm"><span class="ok-t">${s.done}</span> / <span class="err-t">${s.error}</span> / ${s.aborted}</td>
								<td class="mono">${finished ? `${Math.round((s.done / finished) * 100)}%` : "—"}</td>
								<td class="mono hide-sm">${s.timed ? duration(s.durationMs / s.timed) : "—"}</td>
								<td class="cell-bar">${inline(s.durationMs, maxTime, agentColor(k), duration(s.durationMs))}</td>
								<td class="cell-bar">${inline(s.cost, maxCost, agentColor(k), money(s.cost))}</td>
							</tr>`;
						}).join("")}</tbody>
					</table></div>
				</section>
				<section class="card">
					<header class="card-head"><div class="card-heading"><h2 class="card-title">按模型对比</h2><div class="card-sub">总调度派工时选的模型；≈ 表示按配置的单价估算</div></div></header>
					<div class="table-wrap"><table class="table">
						<thead><tr><th>成员</th><th>模型</th><th class="num">派工</th><th class="num">成功率</th><th class="num hide-sm">平均耗时</th><th class="num">花费</th><th class="num hide-sm">每次平均</th></tr></thead>
						<tbody>${
							(state.modelStats ?? []).length
								? state.modelStats
										.map((m) => {
											const fin = m.done + m.error;
											return `<tr><td>${agentTag(m.agent)}</td><td><span class="model-chip">${esc(m.model)}</span></td><td class="num mono">${m.total}</td><td class="num mono">${fin ? `${Math.round((m.done / fin) * 100)}%` : "—"}</td><td class="num mono hide-sm">${m.timed ? duration(m.durationMs / m.timed) : "—"}</td><td class="num mono">${money(m.cost)}${m.estimated ? "≈" : ""}</td><td class="num mono hide-sm">${m.total ? money(m.cost / m.total) : "—"}</td></tr>`;
										})
										.join("")
								: `<tr class="empty-row"><td colspan="7">还没有派工</td></tr>`
						}</tbody>
					</table></div>
				</section>
				<section class="card">
					<header class="card-head"><h2 class="card-title">总调度模型</h2><span class="card-note">${esc(state.orchestrator.describe)}</span></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num hide-sm">缓存写</th><th class="num">花费</th></tr></thead>
					<tbody>${models.length ? models.map((u) => `<tr><td class="mono">${esc(u.model)}</td><td class="num mono">${num(u.input)}</td><td class="num mono">${num(u.output)}</td><td class="num mono">${num(u.cacheRead)}</td><td class="num mono hide-sm">${num(u.cacheWrite)}</td><td class="num mono">${u.cost ? money(u.cost) : "—"}</td></tr>`).join("") : `<tr class="empty-row"><td colspan="6">还没有用量</td></tr>`}</tbody></table></div>
					<p class="footnote">花费按模型定价计算；自定义的中转站模型没有定价时显示为 —。</p>
				</section>`;
		},
	};
}

// =====================================================================
// 配置
// =====================================================================
function config() {
	let root;
	return {
		title: "配置",
		sub: "当前进程实际生效的配置（只读）。修改请编辑配置文件，然后重启终端",
		mount(r) {
			root = r;
			this.update("all");
		},
		update(kind) {
			if (kind !== "all" && kind !== "state" && kind !== "snapshot") return;
			const s = store.state;
			if (!s) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const o = s.orchestrator;
			const dl = (rows) => `<dl class="kvs wide">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
			const code = (v) => `<code>${esc(v)}</code>`;
			root.innerHTML = `
				<section class="card"><header class="card-head"><h2 class="card-title">进程</h2>${s.demo ? `<span class="demo-badge">演示模式</span>` : ""}</header>
					<div class="card-body">${dl([
						["配置文件", `<button type="button" class="linkish mono" data-copy="${esc(s.configPath)}">${esc(s.configPath)}</button>`],
						["工作目录", code(s.workdir)],
						["会话存储", code(s.storage)],
						["历史条目", num(s.entries)],
						["进程", `pid ${s.pid} · 已运行 ${duration(Date.now() - s.startedAt)}`],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">总调度</h2></header>
					<div class="card-body">${dl([
						["协议", code(o.type)],
						["模型", code(o.modelId)],
						["地址", o.host ? code(o.host) : "—"],
						["密钥来源", esc(o.keySource)],
						["最多轮数", o.maxTurns],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">成员 CLI</h2></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>成员</th><th>状态</th><th>附加参数</th><th class="num">超时</th><th class="num hide-sm">输出上限</th></tr></thead>
					<tbody>${s.agents.map((a) => `<tr><td>${agentTag(a.kind)}</td><td>${a.available ? "可用" : `<span class="muted">${esc(a.reason)}</span>`}</td><td class="mono">${esc(a.extraArgs.join(" ") || "—")}</td><td class="num mono">${a.timeoutMinutes}m</td><td class="num mono hide-sm">${num(a.maxOutputChars)}</td></tr>`).join("")}</tbody></table></div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">工作区隔离与预算</h2></header>
					<div class="card-body">${dl([
						["工作区隔离", s.isolation?.enabled ? "开启：每次新派工在独立的 git worktree 里干活，改动在终端 /apply 后才合并" : "关闭：成员直接在工作目录里改文件"],
						["挂进 worktree 的目录", (s.isolation?.linkDirs ?? []).map((d) => code(d)).join(" ") || "—"],
						["单次运行花费上限", s.budget?.perRunUsd != null ? `${money(s.budget.perRunUsd)}（超过后不再派工）` : "不限"],
						["总调度单价", s.orchestrator.price ? `输入 $${s.orchestrator.price.input} · 输出 $${s.orchestrator.price.output} / 百万 tokens` : "未配置（总调度花费显示为 —）"],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">启动子 CLI 前去掉的环境变量</h2></header>
					<div class="card-body chips">${s.stripEnv.map((p) => `<code>${esc(p)}</code>`).join("")}</div></section>`;
		},
	};
}

export const VIEWS = { overview, runs, dispatches, changes, agents, sessions, usage, config };
