// 后台各页面。每个页面：mount(root, params) 渲染，update(kind, payload) 响应数据变化，unmount() 清理。
import { openDispatch } from "./drawer.js";
import { bindDagPanelEvents, classifyTopology, renderReviewLoopPanel, renderScopeMatrix, renderTaskDag } from "./dag.js";
import { openAutonomyEditor, openCreateIntegrationDialog, openLimitsEditor, openMemberEditor, openOrchestratorEditor, openRecoverDialog, openRepairIntegrationDialog, openResolveOperationDialog, runControlAction } from "./editors.js";
import { createChangesView } from "./gitlens.js";
import { METRICS, MODES, RANGES, Sankey } from "./sankey.js";
import { buildRuns, callInfo, dispatchRows, isDispatch, loadEarlier, pendingChanges, runningJobs, store } from "./store.js";
import { topology } from "./topology.js";
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
	markdown,
	money,
	num,
	short,
	stamp,
	toast,
	getJson,
	post,
} from "./util.js";

const RUN_LABEL = { running: "进行中", background: "后台进行中", done: "完成", partial: "有失败", error: "失败", aborted: "已中止", open: "未完成" };
const PILL = { running: "running", background: "running", done: "done", partial: "error", error: "error", aborted: "aborted", interrupted: "aborted", open: "aborted" };

