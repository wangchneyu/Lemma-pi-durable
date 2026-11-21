// 后台各页面。每个页面：mount(root, params) 渲染，update(kind, payload) 响应数据变化，unmount() 清理。
import { openDispatch } from "./drawer.js";
import { RouteMap } from "./routemap.js";
import { METRICS, RANGES, Sankey } from "./sankey.js";
import { buildRuns, callInfo, dispatchRows, loadEarlier, store } from "./store.js";
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
} from "./util.js";

const RUN_LABEL = { running: "进行中", done: "完成", error: "失败", aborted: "已中止", open: "未完成" };
const PILL = { running: "running", done: "done", error: "error", aborted: "aborted", interrupted: "aborted", open: "aborted" };

function card(title, extra = "") {
	const node = el("section", "card");
	node.innerHTML = `<header class="card-head"><h2 class="eyebrow">${title}</h2>${extra}</header><div class="card-body"></div>`;
	return node;
}
function empty(text) {
	return `<div class="empty-state">${esc(text)}</div>`;
}
function agentTag(kind) {
	return `<span class="agent-tag" style="--c:${agentColor(kind)}"><i></i>${esc(AGENT_LABEL[kind] ?? kind)}</span>`;
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
		return { mode: "flow", metric: "count", range: "all", ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
	} catch {
		return { mode: "flow", metric: "count", range: "all" };
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

function overview() {
	let root;
	let map;
	let sankey;
	const tickets = new Map();
	return {
		title: "总览",
		sub: "当前运行状态、路由和最近的活动",
		mount(r) {
			root = r;
			root.innerHTML = `<div class="kpis" data-n="kpis"></div>`;
			const prefs = loadPrefs();
			const routes = card("路由分配", `<span class="card-note" data-n="routeSum"></span>`);
			const body = routes.querySelector(".card-body");
			body.innerHTML = `<div class="route-controls">
				<div class="seg" data-n="mode" role="tablist">${segButtons([["flow", "流向图"], ["topo", "实时拓扑"]], prefs.mode)}</div>
				<div class="flow-opts" data-n="flowOpts">
					<div class="seg" data-n="metric" title="带子宽度按什么算">${segButtons(Object.entries(METRICS).map(([k, m]) => [k, m.label]), prefs.metric)}</div>
					<div class="seg" data-n="range" title="时间范围">${segButtons(Object.entries(RANGES).map(([k, m]) => [k, m.label]), prefs.range)}</div>
				</div>
			</div>`;
			map = new RouteMap();
			sankey = new Sankey();
			sankey.metric = prefs.metric in METRICS ? prefs.metric : "count";
			sankey.range = prefs.range in RANGES ? prefs.range : "all";
			body.append(sankey.node, map.node);
			const apply = () => {
				const flow = prefs.mode !== "topo";
				sankey.node.hidden = !flow;
				map.node.hidden = flow;
				body.querySelector('[data-n="flowOpts"]').hidden = !flow;
				for (const seg of body.querySelectorAll(".seg")) {
					const value = prefs[seg.dataset.n];
					for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.k === value);
				}
				if (flow) sankey.render(true);
				else map.render();
			};
			body.querySelector(".route-controls").addEventListener("click", (e) => {
				const b = e.target instanceof Element ? e.target.closest(".seg button") : null;
				if (!b) return;
				const which = b.closest(".seg").dataset.n;
				prefs[which] = b.dataset.k;
				savePrefs(prefs);
				if (which === "metric" || which === "range") sankey[which] = b.dataset.k;
				apply();
			});
			root.append(routes);
			apply();
			const grid = el("div", "grid-2");
			const running = card("正在执行");
			running.querySelector(".card-body").dataset.n = "running";
			const recent = card("最近运行", `<a class="card-link" href="#/runs">全部 →</a>`);
			recent.querySelector(".card-body").dataset.n = "recent";
			grid.append(running, recent);
			root.append(grid);
			const members = card("成员", `<a class="card-link" href="#/agents">详情 →</a>`);
			members.querySelector(".card-body").dataset.n = "members";
			root.append(members);
			this.update("all");
		},
		unmount() {
			map?.destroy();
			sankey?.destroy();
			tickets.clear();
		},
		update(kind, payload) {
			const q = (n) => root.querySelector(`[data-n="${n}"]`);
			if (!map.node.hidden) {
				if (kind === "items") map.animate(payload);
				map.render();
			}
			// 按次数看时，计时刷新不改变流向，跳过；按耗时看时每秒更新带子宽度
			if (!sankey.node.hidden && (kind !== "tick" || sankey.metric === "time")) sankey.render();
			if (kind !== "tick") this.kpis(q("kpis"));
			this.running(q("running"));
			if (kind !== "tick" && kind !== "live") {
				this.recent(q("recent"));
				this.members(q("members"));
			}
			const t = totals();
			q("routeSum").textContent = t.total ? `累计派工 ${t.total} 次` : "";
		},
		kpis(box) {
			const { live, state } = store;
			const t = totals();
			const finished = t.done + t.error + t.aborted;
			const running = live.tools.filter((x) => x.status === "running").length;
			let status = "待命";
			let statusSub = "等待终端下发任务";
			let tone = "idle";
			if (live.busy) {
				status = `调度中`;
				statusSub = `第 ${live.turns + 1} 轮${running ? ` · ${running} 名成员执行中` : " · 规划中"}`;
				tone = "busy";
			} else if (live.runFailure && live.runFailure.reason !== "aborted") {
				status = "上一轮未完成";
				statusSub = FAILURE_LABEL[live.runFailure.reason] ?? live.runFailure.reason;
				tone = "failed";
			} else if (live.runFailure) {
				statusSub = "上一轮已中止";
			}
			const tokens = (state?.usage ?? []).reduce((n, u) => n + u.input + u.output, 0);
			const orchCost = (state?.usage ?? []).reduce((n, u) => n + u.cost, 0);
			const tiles = [
				{ label: "状态", value: status, sub: statusSub, tone },
				{ label: "累计派工", value: num(t.total), sub: `完成 ${t.done} · 失败 ${t.error} · 中止 ${t.aborted}` },
				{ label: "成功率", value: finished ? `${Math.round((t.done / finished) * 100)}%` : "—", sub: finished ? `${finished} 次已结束` : "还没有结束的派工" },
				{ label: "成员花费", value: money(t.cost), sub: `CLI 自报 · 累计 ${duration(t.durationMs)}` },
				{ label: "总调度 tokens", value: num(tokens), sub: orchCost ? `约 ${money(orchCost)}` : state?.orchestrator?.modelId ?? "" },
			];
			box.innerHTML = tiles
				.map((k) => `<div class="kpi" data-tone="${k.tone ?? ""}"><span class="kpi-label">${k.label}</span><strong>${esc(k.value)}</strong><span class="kpi-sub">${esc(k.sub)}</span></div>`)
				.join("");
		},
		running(box) {
			const active = store.live.tools.filter((t) => t.status !== "done");
			if (!active.length) {
				tickets.clear();
				const text = store.live.busy ? "总调度正在规划，还没有派工" : "没有正在执行的派工";
				if (box.textContent !== text) box.innerHTML = empty(text);
				return;
			}
			box.querySelector(".empty-state")?.remove();
			let wrap = box.querySelector(".tickets");
			if (!wrap) {
				wrap = el("div", "tickets");
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
			const runs = buildRuns().filter((r) => !r.divider).slice(-6).reverse();
			box.innerHTML = runs.length ? `<div class="mini-runs">${runs.map(runRow).join("")}</div>` : empty("还没有运行记录。在终端里输入任务开始。");
		},
		members(box) {
			const agents = store.state?.agents ?? [];
			const stats = store.state?.agentStats ?? {};
			const busy = new Set(store.live.tools.filter((t) => t.status === "running").map((t) => kindOf(t.name)));
			box.innerHTML = `<div class="member-strip">${agents
				.map((a) => {
					const s = stats[a.kind] ?? { total: 0, done: 0, durationMs: 0, timed: 0, cost: 0 };
					const state = !a.available ? "off" : busy.has(a.kind) ? "busy" : "idle";
					return `<a class="member" href="#/agents" data-kind="${a.kind}" data-state="${state}" style="--c:${agentColor(a.kind)}">
						<span class="lamp"></span><span class="member-name">${esc(a.label)}</span>
						<span class="member-state">${state === "busy" ? "执行中" : state === "off" ? "不可用" : "待命"}</span>
						<span class="member-stats">派工 ${s.total} · 平均 ${s.timed ? duration(s.durationMs / s.timed) : "—"} · ${money(s.cost)}</span>
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
				<section class="card run-list"><header class="card-head"><h2 class="eyebrow">运行</h2><span class="card-note" data-n="count"></span></header>
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
					<thead><tr><th>时间</th><th>成员</th><th class="w-task">任务</th><th>状态</th><th class="num">耗时</th><th class="num hide-sm">花费</th><th class="hide-sm">会话</th></tr></thead>
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
				tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${all.length ? "没有符合条件的派工" : "还没有派工记录"}</td></tr>`;
				return;
			}
			tbody.innerHTML = rows
				.map((d) => {
					const started = d.slot ? slotStart.get(d.callId) : undefined;
					const took = d.status === "running" && started ? duration(Date.now() - started) : duration(d.durationMs);
					return `<tr data-id="${esc(d.key ?? d.callId)}" data-s="${d.status}">
						<td class="mono">${stamp(d.at)}</td>
						<td>${agentTag(d.agent)}</td>
						<td class="w-task"><span class="cell-task">${d.resume ? `<span class="resume-tag">续接</span>` : ""}${esc(short(d.task, 140) || "—")}</span></td>
						<td><span class="pill" data-s="${PILL[d.status]}">${STATUS_LABEL[d.status]}</span></td>
						<td class="num mono">${took}</td>
						<td class="num mono hide-sm">${money(d.cost)}</td>
						<td class="hide-sm">${d.sessionId ? `<button type="button" class="linkish mono" data-copy="${esc(d.sessionId)}" title="复制会话 ID">${esc(d.sessionId.slice(0, 8))}</button>` : "—"}</td>
					</tr>`;
				})
				.join("");
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
						["启动命令", a.command ? `<code>${esc(a.command.join(" "))}</code>` : `<span class="muted">${esc(a.reason ?? "未找到")}</span>`],
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
function usage() {
	let root;
	return {
		title: "用量",
		sub: "总调度模型的 token 和成员 CLI 的耗时、花费",
		mount(r) {
			root = r;
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
			const maxCost = Math.max(0.0001, ...KINDS.map((k) => stats[k]?.cost ?? 0));
			const maxTime = Math.max(1, ...KINDS.map((k) => stats[k]?.durationMs ?? 0));
			const maxCount = Math.max(1, ...KINDS.map((k) => stats[k]?.total ?? 0));
			const bars = (pick, max, fmt) =>
				KINDS.map((k) => {
					const v = pick(stats[k] ?? {});
					return `<div class="bar-row" style="--c:${agentColor(k)}"><span class="bar-label">${AGENT_LABEL[k]}</span><span class="bar"><i style="width:${Math.max(v ? 2 : 0, (v / max) * 100)}%"></i></span><span class="bar-value mono">${fmt(v)}</span></div>`;
				}).join("");
			root.innerHTML = `
				<section class="card"><header class="card-head"><h2 class="eyebrow">总调度模型</h2><span class="card-note">${esc(state.orchestrator.describe)}</span></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num hide-sm">缓存写</th><th class="num">花费</th></tr></thead>
					<tbody>${models.length ? models.map((u) => `<tr><td class="mono">${esc(u.model)}</td><td class="num mono">${num(u.input)}</td><td class="num mono">${num(u.output)}</td><td class="num mono">${num(u.cacheRead)}</td><td class="num mono hide-sm">${num(u.cacheWrite)}</td><td class="num mono">${u.cost ? money(u.cost) : "—"}</td></tr>`).join("") : `<tr class="empty-row"><td colspan="6">还没有用量</td></tr>`}</tbody></table></div>
					<p class="footnote">花费按模型定价计算；自定义的中转站模型没有定价时显示为 —。</p>
				</section>
				<div class="grid-3">
					<section class="card"><header class="card-head"><h2 class="eyebrow">派工次数</h2></header><div class="card-body bars">${bars((s) => s.total ?? 0, maxCount, (v) => `${v} 次`)}</div></section>
					<section class="card"><header class="card-head"><h2 class="eyebrow">累计耗时</h2></header><div class="card-body bars">${bars((s) => s.durationMs ?? 0, maxTime, (v) => duration(v))}</div></section>
					<section class="card"><header class="card-head"><h2 class="eyebrow">累计花费</h2></header><div class="card-body bars">${bars((s) => s.cost ?? 0, maxCost, (v) => money(v))}</div>
						<p class="footnote">成员花费来自 CLI 自己的报告：Claude 会报告；Codex、Gemini 走各自的订阅或配额，不报告时计为 0。</p></section>
				</div>`;
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
				<section class="card"><header class="card-head"><h2 class="eyebrow">进程</h2>${s.demo ? `<span class="demo-badge">演示模式</span>` : ""}</header>
					<div class="card-body">${dl([
						["配置文件", `<button type="button" class="linkish mono" data-copy="${esc(s.configPath)}">${esc(s.configPath)}</button>`],
						["工作目录", code(s.workdir)],
						["会话存储", code(s.storage)],
						["历史条目", num(s.entries)],
						["进程", `pid ${s.pid} · 已运行 ${duration(Date.now() - s.startedAt)}`],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="eyebrow">总调度</h2></header>
					<div class="card-body">${dl([
						["协议", code(o.type)],
						["模型", code(o.modelId)],
						["地址", o.host ? code(o.host) : "—"],
						["密钥来源", esc(o.keySource)],
						["最多轮数", o.maxTurns],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="eyebrow">成员 CLI</h2></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>成员</th><th>状态</th><th>附加参数</th><th class="num">超时</th><th class="num hide-sm">输出上限</th></tr></thead>
					<tbody>${s.agents.map((a) => `<tr><td>${agentTag(a.kind)}</td><td>${a.available ? "可用" : `<span class="muted">${esc(a.reason)}</span>`}</td><td class="mono">${esc(a.extraArgs.join(" ") || "—")}</td><td class="num mono">${a.timeoutMinutes}m</td><td class="num mono hide-sm">${num(a.maxOutputChars)}</td></tr>`).join("")}</tbody></table></div></section>
				<section class="card"><header class="card-head"><h2 class="eyebrow">启动子 CLI 前去掉的环境变量</h2></header>
					<div class="card-body chips">${s.stripEnv.map((p) => `<code>${esc(p)}</code>`).join("")}</div></section>`;
		},
	};
}

export const VIEWS = { overview, runs, dispatches, agents, sessions, usage, config };