function empty(text) {
	return `<div class="empty-state">${esc(text)}</div>`;
}
function agentTag(kind) {
	return `<span class="agent-tag" style="--c:${agentColor(kind)}"><i></i>${esc(AGENT_LABEL[kind] ?? kind)}</span>`;
}
const TIER = { economy: "经济", standard: "标准", premium: "强力" };
/** 成员可选的模型：档位、默认、用了多少次，支持一键设为默认 */
function modelList(agent) {
	if (!agent.models?.length) return `<div class="model-list"><span class="muted">没有配置模型清单，使用 CLI 自己的默认模型</span></div>`;
	const stats = (store.state?.modelStats ?? []).filter((m) => m.agent === agent.kind);
	const canEdit = store.state?.canEditSettings;
	return `<div class="model-list">${agent.models
		.map((m) => {
			const st = stats.find((x) => x.model === m.id);
			const isDef = m.id === agent.defaultModel;
			return `<div class="model-row" data-tier="${m.tier}">
				<span class="tier">${TIER[m.tier] ?? m.tier}</span>
				<span class="model-id mono">${esc(m.id)}${isDef ? `<em>默认</em>` : canEdit ? `<button type="button" class="linkish tiny" data-set-model="${esc(agent.kind)}" data-model="${esc(m.id)}">设为默认</button>` : ""}</span>
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
		return { mode: "member", metric: "count", range: "all", ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
	} catch {
		return { mode: "member", metric: "count", range: "all" };
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
		sub: "",
		mount(r) {
			root = r;
			root.innerHTML = "";
			const prefs = loadPrefs();
			const routes = el("section", "card routes-card");
			routes.innerHTML = `<header class="card-head">
					<div class="card-heading"><h2 class="card-title">路由分配</h2><div class="card-sub" data-n="routeSum"></div></div>
					<div class="route-controls">
						<div class="seg" data-n="mode" title="统计维度">${segButtons(Object.entries(MODES).map(([k, m]) => [k, m.label]), prefs.mode)}</div>
						<div class="seg" data-n="metric" title="带子宽度按什么算">${segButtons(Object.entries(METRICS).map(([k, m]) => [k, m.label]), prefs.metric)}</div>
						<div class="seg" data-n="range" title="时间范围">${segButtons(Object.entries(RANGES).map(([k, m]) => [k, m.label]), prefs.range)}</div>
					</div>
				</header>
				<div class="card-body chart-body"></div>`;
			const body = routes.querySelector(".chart-body");
			sankey = new Sankey();
			sankey.mode = prefs.mode in MODES ? prefs.mode : "member";
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
				this.activity();
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
			// 正在执行：只在有派工（同步或后台）在跑时出现，一行一个
			const strip = el("div", "ov-strip");
			strip.dataset.n = "strip";
			strip.hidden = true;
			root.prepend(strip);
			root.append(routes);
			const act = el("section", "card act-card");
			act.innerHTML = `<header class="card-head"><div class="card-heading"><h2 class="card-title">派工活动</h2><div class="card-sub" data-n="actSum"></div></div><div class="act-legend" data-n="actLegend"></div></header><div class="card-body" data-n="act"></div>`;
			root.append(act);
			// 路由图占满窗口剩下的高度（给下面的活动图留出位置）
			const fit = () => {
				const top = body.getBoundingClientRect().top + (root.closest(".content")?.scrollTop ?? 0);
				sankey.height = Math.round(window.innerHeight - top - 64 - act.offsetHeight - 18);
			};
			this.fit = () => {
				fit();
				sankey.render(true);
			};
			addEventListener("resize", this.fit);
			requestAnimationFrame(() => this.fit());
			apply();
			this.update("all");
		},
		unmount() {
			sankey?.destroy();
			tickets.clear();
			if (this.fit) removeEventListener("resize", this.fit);
		},
		update(kind) {
			const q = (n) => root.querySelector(`[data-n="${n}"]`);
			const strip = q("strip");
			const wasHidden = strip?.hidden;
			this.strip(strip);
			// 执行条出现 / 消失会改变路由图可用的高度
			if (strip && wasHidden !== strip.hidden) this.fit?.();
			if (kind === "job-output") return;
			// 按次数看时，计时刷新不改变流向，跳过；按耗时看时每秒更新带子宽度
			if (kind !== "tick" || sankey.metric === "time") sankey.render();
			this.routeSummary();
			if (kind !== "tick" && kind !== "live") this.activity();
		},
		/** 派工活动：和路由图同一个时间范围；按成员着色的堆叠柱 */
		activity() {
			const box = root.querySelector('[data-n="act"]');
			if (!box) return;
			const mode = sankey.range === "hour" ? "hour" : sankey.range === "day" ? "day" : "week";
			const rows = dispatchRows();
			const chart = activityChart(rows, mode);
			box.innerHTML = chart.html;
			const span = { hour: "最近 1 小时 · 每 5 分钟", day: "最近 24 小时 · 每小时", week: "最近 14 天 · 每天" }[mode];
			root.querySelector('[data-n="actSum"]').innerHTML = `<span><b>${chart.total}</b> 次派工</span><span>${span}</span>`;
			const from = Date.now() - ({ hour: 3_600_000, day: 86_400_000, week: 14 * 86_400_000 }[mode]);
			const used = KINDS.filter((k) => rows.some((d) => d.agent === k && (d.at ?? 0) >= from));
			root.querySelector('[data-n="actLegend"]').innerHTML = used.map((k) => `<span><i style="background:${agentColor(k)}"></i>${esc(AGENT_LABEL[k] ?? k)}</span>`).join("");
		},
		/** 正在执行的派工：成员、任务、计时、最近一行输出；点开看详情 */
		strip(box) {
			if (!box) return;
			const sync = store.live.tools
				.filter((t) => t.status !== "done" && isDispatch(t.name))
				.map((t) => ({ key: t.callId, agent: kindOf(t.name), task: callInfo(t.callId)?.task ?? "", since: slotStart.get(t.callId), last: String(t.output ?? "").trim().split("\n").at(-1) ?? "", tag: "" }));
			const jobs = runningJobs().map((j) => ({ key: j.callId, agent: j.agent, task: j.task, since: j.startedAt, last: (j.output ?? []).at(-1) ?? "", tag: j.id }));
			const rows = [...sync, ...jobs];
			box.hidden = !rows.length;
			if (!rows.length) return;
			box.innerHTML = `<span class="strip-head"><span class="pulse-dot"></span>正在执行 ${rows.length}</span>${rows
				.map(
					(r) => `<button type="button" class="strip-item" data-call="${esc(r.key)}" style="--c:${agentColor(r.agent)}">
						<b>${esc(AGENT_LABEL[r.agent] ?? r.agent)}${r.tag ? ` · ${esc(r.tag)}` : ""}</b>
						<span class="strip-task">${esc(short(r.task, 40))}</span>
						<span class="strip-last">${esc(short(r.last, 50))}</span>
						<time>${r.since ? duration(Date.now() - r.since) : ""}</time>
					</button>`,
				)
				.join("")}`;
			if (!box.dataset.bound) {
				box.dataset.bound = "1";
				box.addEventListener("click", (e) => {
					const b = e.target instanceof Element ? e.target.closest("[data-call]") : null;
					if (b) openDispatch(b.dataset.call);
				});
			}
		},
		routeSummary() {
			const box = root.querySelector('[data-n="routeSum"]');
			if (!box) return;
			const s = sankey.summary();
			const t = totals();
			const budget = store.state?.budget;
			box.innerHTML = s?.total
				? `<span><b>${s.total}</b> 次派工</span>${s.rate !== null ? `<span><b>${s.rate}%</b> 成功</span>` : ""}${s.running ? `<span class="live"><b>${s.running}</b> 执行中</span>` : ""}<span><b>${money(t.cost)}</b> 花费</span>${budget?.perRunUsd != null && budget.runKey ? `<span>本轮 ${money(budget.spent)} / ${money(budget.perRunUsd)}</span>` : ""}`
				: `<span>${RANGES[sankey.range].label === "全部" ? "还没有派工" : `最近 ${RANGES[sankey.range].label} 没有派工`}</span>`;
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
// 项目：共同目标 + 分工表 + 角色
// =====================================================================
const COLUMNS = [
	{ s: "todo", label: "待办" },
	{ s: "doing", label: "进行中" },
	{ s: "review", label: "待验收" },
	{ s: "blocked", label: "受阻" },
	{ s: "done", label: "完成" },
];

function shortPath(p) {
	const parts = String(p ?? "").split(/[\\/]/).filter(Boolean);
	return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0] ?? "";
}

function taskCard(t, all, readinessMap, dispatch, openMore = false) {
	const deps = t.deps.map((d) => all.find((x) => x.id === d)).filter(Boolean);
	const waiting = deps.filter((dependency) => dependency.status !== "done");
	const readiness = readinessMap?.get(t.id);
	const waitReasons = t.status === "todo" && readiness && !readiness.ready ? readiness.reasons : [];
	const recoverable = ["todo", "blocked"].includes(t.status) && t.lastAttempt;
	const chips = [];

	if (waiting.length) chips.push(`<span class="tc-chip warn">⏳ 等 ${waiting.map((d) => esc(d.id)).join("、")}</span>`);
	else if (waitReasons.length) chips.push(`<span class="tc-chip warn" title="${esc(waitReasons.join("；"))}">⏳ 等待前置</span>`);
	else if (t.status === "todo") chips.push(`<span class="tc-chip ready">${t.automation ? "⚡ 就绪 · 自动" : "● 就绪"}</span>`);

	if (t.scope && (t.scope.allow?.length || t.scope.forbid?.length)) {
		const tip = `${t.scope.allow?.length ? `允许: ${t.scope.allow.join(", ")}` : "允许: 不限"}${t.scope.forbid?.length ? `\n禁止: ${t.scope.forbid.join(", ")}` : ""}`;
		chips.push(`<span class="tc-chip mono" title="${esc(tip)}">🔒 ${esc(t.scope.allow?.[0] ?? t.scope.forbid?.[0])}</span>`);
	}
	if (t.verification) {
		const vTip = t.verification.checks.map((c) => `${c.name}：${c.passed ? "通过" : "失败"}${c.evidence ? ` · ${c.evidence}` : ""}`).join("\n");
		chips.push(`<span class="tc-chip ${t.verification.passed ? "ok" : "err"}" title="${esc(vTip)}">${t.verification.passed ? "✓ 机检通过" : "✗ 机检未通过"}</span>`);
	}
	const latestCheck = t.checksByMember?.at(-1);
	if (t.review) {
		const v = t.review.verdict;
		const cls = v === "accepted" ? "ok" : ["rework", "blocked", "rejected"].includes(v) ? "err" : "warn";
		const label = v === "accepted" ? (t.reviewer?.blind ? "✓ 盲审通过" : "✓ 复核通过") : `${t.reviewer?.blind ? "🕶 盲审" : "🔎 复核"} · ${esc(v)}`;
		chips.push(`<span class="tc-chip ${cls}" title="${esc(t.review.evidence ?? "")}">${label}</span>`);
	} else if (t.reviewer) {
		const st = latestCheck?.status ?? "待交付";
		const cls = st === "accepted" ? "ok" : ["rework", "blocked", "failed"].includes(st) ? "err" : "";
		const prefix = t.reviewer.blind ? "🕶 盲审" : "🔎 复核";
		const who = AGENT_LABEL[t.reviewer.member] ?? t.reviewer.member;
		chips.push(`<span class="tc-chip ${cls}" title="${esc(latestCheck?.evidence ?? "")}">${prefix} · ${esc(who)}${latestCheck ? ` (${esc(st)})` : ""}</span>`);
	}
	if (t.automation && t.status !== "done") {
		chips.push(`<span class="tc-chip">⚡ 自动 · 返工≤${esc(String(t.automation.maxReworks))}</span>`);
	}
	if (t.recoveries?.length) {
		const lastRec = t.recoveries.at(-1);
		chips.push(`<span class="tc-chip" title="${esc(`${lastRec.action} → ${lastRec.member} · ${lastRec.status}`)}">↻ 已交接${t.recoveries.length > 1 ? ` ×${t.recoveries.length}` : ""}</span>`);
	}
	if (t.integrationId) {
		chips.push(`<span class="tc-chip">⇄ 集成 ${changeLink(t.integrationId)}</span>`);
	}

	const detailLines = [];
	if (t.review?.evidence) detailLines.push(`<p><strong>复核意见</strong><span>${esc(t.review.evidence)}</span></p>`);
	else if (latestCheck?.evidence) detailLines.push(`<p><strong>独立复核</strong><span>${esc(latestCheck.evidence)}</span></p>`);
	if (t.verification?.checks?.length) {
		detailLines.push(`<p><strong>机器检查</strong><span>${t.verification.checks.map((c) => `${c.passed ? "✓" : "✗"} ${esc(c.name)}`).join(" · ")}</span></p>`);
	}
	if (t.recoveries?.length) {
		const rec = t.recoveries.at(-1);
		detailLines.push(`<p><strong>交接记录</strong><span class="mono">${esc(rec.action)} → ${esc(rec.member)} (${esc(rec.status)})</span></p>`);
	}
	if (t.latestResult) detailLines.push(`<p><strong>关联派工</strong><span class="mono">${esc(t.latestResult)}</span></p>`);
	if (t.notes?.length) {
		const cleanNote = t.notes.at(-1).replace(/^\S+ \S+ /, "");
		if (cleanNote && cleanNote !== t.review?.evidence) detailLines.push(`<p><strong>备注</strong><span>${esc(cleanNote)}</span></p>`);
	}

	const hasFoot = deps.length || t.changes.length || dispatch?.key;
	return `<article class="task-card" data-task-id="${esc(t.id)}" data-s="${t.status}">
		<header class="tc-head">
			<div class="tc-head-l"><span class="tc-id mono">${esc(t.id)}</span>${t.role ? `<span class="role-chip">${esc(t.role)}</span>` : ""}</div>
			${t.owner ? `<div class="tc-owner">${agentTag(t.owner)}</div>` : ""}
		</header>
		<h3 class="tc-title" title="${esc(t.title)}">${esc(t.title)}</h3>
		${t.acceptance ? `<div class="tc-accept" title="${esc(t.acceptance)}"><p><span>验收</span>${esc(t.acceptance)}</p></div>` : ""}
		${chips.length ? `<div class="tc-badges">${chips.join("")}</div>` : ""}
		${detailLines.length ? `<details class="tc-more" data-task-id="${esc(t.id)}"${openMore ? " open" : ""}><summary>回执与记录</summary><div class="tc-more-body">${detailLines.join("")}</div></details>` : ""}
		${recoverable ? `<div class="task-actions"><button type="button" class="ghost-btn tiny" data-recover-task="${esc(t.id)}">恢复 / 交接</button><button type="button" class="copy-cmd mono" data-copy="/task inspect ${esc(t.id)}" title="复制终端诊断命令">/task inspect ${esc(t.id)}</button></div>` : ""}
		${
			hasFoot
				? `<footer class="tc-foot">
					<div class="tc-foot-l">${deps.map((d) => `<span class="dep" data-s="${d.status}" title="${esc(d.title)}">← ${esc(d.id)}</span>`).join("")}${t.changes.map((c) => changeLink(c)).join("")}</div>
					${dispatch?.key ? `<button type="button" class="tc-open-btn" data-open-task-dispatch="${esc(dispatch.key)}">派工详情 →</button>` : ""}
				</footer>`
				: ""
		}
	</article>`;
}

function project() {
	let root;
	let statusFilter = "all";
	return {
		title: "项目",
		sub: "",
		mount(r) {
			root = r;
			statusFilter = "all";
			root.addEventListener("click", async (e) => {
				const target = e.target instanceof Element ? e.target : null;
				if (!target) return;
				const filterBtn = target.closest("[data-task-filter]");
				if (filterBtn && !filterBtn.disabled) {
					statusFilter = filterBtn.dataset.taskFilter;
					this.update("filter");
					return;
				}
				const dispBtn = target.closest("[data-open-task-dispatch]");
				if (dispBtn) {
					openDispatch(dispBtn.dataset.openTaskDispatch);
					return;
				}
				const wfBtn = target.closest("[data-wf-action]");
				if (wfBtn) {
					wfBtn.disabled = true;
					try {
						const act = wfBtn.dataset.wfAction;
						await runControlAction("/api/workflow", { action: act }, act === "pause" ? "自动协作已暂停" : "自动协作已恢复");
					} catch (err) { toast(err.message); wfBtn.disabled = false; }
					return;
				}
				const recBtn = target.closest("[data-recover-task]");
				if (recBtn) {
					const task = (store.state?.project?.tasks ?? []).find((x) => x.id === recBtn.dataset.recoverTask);
					if (task) openRecoverDialog(task, store.state?.agents ?? []);
					return;
				}
				if (target.closest("[data-create-int]")) {
					openCreateIntegrationDialog(store.changes);
					return;
				}
				const rerunBtn = target.closest("[data-int-rerun]");
				if (rerunBtn) {
					rerunBtn.disabled = true;
					try { await runControlAction(`/api/integrations/${encodeURIComponent(rerunBtn.dataset.intRerun)}/rerun`, {}, "已重跑联合集成检查"); }
					catch (err) { toast(err.message); rerunBtn.disabled = false; }
					return;
				}
				const repairBtn = target.closest("[data-int-repair]");
				if (repairBtn) {
					const it = (store.state?.integrations ?? []).find((x) => x.id === repairBtn.dataset.intRepair);
					if (it) openRepairIntegrationDialog(it, store.state?.agents ?? []);
					return;
				}
				const applyIntBtn = target.closest("[data-int-apply]");
				if (applyIntBtn) {
					const id = applyIntBtn.dataset.intApply;
					if (!confirm(`确认将联合集成 #${id} 合并到主目录？操作只写工作区文件，不自动 commit。`)) return;
					applyIntBtn.disabled = true;
					try { await runControlAction(`/api/changes/${encodeURIComponent(id)}/apply`, {}, `联合集成 #${id} 已应用到主目录`); }
					catch (err) { toast(err.message); applyIntBtn.disabled = false; }
					return;
				}
				const cancelIntBtn = target.closest("[data-int-cancel]");
				if (cancelIntBtn) {
					const id = cancelIntBtn.dataset.intCancel;
					if (!confirm(`确认取消联合集成 #${id}？来源分支改动会保留。`)) return;
					cancelIntBtn.disabled = true;
					try { await runControlAction(`/api/integrations/${encodeURIComponent(id)}/cancel`, {}, `已取消联合集成 #${id}`); }
					catch (err) { toast(err.message); cancelIntBtn.disabled = false; }
					return;
				}
				const opBtn = target.closest("[data-resolve-op]");
				if (opBtn) {
					const op = (store.state?.operations ?? []).find((x) => x.id === opBtn.dataset.resolveOp);
					if (op) openResolveOperationDialog(op);
				}
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "tick" || kind === "live" || kind === "items" || kind === "job-output" || kind === "usage") return;
			const p = store.state?.project;
			if (!p) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const openMoreIds = new Set([...root.querySelectorAll(".tc-more[open]")].map((el) => el.dataset.taskId));
			const tasks = p.tasks.filter((t) => t.status !== "dropped");
			const count = (s) => tasks.filter((t) => t.status === s).length;
			const done = count("done");
			const doing = count("doing");
			const review = count("review");
			const blocked = count("blocked");
			const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
			const segW = (n) => (tasks.length ? ((n / tasks.length) * 100).toFixed(2) : 0);
			const available = new Set((store.state.agents ?? []).filter((a) => a.available).map((a) => a.kind));
			const uncertain = (store.state.operations ?? []).filter((operation) => operation.method === "POST" && ["pending", "unknown"].includes(operation.status));
			const resources = store.state.resources ?? { running: [], queued: [], reservedUsd: 0 };
			const wfPaused = !!store.state.workflow?.paused;
			const readinessList = store.state.readyTasks ?? [];
			const readinessMap = new Map(readinessList.map((r) => [r.id, r]));
			const readyList = readinessList.filter((r) => r.ready);
			const activeIntegrations = (store.state.integrations ?? []).filter((it) => !it.supersededBy && it.changeStatus !== "dropped");
			const pendingBranchCount = store.changes.filter((c) => !c.integration && ["pending", "conflict"].includes(c.status)).length;
			const canCreateInt = pendingBranchCount >= 2;
			const dispatchByTask = new Map();
			for (const d of store.dispatches ?? []) {
				if (d.taskId && !dispatchByTask.has(d.taskId)) dispatchByTask.set(d.taskId, d);
			}
			const cardHtml = (t) => taskCard(t, p.tasks, readinessMap, dispatchByTask.get(t.id), openMoreIds.has(t.id));

			if (statusFilter !== "all" && !count(statusFilter)) statusFilter = "all";

			const activeCols = COLUMNS.filter((c) => c.s !== "done")
				.map((c) => ({ ...c, list: tasks.filter((t) => t.status === c.s) }))
				.filter((c) => c.list.length > 0);
			const doneList = tasks.filter((t) => t.status === "done");

			let boardBody = "";
			if (!tasks.length) {
				boardBody = `<div class="empty-inline"><span class="dot"></span>项目级、多步骤的任务，总调度会先拆成任务写进分工表（每项有角色、负责人、依赖和验收标准），再按依赖顺序派工。</div>`;
			} else if (statusFilter !== "all") {
				const col = COLUMNS.find((c) => c.s === statusFilter);
				const list = tasks.filter((t) => t.status === statusFilter);
				boardBody = `<div class="board-band-head" data-s="${col.s}"><span class="band-title"><i></i>${col.label}</span><em>${list.length} 项</em></div>
					<div class="task-grid">${list.map(cardHtml).join("")}</div>`;
			} else {
				const parts = [];
				if (activeCols.length === 1) {
					const only = activeCols[0];
					parts.push(`<div class="board-band-head" data-s="${only.s}"><span class="band-title"><i></i>${only.label}</span><em>${only.list.length} 项</em></div>
						<div class="task-grid">${only.list.map(cardHtml).join("")}</div>`);
				} else if (activeCols.length > 1) {
					parts.push(`<div class="kanban" style="--cols:${activeCols.length}">${activeCols
						.map((col) => `<div class="kanban-col" data-s="${col.s}"><div class="kanban-head"><span>${col.label}</span><em>${col.list.length}</em></div><div class="kanban-list">${col.list.map(cardHtml).join("")}</div></div>`)
						.join("")}</div>`);
				}
				if (doneList.length) {
					parts.push(`<div class="${activeCols.length ? "board-done-band" : ""}">
						<div class="board-band-head" data-s="done"><span class="band-title"><i></i>已完成</span><em>${doneList.length} 项</em></div>
						<div class="task-grid">${doneList.map(cardHtml).join("")}</div>
					</div>`);
				}
				boardBody = parts.join("");
			}

			const scopeHtml = renderScopeMatrix(p.tasks);
			const reviewLoopHtml = renderReviewLoopPanel(p.tasks, store.dispatches);
			const rolesHtml = `
				<section class="card">
					<header class="card-head"><div class="card-heading"><h2 class="card-title">角色分工</h2><div class="card-sub">按角色选成员与回退顺序（配置于 pi-agent.config.json）</div></div></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>角色</th><th>成员（首选 → 备选）</th><th class="hide-sm">模型</th><th>负责</th><th class="num">任务</th></tr></thead>
					<tbody>${(p.roles ?? [])
						.map((r) => {
							const chain = [r.agent, ...(r.fallback ?? [])];
							const pick = chain.find((k) => available.has(k));
							return `<tr><td><span class="role-chip">${esc(r.name)}</span></td>
								<td>${chain.map((k) => `<span class="${k === pick ? "" : "dim-agent"}">${agentTag(k)}</span>`).join('<span class="muted"> → </span>')}</td>
								<td class="hide-sm">${r.model ? `<span class="model-chip">${esc(r.model)}</span>` : `<span class="muted">成员默认</span>`}</td>
								<td class="muted">${esc(r.note ?? "")}</td>
								<td class="num mono">${tasks.filter((t) => t.role === r.name).length}</td></tr>`;
						})
						.join("")}</tbody></table></div>
				</section>`;

			root.innerHTML = `
				<section class="proj-stats">
					<div class="proj-stat">
						<div class="proj-stat-top"><span>任务进度</span><em class="proj-pct ${pct === 100 && tasks.length ? "done" : ""}">${tasks.length ? `${pct}%` : "0%"}</em></div>
						<strong><b>${done}</b> / ${tasks.length} ${tasks.length ? (doing ? `· ${doing} 进行中` : review ? `· ${review} 待验收` : blocked ? `· ${blocked} 受阻` : "全部完成") : "等待拆解"}</strong>
						<div class="proj-bar" title="完成 ${done} · 待验收 ${review} · 进行中 ${doing} · 受阻 ${blocked}">
							<i class="s-done" style="width:${segW(done)}%"></i><i class="s-review" style="width:${segW(review)}%"></i><i class="s-doing" style="width:${segW(doing)}%"></i><i class="s-blocked" style="width:${segW(blocked)}%"></i>
						</div>
					</div>
					<div class="proj-stat">
						<div class="proj-stat-top"><span>自动推进</span><button type="button" class="${wfPaused ? "primary-btn" : "ghost-btn"} tiny" data-wf-action="${wfPaused ? "resume" : "pause"}">${wfPaused ? "恢复推进" : "暂停"}</button></div>
						<strong><b class="${wfPaused ? "" : "live"}">${wfPaused ? "已暂停" : "运行中"}</b> · 就绪 ${readyList.length}</strong>
						<p class="proj-stat-sub">运行 ${resources.running.length} · 排队 ${resources.queued.length} · 预留 $${Number(resources.reservedUsd).toFixed(4)}</p>
					</div>
					<div class="proj-stat">
						<div class="proj-stat-top"><span>多分支集成</span>${canCreateInt ? `<button type="button" class="ghost-btn tiny" data-create-int="1">+ 发起联合集成</button>` : `<span class="proj-chip">${pendingBranchCount} 待合分支</span>`}</div>
						<strong>${activeIntegrations.length ? `<b>${activeIntegrations.length}</b> 项集成任务` : `<b>${pendingBranchCount}</b> 个待处理分支`}</strong>
						<p class="proj-stat-sub">${activeIntegrations.length ? "可在下方查看集成检查状态与修复冲突" : canCreateInt ? "支持合流多个隔离分支并运行全套验收" : "存在 2 个及以上未合并分支后可发起"}</p>
					</div>
					<div class="proj-stat">
						<div class="proj-stat-top"><span>最终目标</span><code class="path-pill" title="${esc(p.goalPath)}">${esc(shortPath(p.goalPath))}</code></div>
						<strong>${p.goal ? (/待你确认/.test(p.goal) ? `<span class="pill" data-s="pending">总调度起草 · 待确认</span>` : `<b>已设定</b> 目标文档`) : `<span class="muted">尚未设定</span>`}</strong>
						<p class="proj-stat-sub">${p.goal ? "成员每次派工都会自动携带 GOAL.md" : "告知总调度项目目标即可起草并同步成员"}</p>
					</div>
				</section>
				${uncertain.length ? `<section class="card"><header class="card-head"><h2 class="card-title err-t">外部操作待核对</h2></header><div class="card-body">${uncertain.map((operation) => `<div class="job-row"><span class="mono">${esc(operation.id)}</span><span>${esc(operation.member)}/${esc(operation.tool)}</span><span class="job-task">${esc(operation.failure?.message ?? "请求已发出但尚无确定回执")}</span><button type="button" class="ghost-btn tiny" data-resolve-op="${esc(operation.id)}">人工核对</button></div>`).join("")}<p class="muted">核对远端状态前禁止重复提交同一接口。</p></div></section>` : ""}
				${resources.queued.length ? `<section class="card"><header class="card-head"><div class="card-heading"><h2 class="card-title">资源排队与就绪队列</h2></div></header><div class="card-body">${resources.queued.map((claim) => `<div class="job-row"><span class="pill" data-s="running">排队中</span><span>${esc(claim.member)}</span><span class="job-task">${esc(claim.reason ?? "等待可用名额")}</span></div>`).join("")}</div></section>` : ""}
				${activeIntegrations.length ? `<section class="card"><header class="card-head"><div class="card-heading"><h2 class="card-title">多分支联合集成与联调</h2><div class="card-sub">合并多个隔离分支并运行全套检查 · 冲突时可直接派成员修现场</div></div>${canCreateInt ? `<button type="button" class="ghost-btn tiny" data-create-int="1">+ 发起联合集成</button>` : ""}</header><div class="card-body">${activeIntegrations.slice(0, 6).map((it) => {
					const st = it.status ?? it.changeStatus;
					const pillState = st === "passed" || it.changeStatus === "applied" ? "done" : ["preparing", "merging", "repairing", "testing"].includes(st) ? "running" : st === "cancelled" ? "aborted" : "error";
					const srcs = (it.sources ?? []).map((s) => `<a href="#/changes/${esc(s.id)}">#${esc(s.id)}</a>`).join(" + ");
					const runningInt = ["preparing", "merging", "repairing", "testing"].includes(st);
					const canApply = st === "passed" && it.changeStatus !== "applied";
					const canRepair = ["conflict", "failed"].includes(st);
					return `<div class="job-row int-row"><a class="mono" href="#/changes/${esc(it.id)}">#${esc(it.id)}</a><span class="pill" data-s="${pillState}">${esc(it.changeStatus === "applied" ? "已合并" : st)}</span><span class="job-task">来源 ${srcs}${it.repair ? ` · 修复自 #${esc(it.repair.fromId)}（${esc(it.repair.member)}）` : ""}${it.conflicts?.length ? ` · 冲突：${esc(it.conflicts.join("、"))}` : ""}${it.message ? ` · <span class="muted">${esc(short(it.message, 80))}</span>` : ""}</span><div class="row-actions">${canApply ? `<button type="button" class="primary-btn tiny" data-int-apply="${esc(it.id)}">应用到主目录</button>` : ""}${canRepair ? `<button type="button" class="ghost-btn tiny" data-int-repair="${esc(it.id)}">派人修复</button>` : ""}${!runningInt && it.changeStatus !== "applied" ? `<button type="button" class="ghost-btn tiny" data-int-rerun="${esc(it.id)}">重跑检查</button>` : ""}${runningInt ? `<button type="button" class="ghost-btn tiny" data-int-cancel="${esc(it.id)}">取消</button>` : ""}</div></div>`;
				}).join("")}</div></section>` : ""}
				${p.goal ? `<section class="card goal-card"><header class="card-head"><div class="card-heading"><h2 class="card-title">最终目标（GOAL.md）</h2><div class="card-sub"><span class="mono" title="${esc(p.goalPath)}">${esc(shortPath(p.goalPath))}</span></div></div>${/待你确认/.test(p.goal) ? `<span class="pill" data-s="pending">总调度起草 · 待你确认</span>` : ""}</header><div class="card-body"><div class="md goal-md">${markdown(p.goal.replace(/^<!--[\s\S]*?-->\s*/, ""))}</div></div></section>` : ""}
				<section class="card board-card">
					<header class="card-head">
						<div class="card-heading">
							<h2 class="card-title">分工表</h2>
							<div class="board-filters">${[
								{ k: "all", label: "全部", n: tasks.length },
								...COLUMNS.map((c) => ({ k: c.s, label: c.label, n: count(c.s) })),
							]
								.map((f) => `<button type="button" class="board-filter${statusFilter === f.k ? " on" : ""}" data-task-filter="${f.k}" data-s="${f.k}" ${f.k !== "all" && !f.n ? "disabled" : ""}><span>${f.label}</span><em>${f.n}</em></button>`)
								.join("")}</div>
						</div>
						<div class="row-actions">
							<code class="path-pill" title="${esc(p.assignPath)}">${esc(shortPath(p.assignPath))}</code>
							${tasks.length ? `<a class="ghost-btn tiny" href="#/dag">查看任务图谱 (DAG) →</a>` : ""}
						</div>
					</header>
					<div class="card-body">${boardBody}</div>
				</section>
				${reviewLoopHtml ? `<div data-n="reviewLoopWrap">${reviewLoopHtml}</div>` : ""}
				<div class="proj-bottom-grid">${scopeHtml}${rolesHtml}</div>`;
			const loopWrap = root.querySelector('[data-n="reviewLoopWrap"]');
			if (loopWrap) bindDagPanelEvents(loopWrap);
		},
	};
}

// =====================================================================
// 任务图谱（DAG）
// =====================================================================
function dag() {
	let root;
	let topoData = null;
	let loadedOnce = false;
	let loading = false;
	let timer = null;
	let lastSig = "";

	async function load() {
		if (!root || loading) return;
		loading = true;
		try {
			topoData = await getJson("/api/topology?limit=200");
		} catch {
			/* 断线或未就绪时回退 store.state 渲染 */
		} finally {
			loadedOnce = true;
			loading = false;
			render();
		}
	}
	const reload = (delay = 180) => {
		clearTimeout(timer);
		timer = setTimeout(load, delay);
	};

	function render() {
		if (!root) return;
		if (!topoData && !store.state && !loadedOnce) return;
		const tasks = topoData?.tasks ?? store.state?.project?.tasks ?? [];
		const integrations = (topoData?.integrations ?? store.state?.integrations ?? []).filter((it) => !it.supersededBy && it.changeStatus !== "dropped");
		const readinessList = topoData?.readyTasks ?? store.state?.readyTasks ?? [];
		const sig = JSON.stringify([tasks, integrations, readinessList]);
		if (sig === lastSig) return;
		lastSig = sig;

		const readinessMap = new Map(readinessList.map((r) => [r.id, r]));
		const active = tasks.filter((t) => t.status !== "dropped");
		const done = active.filter((t) => t.status === "done").length;
		const doing = active.filter((t) => t.status === "doing" || t.status === "review").length;
		const reviewCount = active.filter((t) => !!t.reviewer).length;
		const blindCount = active.filter((t) => t.reviewer?.blind).length;
		const scopedCount = active.filter((t) => t.scope && (t.scope.allow?.length || t.scope.forbid?.length)).length;
		const topoInfo = classifyTopology(tasks, integrations);

		const statsEl = root.querySelector('[data-n="stats"]');
		if (statsEl) {
			statsEl.innerHTML = [
				["协作模式", `<b>${esc(topoInfo.title)}</b>`],
				["任务进度", active.length ? `<b>${done}</b> / ${active.length}${doing ? `（<b>${doing}</b> 活跃）` : ""}` : "等待拆解"],
				["独立复核 / 盲审", blindCount ? `<b>${reviewCount}</b> 项（含 <b>${blindCount}</b> 盲审）` : `<b>${reviewCount}</b> 项`],
				["路径隔离 / 集成", `<b>${scopedCount}</b> 锁域 · <b>${integrations.length}</b> 集成`],
			]
				.map(([k, v]) => `<div class="topo-stat"><span>${k}</span><strong>${v}</strong></div>`)
				.join("");
		}
		const subEl = root.querySelector('[data-n="sub"]');
		if (subEl) subEl.textContent = topoInfo.detail;

		const stageEl = root.querySelector('[data-n="stage"]');
		if (!stageEl) return;
		renderTaskDag(stageEl, {
			tasks,
			integrations,
			readinessMap,
			onSelectTask: (t) => {
				const bar = (topoData?.bars ?? []).filter((b) => b.taskId === t.id).at(-1);
				const dispatch = bar ?? store.dispatches.find((d) => d.taskId === t.id);
				if (dispatch?.key) openDispatch(dispatch.key);
				else location.hash = "#/project";
			},
		});
	}

	return {
		title: "任务图谱 (DAG)",
		sub: "多 Agent 依赖拓扑、盲审关系与集成汇流一览",
		mount(r) {
			root = r;
			lastSig = "";
			loadedOnce = false;
			root.innerHTML = `<div class="topo-stats cols-4" data-n="stats"></div>
				<section class="card dag-card">
					<header class="card-head">
						<div class="card-heading">
							<h2 class="card-title">多 Agent 任务依赖与协作图谱（DAG）</h2>
							<div class="card-sub" data-n="sub">悬停高亮上下游，点节点查看派工详情</div>
						</div>
						<div class="row-actions">
							<a class="ghost-btn tiny" href="#/project">分工表 →</a>
							<a class="ghost-btn tiny" href="#/topology">查看协作时间线 →</a>
						</div>
					</header>
					<div class="card-body dag-stage" data-n="stage"><div class="empty-inline"><span class="dot"></span>加载中…</div></div>
				</section>`;
			render();
			load();
		},
		unmount() {
			clearTimeout(timer);
			root = null;
		},
		update(kind) {
			if (!root) return;
			if (kind === "tick" || kind === "live" || kind === "items" || kind === "job-output" || kind === "usage") return;
			render();
			if (kind === "all" || kind === "state" || kind === "dispatches" || kind === "changes" || kind === "jobs") reload(180);
		},
	};
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
		sub: "",
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
			if (kind === "tick" || kind === "state" || kind === "dispatches" || kind === "job-output") {
				if (timeline && (kind === "tick" || kind === "job-output")) timeline.live(store.live, shownId === this.latestId);
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
		sub: "",
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
			seg.innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${esc(k)}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : esc(AGENT_LABEL[k] ?? k)}</button>`).join("");
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
			if (kind === "state") root.querySelector('[data-n="agents"]').innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${esc(k)}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : esc(AGENT_LABEL[k] ?? k)}</button>`).join("");
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
						<td class="w-task"><span class="cell-task">${d.callId?.startsWith("checker:") ? `<span class="resume-tag">独立复核</span>` : d.callId?.startsWith("integration-repair:") ? `<span class="resume-tag">集成修复</span>` : d.callId?.startsWith("workflow:") ? `<span class="resume-tag">自动推进</span>` : ""}${d.resume ? `<span class="resume-tag">续接</span>` : ""}${d.basedOn ? `<span class="resume-tag">基于 #${esc(d.basedOn)}</span>` : ""}${esc(short(d.task, 140) || "—")}</span></td>
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
// 改动（GitLens 提交图谱与推送工作台）
// =====================================================================
const changes = createChangesView;

// =====================================================================
// Agent 规范：各家 CLI 的规范 / 配置文件
// =====================================================================
const OWNER_LABEL = { claude: "Claude", codex: "Codex", gemini: "Gemini", shared: "通用", "pi-agent": "Lemma" };
const KIND_LABEL = { instructions: "说明", settings: "设置", subagent: "子 agent", command: "命令", skill: "技能", mcp: "MCP", project: "项目" };
const KIND_ORDER = ["project", "instructions", "settings", "mcp", "subagent", "command", "skill"];

function conventions() {
	let root;
	let data = null;
	let selected = null;
	let query = "";
	const cache = new Map();
	return {
		title: "Agent 规范",
		sub: "",
		async mount(r, params) {
			root = r;
			selected = params.length ? decodeURIComponent(params.join("/")) : null;
			root.innerHTML = empty("扫描中…");
			await this.load();
		},
		async load() {
			try {
				data = await getJson("/api/conventions");
			} catch (err) {
				root.innerHTML = empty(`扫描失败：${err.message}`);
				return;
			}
			this.render();
		},
		update() {},
		render() {
			const d = data;
			const label = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
			const fileChip = (f) =>
				`<a class="conv-chip" href="#/conventions/${encodeURIComponent(f.id)}" title="${esc(f.id)}"><span class="scope-tag">${f.scope === "user" ? "用户" : "项目"}</span>${esc(f.rel)}${f.size === 0 ? `<em class="muted">空</em>` : ""}${f.rules === "synced" ? `<em class="ok-t">规则 ✓</em>` : f.rules ? `<em class="err-t">规则${f.rules === "stale" ? "过期" : "缺失"}</em>` : ""}</a>`;
			const members = ["claude", "codex", "gemini"]
				.map((k) => {
					const m = d.members[k];
					const hasProject = m.instructions.some((f) => f.scope === "project" && f.size > 0);
					return `<section class="card conv-member" style="--c:${agentColor(k)}">
						<header class="agent-head"><span class="lamp"></span><h2>${label[k]}</h2><span class="pill" data-s="${hasProject ? "done" : "error"}">${hasProject ? "有项目说明" : "缺项目说明"}</span></header>
						<div class="conv-label">会读到的说明</div>
						<div class="conv-chips">${m.instructions.map(fileChip).join("") || `<span class="muted">没有</span>`}</div>
						<div class="figures conv-figs">
							<div><span>设置</span><strong>${m.settings.length}</strong></div>
							<div><span>技能</span><strong>${m.skills}</strong></div>
							<div><span>命令</span><strong>${m.commands}</strong></div>
							<div><span>子 agent</span><strong>${m.subagents}</strong></div>
						</div>
					</section>`;
				})
				.join("");
			const checks = d.checks
				.map(
					(c) => `<div class="conv-check" data-level="${c.level}"><span class="conv-icon">${c.level === "warn" ? "!" : c.level === "ok" ? "✓" : "i"}</span>
					<div><strong>${esc(c.title)}</strong>${c.detail ? `<p>${esc(c.detail)}</p>` : ""}${c.files?.length ? `<p class="conv-files">${c.files.map((id) => `<a href="#/conventions/${encodeURIComponent(id)}">${esc(id.replace(/^user:/, "~/").replace(/^project:/, ""))}</a>`).join("")}</p>` : ""}</div></div>`,
				)
				.join("");
			root.innerHTML = `
				<div class="conv-members">${members}</div>
				<section class="card">
					<header class="card-head"><div class="card-heading"><h2 class="card-title">检查</h2><div class="card-sub">共同规则：${d.rules.exists ? `<span class="mono">.pi-agent/RULES.md</span>（${esc(d.rules.hash ?? "")}）` : "还没有，终端 /rules init 生成模板"}</div></div>
						<button type="button" class="ghost-btn" data-n="rescan">重新扫描</button></header>
					<div class="card-body conv-checks">${checks}</div>
				</section>
				<section class="card">
					<header class="card-head"><div class="card-heading"><h2 class="card-title">文件</h2><div class="card-sub">项目：<span class="mono">${esc(d.project)}</span>　用户：<span class="mono">${esc(d.home)}</span></div></div>
						<input class="search" data-n="q" type="search" placeholder="搜索文件、技能…" value="${esc(query)}" /></header>
					<div class="conv-browser">
						<div class="conv-tree" data-n="tree"></div>
						<div class="conv-preview" data-n="preview"></div>
					</div>
				</section>`;
			root.querySelector('[data-n="rescan"]').addEventListener("click", () => {
				cache.clear();
				this.load();
			});
			root.querySelector('[data-n="q"]').addEventListener("input", (e) => {
				query = e.target.value.trim().toLowerCase();
				this.tree();
			});
			this.tree();
			this.preview();
		},
		tree() {
			const box = root.querySelector('[data-n="tree"]');
			const files = data.files.filter((f) => !query || `${f.rel} ${f.name ?? ""} ${f.description ?? ""}`.toLowerCase().includes(query));
			const groups = [];
			for (const scope of ["project", "user"]) {
				for (const owner of ["pi-agent", "claude", "codex", "gemini", "shared"]) {
					const list = files.filter((f) => f.scope === scope && f.owner === owner).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.rel.localeCompare(b.rel));
					if (!list.length) continue;
					groups.push(`<div class="conv-group"><div class="conv-group-head">${scope === "user" ? "用户" : "项目"} · ${OWNER_LABEL[owner]}<em>${list.length}</em></div>${list
						.map(
							(f) => `<a class="conv-item${f.id === selected ? " active" : ""}" href="#/conventions/${encodeURIComponent(f.id)}" title="${esc(f.description ?? f.rel)}">
							<span class="conv-kind" data-kind="${f.kind}">${KIND_LABEL[f.kind]}</span><span class="conv-name">${esc(f.kind === "skill" || f.kind === "subagent" || f.kind === "command" ? (f.name ?? f.rel) : f.rel)}</span>${f.size === 0 ? `<em class="muted">空</em>` : ""}</a>`,
						)
						.join("")}</div>`);
				}
			}
			box.innerHTML = groups.join("") || `<div class="empty-inline"><span class="dot"></span>没有匹配的文件</div>`;
		},
		async preview() {
			const box = root.querySelector('[data-n="preview"]');
			const f = data.files.find((x) => x.id === selected) ?? data.files.find((x) => x.kind === "instructions" && x.size > 0) ?? data.files[0];
			if (!f) {
				box.innerHTML = empty("没有找到任何规范文件");
				return;
			}
			box.innerHTML = `<div class="conv-preview-head"><div><span class="conv-kind" data-kind="${f.kind}">${KIND_LABEL[f.kind]}</span> <strong class="mono">${esc(f.scope === "user" ? `~/${f.rel}` : f.rel)}</strong></div>
				<span class="muted mono">${(f.size / 1024).toFixed(1)} KB · ${ago(f.mtime)}</span></div>
				${f.description ? `<p class="conv-desc">${esc(f.description)}</p>` : ""}
				<div data-n="body"><div class="empty-inline"><span class="dot"></span>读取中…</div></div>`;
			let res = cache.get(f.id);
			if (!res) {
				try {
					res = await getJson(`/api/conventions/file?id=${encodeURIComponent(f.id)}`);
					cache.set(f.id, res);
				} catch (err) {
					res = { text: "", error: err.message };
				}
			}
			const body = box.querySelector('[data-n="body"]');
			if (!body) return;
			if (res.error) body.innerHTML = `<div class="change-msg err">${esc(res.error)}</div>`;
			else if (!res.text.trim()) body.innerHTML = `<div class="empty-inline"><span class="dot"></span>空文件</div>`;
			else if (/\.(md|mdc)$/i.test(f.rel)) body.innerHTML = `<div class="md conv-md">${markdown(res.text.replace(/<!--[\s\S]*?-->/g, ""))}</div>`;
			else body.innerHTML = `<pre class="conv-code"><code>${esc(res.text)}</code></pre>`;
			if (res.truncated) body.insertAdjacentHTML("beforeend", `<p class="footnote">文件太大，只显示了前一部分。</p>`);
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
		sub: "",
		mount(r) {
			root = r;
			root.addEventListener("click", async (e) => {
				const target = e.target instanceof Element ? e.target : null;
				if (!target) return;
				if (target.closest("[data-add-agent]")) {
					openMemberEditor(null);
					return;
				}
				const editBtn = target.closest("[data-edit-agent]");
				if (editBtn) {
					const a = (store.state?.agents ?? []).find((x) => x.kind === editBtn.dataset.editAgent);
					if (a) openMemberEditor(a);
					return;
				}
				const toggleBtn = target.closest("[data-toggle-agent]");
				if (toggleBtn) {
					const kind = toggleBtn.dataset.toggleAgent;
					const a = (store.state?.agents ?? []).find((x) => x.kind === kind);
					if (!a) return;
					toggleBtn.disabled = true;
					try {
						await runControlAction(`/api/agents/${encodeURIComponent(kind)}`, { quick: true, enabled: !a.enabled }, `${a.label} 已${a.enabled ? "停用" : "启用"}`);
					} catch (err) { toast(err.message); toggleBtn.disabled = false; }
					return;
				}
				const modelBtn = target.closest("[data-set-model]");
				if (modelBtn) {
					const kind = modelBtn.dataset.setModel;
					const modelId = modelBtn.dataset.model;
					modelBtn.disabled = true;
					try {
						await runControlAction(`/api/agents/${encodeURIComponent(kind)}`, { quick: true, defaultModel: modelId }, `已切换默认模型为 ${modelId}`);
					} catch (err) { toast(err.message); modelBtn.disabled = false; }
				}
			});
			this.update("all");
		},
		update(kind) {
			if (kind === "tick") return;
			const list = store.state?.agents;
			if (!list) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const canEdit = !!store.state?.canEditSettings;
			const stats = store.state.agentStats ?? {};
			const busy = new Set(store.live.tools.filter((t) => t.status === "running").map((t) => kindOf(t.name)));
			const anyBusy = !!store.live.busy || runningJobs().length > 0;
			root.innerHTML = `
				${canEdit ? `<div class="page-toolbar"><span class="muted">支持在线启停、切换默认模型与新增/修改 API 成员（密钥仅写不回显；有运行中任务时请先完成或中止）。</span><button type="button" class="primary-btn tiny" data-add-agent="1"${anyBusy ? ` disabled title="有任务正在运行，请先等待结束或中止"` : ""}>+ 新增 API 成员</button></div>` : ""}
				<div class="agent-grid">${list
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
						...(a.api
							? [
									["接入方式", `API 成员（Pi 子对话）· <code>${esc(a.api.type)}</code> · ${esc(a.api.host)}`],
									["密钥", esc(a.api.keySource)],
									["工具", esc([...(a.api.tools ?? []), ...(a.api.codeTools ?? [])].join(" / ") || "未授予文件或命令工具")],
									["工作方式", a.workspace === "none" ? "领域协作 · 无 Git 工作区" : "代码工作区"],
								]
							: []),
						[
							a.api ? "启动命令" : "启动命令",
							a.api
								? `<span class="muted">不需要 CLI</span>`
								: a.command?.length
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
							<div class="row-actions">${canEdit ? `<button type="button" class="ghost-btn tiny" data-toggle-agent="${esc(a.kind)}">${a.enabled ? "停用" : "启用"}</button><button type="button" class="ghost-btn tiny" data-edit-agent="${esc(a.kind)}">编辑</button>` : ""}<span class="pill" data-s="${state === "busy" ? "running" : state === "off" ? "error" : "done"}">${state === "busy" ? "执行中" : state === "off" ? "不可用" : "可用"}</span></div></header>
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
		title: "成员会话",
		sub: "",
		mount(r) {
			root = r;
			root.innerHTML = `<section class="card"><div class="toolbar"><div class="seg" data-n="agents"></div><span class="card-note" data-n="count"></span></div>
				<div class="table-wrap"><table class="table"><thead><tr><th>成员</th><th>会话 ID</th><th>目录</th><th>最近使用</th><th class="num hide-sm">派工</th><th>续接命令</th></tr></thead><tbody data-n="rows"></tbody></table></div></section>`;
			const seg = root.querySelector('[data-n="agents"]');
			seg.innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${esc(k)}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : esc(AGENT_LABEL[k] ?? k)}</button>`).join("");
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
			if (kind === "state") root.querySelector('[data-n="agents"]').innerHTML = ["all", ...KINDS].map((k) => `<button type="button" data-k="${esc(k)}" style="--c:${k === "all" ? "var(--ink)" : agentColor(k)}">${k === "all" ? "全部" : esc(AGENT_LABEL[k] ?? k)}</button>`).join("");
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
	const minutes = mode === "hour";
	const n = minutes ? 12 : hours ? 24 : 14;
	const span = minutes ? 300_000 : hours ? 3_600_000 : 86_400_000;
	const now = new Date();
	// 对齐到 5 分钟 / 整点 / 当天零点，最后一根是"当前这一段"
	const end = minutes
		? Math.ceil((now.getTime() + 1) / 300_000) * 300_000
		: hours
			? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1).getTime()
			: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
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
	const hm = (t) => `${String(new Date(t).getHours()).padStart(2, "0")}:${String(new Date(t).getMinutes()).padStart(2, "0")}`;
	const label = (b, i) => {
		const d = new Date(b.start);
		if (minutes) return i % 3 === 0 ? hm(b.start) : "";
		if (hours) return i % 3 === 0 ? `${String(d.getHours()).padStart(2, "0")}:00` : "";
		return i % 2 === 0 || n <= 7 ? `${d.getMonth() + 1}/${d.getDate()}` : "";
	};
	const cols = buckets
		.map((b, i) => {
			const segs = KINDS.filter((k) => b.by[k] > 0)
				.map((k) => `<i style="flex:${b.by[k]};background:${agentColor(k)}"></i>`)
				.join("");
			const tip = `${minutes ? `${hm(b.start)}–${hm(b.start + span)}` : hours ? `${String(new Date(b.start).getHours()).padStart(2, "0")}:00–${String(new Date(b.start + span).getHours()).padStart(2, "0")}:00` : `${new Date(b.start).getMonth() + 1} 月 ${new Date(b.start).getDate()} 日`}：${b.total} 次${b.total ? `（${KINDS.filter((k) => b.by[k]).map((k) => `${AGENT_LABEL[k]} ${b.by[k]}`).join("、")}）` : ""}`;
			return `<div class="act-col" style="width:${W}%" title="${esc(tip)}">
				<div class="act-bar" style="height:${(b.total / max) * 100}%">${segs}</div>
				<span class="act-label">${label(b, i)}</span>
			</div>`;
		})
		.join("");
	const total = buckets.reduce((s, b) => s + b.total, 0);
	return { html: `<div class="act-chart"><div class="act-grid"><span>${max}</span><span>${max >= 2 ? Math.round(max / 2) : ""}</span><span>0</span></div><div class="act-cols">${cols}</div></div>`, total };
}

function usage() {
	let root;
	let mode = "day";
	return {
		title: "用量",
		sub: "",
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
						<div class="act-legend">${KINDS.map((k) => `<span><i style="background:${agentColor(k)}"></i>${esc(AGENT_LABEL[k] ?? k)}</span>`).join("")}</div>
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
		sub: "",
		mount(r) {
			root = r;
			root.addEventListener("click", (e) => {
				const target = e.target instanceof Element ? e.target : null;
				if (!target || !store.state) return;
				if (target.closest("[data-edit-orch]")) openOrchestratorEditor(store.state.orchestrator);
				else if (target.closest("[data-edit-limits]")) openLimitsEditor(store.state);
				else if (target.closest("[data-edit-autonomy]")) openAutonomyEditor(store.state.autonomy);
			});
			this.update("all");
		},
		update(kind) {
			if (kind !== "all" && kind !== "state" && kind !== "snapshot") return;
			const s = store.state;
			if (!s) {
				root.innerHTML = empty("加载中…");
				return;
			}
			const canEdit = !!s.canEditSettings;
			const o = s.orchestrator;
			const ex = s.execution ?? { maxConcurrent: 8, perMember: 4, perService: 8 };
			const dl = (rows) => `<dl class="kvs wide">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
			const code = (v) => `<code>${esc(v)}</code>`;
			root.innerHTML = `
				<section class="card"><header class="card-head"><h2 class="card-title">进程</h2></header>
					<div class="card-body">${dl([
						["配置文件", `<button type="button" class="linkish mono" data-copy="${esc(s.configPath)}">${esc(s.configPath)}</button>`],
						["工作目录", code(s.workdir)],
						["会话存储", code(s.storage)],
						["历史条目", num(s.entries)],
						["进程", `pid ${s.pid} · 已运行 ${duration(Date.now() - s.startedAt)}`],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">总调度</h2>${canEdit ? `<button type="button" class="ghost-btn tiny" data-edit-orch="1">编辑总控</button>` : ""}</header>
					<div class="card-body">${dl([
						["协议", code(o.type)],
						["模型", code(o.modelId)],
						["地址", o.host ? code(o.host) : "—"],
						["密钥来源", /未找到|解析失败/.test(o.keySource ?? "") ? `<span class="err-t">${esc(o.keySource)}</span>` : esc(o.keySource)],
						["最多轮数", o.maxTurns],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">成员</h2><a class="ghost-btn tiny" href="#/agents">前往成员管理</a></header>
					<div class="table-wrap"><table class="table"><thead><tr><th>成员</th><th>状态</th><th>接入方式</th><th>参数 / 工具</th><th class="num">超时</th><th class="num hide-sm">输出上限</th></tr></thead>
					<tbody>${s.agents
						.map((a) => {
							const how = a.api ? `API · ${esc(a.api.type)} · ${esc(a.api.host)}<br><span class="muted">密钥：${esc(a.api.keySource)}</span>` : "本机 CLI";
							const args = a.api
								? esc([...(a.api.tools ?? []), ...(a.api.codeTools ?? [])].join(" / ") || "未授予文件或命令工具")
								: esc(a.extraArgs.join(" ") || "—");
							return `<tr><td>${agentTag(a.kind)}</td><td class="nowrap">${a.available ? "可用" : `<span class="muted">${esc(a.reason)}</span>`}</td><td>${how}</td><td class="mono">${args}</td><td class="num mono">${a.timeoutMinutes}m</td><td class="num mono hide-sm">${num(a.maxOutputChars)}</td></tr>`;
						})
						.join("")}</tbody></table></div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">工作区隔离、并发与预算</h2>${canEdit ? `<button type="button" class="ghost-btn tiny" data-edit-limits="1">编辑并发与预算</button>` : ""}</header>
					<div class="card-body">${dl([
						["工作区隔离", s.isolation?.enabled ? "开启：每次新派工在独立的 git worktree 里干活，合并后才进主目录" : "关闭：成员直接在工作目录里改文件"],
						["挂进 worktree 的目录", (s.isolation?.linkDirs ?? []).map((d) => code(d)).join(" ") || "—"],
						["并发上限", `团队 ${ex.maxConcurrent} 路 · 单成员 ${ex.perMember} 路 · 同服务 ${ex.perService} 路`],
						["单次运行花费上限", s.budget?.perRunUsd != null ? `${money(s.budget.perRunUsd)}（超过后不再派工）` : "不限"],
						["每次派工预留", s.budget?.reservePerDispatchUsd ? `${money(s.budget.reservePerDispatchUsd)}（估计）` : "关闭"],
						["总调度单价", s.orchestrator.price ? `输入 $${s.orchestrator.price.input} · 输出 $${s.orchestrator.price.output} / 百万 tokens` : "未配置（总调度花费显示为 —）"],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">子调度与自动验收</h2>${canEdit ? `<button type="button" class="ghost-btn tiny" data-edit-autonomy="1">编辑自动验收</button>` : ""}</header>
					<div class="card-body">${dl([
						["子调度", s.lead?.enabled === false ? "关闭" : "开启：总调度可以用 delegate_to_lead 把较大的子目标整块交给子负责人（只有一层，花费算在同一轮里）"],
						[
							"自动验收",
							s.autonomy?.enabled
								? s.autonomy.checks?.length
									? s.autonomy.checks.map((c) => `${esc(c.name)}：${code([c.command, ...(c.args ?? [])].join(" "))}${c.timeoutSeconds ? ` · ${c.timeoutSeconds}s` : ""}`).join("<br>")
									: "开启，但没有配置验收命令"
								: "关闭",
						],
						["自动修复", s.autonomy?.enabled ? `验收失败时在同一会话里最多修 ${s.autonomy.maxRepairAttempts} 次` : "关闭"],
						["返回总调度的结果长度", s.autonomy?.enabled ? `最多 ${num(s.autonomy.resultMaxChars)} 字符` : "按成员的输出上限"],
						["已验证的修复记录", s.autonomy?.learning?.lessons?.length ? `${s.autonomy.learning.lessons.length} 条` : "还没有"],
					])}</div></section>
				<section class="card"><header class="card-head"><h2 class="card-title">启动子 CLI 前去掉的环境变量</h2></header>
					<div class="card-body chips">${s.stripEnv.map((p) => `<code>${esc(p)}</code>`).join("")}</div></section>`;
		},
	};
}

export const VIEWS = { overview, project, dag, topology, runs, dispatches, changes, agents, conventions, sessions, usage, config };
