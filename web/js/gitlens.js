// GitLens 风格「改动与推送管理」工作台：
// 多仓库切换 + 远端同步/Commit/Push 工具栏 + 多泳道 Git Commit Graph（融合 Agent worktree & 联合集成）+ 文件树与 Diff 检视器 + 关键风险人工确认网关。
import { openDispatch } from "./drawer.js";
import { openRepairIntegrationDialog, runControlAction } from "./editors.js";
import { store } from "./store.js";
import { AGENT_LABEL, agentColor, ago, copy, esc, getJson, post, short, stamp, toast } from "./util.js";

const LANE_COLORS = [
	"var(--run)",
	"var(--claude)",
	"var(--codex)",
	"var(--gemini)",
	"var(--deepseek)",
	"var(--lead)",
	"var(--ok)",
];
const CHANGE_LABEL = { running: "进行中", pending: "待合并", conflict: "有冲突", applied: "已合并", empty: "无改动", dropped: "已丢弃" };
const CHANGE_PILL = { running: "running", pending: "pending", conflict: "error", applied: "done", empty: "aborted", dropped: "aborted" };
const GATE_ACTION_LABEL = { commit: "提交确认", push: "推送确认", force_push: "风险强推 / 分叉", pull: "分叉拉取" };

/** 统一差异 → 带行号的着色视图（先转义，不信任内容） */
export function renderDiff(text) {
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

/** 计算每条 Commit / WORKTREE 行的 GitLens 地铁轨道布局 */
export function computeCommitLanes(rows) {
	let active = []; // sha[] | null[]
	let colorOf = new Map();
	let nextColor = 0;
	const pickColor = (sha, preferAgent) => {
		if (preferAgent) return agentColor(preferAgent);
		if (colorOf.has(sha)) return colorOf.get(sha);
		const c = LANE_COLORS[nextColor++ % LANE_COLORS.length];
		colorOf.set(sha, c);
		return c;
	};
	const laidOut = [];
	let maxLanes = 1;
	for (const row of rows) {
		const id = row.sha;
		const inLanes = [...active];
		let lane = active.indexOf(id);
		const hadIncoming = lane !== -1;
		if (lane === -1) {
			lane = active.indexOf(null);
			if (lane === -1) lane = active.length;
		}
		const nodeAgent = row.changes?.[0]?.agent;
		const color = row.isWorktree ? "var(--signal)" : pickColor(id, nodeAgent);
		colorOf.set(id, color);

		const next = [...active];
		if (!hadIncoming && lane >= next.length) next.length = lane + 1;
		const parents = row.parents ?? [];
		const outgoing = []; // { targetLane, color, merge }
		if (parents.length > 0) {
			const p0 = parents[0];
			const existing0 = next.indexOf(p0);
			if (existing0 !== -1 && existing0 !== lane) {
				next[lane] = null;
				outgoing.push({ targetLane: existing0, color, merge: true });
			} else {
				next[lane] = p0;
				if (!colorOf.has(p0)) colorOf.set(p0, row.isWorktree ? LANE_COLORS[0] : color);
				outgoing.push({ targetLane: lane, color: colorOf.get(p0) ?? color, merge: false });
			}
			for (const p of parents.slice(1)) {
				let pLane = next.indexOf(p);
				if (pLane === -1) {
					pLane = next.indexOf(null);
					if (pLane === -1) { pLane = next.length; next.push(p); }
					else next[pLane] = p;
				}
				const pColor = pickColor(p, null);
				outgoing.push({ targetLane: pLane, color: pColor, merge: true });
			}
		} else {
			next[lane] = null;
		}
		while (next.length && next[next.length - 1] === null) next.pop();

		const passThrough = [];
		for (let i = 0; i < Math.max(inLanes.length, next.length); i++) {
			if (i === lane) continue;
			const shaTop = inLanes[i];
			const shaBot = next[i];
			if (shaTop && shaBot && shaTop === shaBot) {
				passThrough.push({ lane: i, color: colorOf.get(shaTop) ?? LANE_COLORS[i % LANE_COLORS.length] });
			}
		}
		maxLanes = Math.max(maxLanes, inLanes.length, next.length, lane + 1);
		laidOut.push({ row, lane, color, hadIncoming, passThrough, outgoing });
		active = next;
	}
	return { rows: laidOut, maxLanes: Math.min(8, maxLanes) };
}

function renderLaneSvg(item, maxLanes) {
	const W = Math.max(28, maxLanes * 15 + 10);
	const H = 44;
	const midY = 22;
	const lx = (i) => 11 + i * 15;
	const parts = [];
	for (const pt of item.passThrough) {
		if (pt.lane >= maxLanes) continue;
		const x = lx(pt.lane);
		parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${pt.color}" stroke-width="1.8" stroke-opacity="0.72"/>`);
	}
	const cx = lx(Math.min(item.lane, maxLanes - 1));
	if (item.hadIncoming) {
		parts.push(`<line x1="${cx}" y1="0" x2="${cx}" y2="${midY}" stroke="${item.color}" stroke-width="2" stroke-opacity="0.9"/>`);
	}
	for (const out of item.outgoing) {
		const tx = lx(Math.min(out.targetLane, maxLanes - 1));
		if (tx === cx) {
			parts.push(`<line x1="${cx}" y1="${midY}" x2="${tx}" y2="${H}" stroke="${out.color}" stroke-width="2" stroke-opacity="0.88"${item.row.isWorktree ? ' stroke-dasharray="3 2.5"' : ""}/>`);
		} else {
			parts.push(`<path d="M${cx},${midY} C${cx},${midY + 12} ${tx},${midY + 10} ${tx},${H}" fill="none" stroke="${out.color}" stroke-width="1.85" stroke-opacity="0.82"/>`);
		}
	}
	if (item.row.isWorktree) {
		parts.push(`<circle cx="${cx}" cy="${midY}" r="5" fill="var(--panel)" stroke="var(--signal)" stroke-width="2" stroke-dasharray="2.5 2"/>`);
	} else if (item.row.isHead) {
		parts.push(`<circle cx="${cx}" cy="${midY}" r="7.5" fill="none" stroke="${item.color}" stroke-width="1.4" stroke-opacity="0.5"/>`);
		parts.push(`<circle cx="${cx}" cy="${midY}" r="4.5" fill="${item.color}" stroke="var(--panel)" stroke-width="1.5"/>`);
	} else if (item.row.changes?.length) {
		parts.push(`<rect x="${cx - 4.5}" y="${midY - 4.5}" width="9" height="9" rx="3" transform="rotate(45 ${cx} ${midY})" fill="${item.color}" stroke="var(--panel)" stroke-width="1.2"/>`);
	} else {
		parts.push(`<circle cx="${cx}" cy="${midY}" r="3.8" fill="${item.color}" stroke="var(--panel)" stroke-width="1.3"/>`);
	}
	return `<svg class="gl-rail-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${parts.join("")}</svg>`;
}

function diffBlocksHtml(add = 0, del = 0) {
	const total = add + del;
	if (!total) return `<span class="gl-diffbars muted">—</span>`;
	const blocks = 5;
	const addCount = Math.min(blocks, Math.max(add > 0 ? 1 : 0, Math.round((add / total) * blocks)));
	const delCount = Math.min(blocks - addCount, del > 0 ? Math.max(1, blocks - addCount) : 0);
	const rects = [];
	for (let i = 0; i < addCount; i++) rects.push('<i class="a"></i>');
	for (let i = 0; i < delCount; i++) rects.push('<i class="d"></i>');
	while (rects.length < blocks) rects.push('<i class="e"></i>');
	return `<span class="gl-diffstats"><span class="gl-diffbars" title="+${add} / −${del}">${rects.join("")}</span><span class="mono ok-t">+${add}</span><span class="mono err-t">−${del}</span></span>`;
}

function renderRefs(row) {
	const pills = [];
	if (row.isWorktree) pills.push(`<span class="gl-ref worktree">工作区未提交</span>`);
	if (row.isHead) pills.push(`<span class="gl-ref head">HEAD</span>`);
	for (const ref of row.refs ?? []) {
		if (ref === "HEAD") continue;
		const clean = ref.replace(/^HEAD -> /, "");
		const isOrigin = clean.includes("/");
		pills.push(`<span class="gl-ref ${isOrigin ? "remote" : "branch"}">${esc(clean)}</span>`);
	}
	if (row.unpushed && !row.isWorktree) pills.push(`<span class="gl-ref unpushed" title="本地领先远端尚未推送">↑ 未推送</span>`);
	for (const ch of row.changes ?? []) {
		const who = AGENT_LABEL[ch.agent] ?? ch.agent;
		pills.push(`<span class="gl-ref change s-${esc(ch.status)}" style="--c:${agentColor(ch.agent)}" title="${esc(ch.branch)}">#${esc(ch.id)} ${esc(who)}·${esc(CHANGE_LABEL[ch.status] ?? ch.status)}</span>`);
	}
	return pills.join("");
}

export function createChangesView() {
	let root;
	let repos = [];
	let activeRepo = null;
	let graphData = null;
	let workbench = { requireHumanPush: false, gates: [] };
	let selectedTarget = null; // "WORKTREE" | commit sha | change id
	let selectedFile = null;
	let graphFilter = "all"; // all | unpushed | changes
	let search = "";
	let commitMessageDraft = "";
	let selectedFilesForCommit = null; // Set<string> | null
	let detailData = null;
	let loadingDetail = false;
	let divergedPrompt = null; // { branch, remote, ahead, behind, error } | null
	let lastGateSig = "";

	function renderGraphRowsHtml(laneRows, maxLanes, emptyMsg) {
		return laneRows.length
			? laneRows
					.map((item) => {
						const r = item.row;
						const active = selectedTarget === r.sha;
						return `<div class="gl-row${active ? " active" : ""}${r.isWorktree ? " worktree" : ""}${r.unpushed ? " unpushed" : ""}" data-select-node="${esc(r.sha)}">
							<div class="gl-cell-rail">${renderLaneSvg(item, maxLanes)}</div>
							<div class="gl-cell-main">
								<div class="gl-cell-top">${renderRefs(r)}<span class="gl-subj">${esc(short(r.subject || "(无标题)", 90))}</span></div>
								<div class="gl-cell-sub"><span class="mono">${esc(r.shortSha)}</span><span>${esc(r.author)}</span><span>${r.isWorktree ? "刚刚" : ago(r.at)}</span></div>
							</div>
							<div class="gl-cell-diff">${diffBlocksHtml(r.add, r.del)}</div>
						</div>`;
					})
					.join("")
			: `<div class="empty-inline"><span class="dot"></span>${esc(emptyMsg)}</div>`;
	}

	async function refreshAll(preferredChangeId) {
		try {
			const listRes = await getJson("/api/git/repos");
			repos = listRes.repos ?? [];
			workbench = listRes.workbench ?? { requireHumanPush: false, gates: [] };
			if (preferredChangeId) {
				const ch = store.changes.find((c) => c.id === preferredChangeId);
				if (ch?.root && repos.some((r) => r.root.toLowerCase() === ch.root.toLowerCase())) {
					activeRepo = ch.root;
					selectedTarget = ch.head || `change:${ch.id}`;
				}
			}
			if (!activeRepo || !repos.some((r) => r.root.toLowerCase() === activeRepo.toLowerCase())) {
				activeRepo = repos[0]?.root ?? null;
			}
			if (!activeRepo) {
				render();
				return;
			}
			await loadGraph();
		} catch (err) {
			toast(err.message);
		}
	}

	async function loadGraph() {
		if (!activeRepo) return;
		const g = await getJson(`/api/git/graph?repo=${encodeURIComponent(activeRepo)}&limit=65`);
		graphData = g;
		workbench = g.workbench ?? workbench;
		const working = g.working ?? [];
		if (selectedTarget === "WORKTREE" && !working.length) selectedTarget = g.commits?.[0]?.sha ?? null;
		if (!selectedTarget) {
			selectedTarget = working.length ? "WORKTREE" : g.commits?.[0]?.sha ?? (g.repoChanges?.[0] ? `change:${g.repoChanges[0].id}` : null);
		}
		if (working.length && selectedFilesForCommit === null) {
			selectedFilesForCommit = new Set(working.filter((w) => !w.conflict).map((w) => w.path));
		} else if (!working.length) {
			selectedFilesForCommit = null;
		}
		render();
		await loadDetail();
	}

	async function loadDetail() {
		if (!selectedTarget || !activeRepo) {
			detailData = null;
			renderInspector();
			return;
		}
		if (selectedTarget.startsWith("change:")) {
			const cid = selectedTarget.slice(7);
			const ch = graphData?.repoChanges?.find((x) => x.id === cid) ?? store.changes.find((x) => x.id === cid);
			if (!ch) { detailData = null; renderInspector(); return; }
			loadingDetail = true;
			renderInspector();
			try {
				const diff = ch.files?.length ? await getJson(`/api/changes/${encodeURIComponent(ch.id)}/diff`) : { text: "", truncated: false };
				detailData = { kind: "change", change: ch, files: ch.files ?? [], diff: diff.text ?? "", truncated: !!diff.truncated, error: diff.error };
			} catch (err) {
				detailData = { kind: "change", change: ch, files: ch.files ?? [], diff: "", error: err.message };
			} finally {
				loadingDetail = false;
				renderInspector();
			}
			return;
		}
		loadingDetail = true;
		renderInspector();
		try {
			const fileQs = selectedFile ? `&file=${encodeURIComponent(selectedFile)}` : "";
			const data = await getJson(`/api/git/commit?repo=${encodeURIComponent(activeRepo)}&sha=${encodeURIComponent(selectedTarget)}${fileQs}`);
			detailData = { kind: "commit", ...data };
		} catch (err) {
			detailData = { kind: "error", error: err.message };
		} finally {
			loadingDetail = false;
			renderInspector();
		}
	}

	function buildGraphRows() {
		if (!graphData) return [];
		const rows = [];
		if (graphData.working?.length) {
			rows.push({
				sha: "WORKTREE",
				shortSha: "WORK",
				isWorktree: true,
				parents: graphData.repo?.head ? [graphData.repo.head] : [],
				refs: [],
				author: "工作区",
				at: Date.now(),
				subject: `${graphData.working.length} 个未提交文件${graphData.repo?.conflictCount ? `（含 ${graphData.repo.conflictCount} 处冲突）` : ""}`,
				filesCount: graphData.working.length,
				add: 0,
				del: 0,
				unpushed: false,
				changes: [],
			});
		}
		for (const c of graphData.commits ?? []) rows.push(c);
		// 补充尚不在 log --all 中的孤立改动（如极旧提交或空改动）
		const seenHeads = new Set(rows.map((r) => r.sha));
		for (const ch of graphData.repoChanges ?? []) {
			if (ch.status === "dropped") continue;
			if (ch.head && seenHeads.has(ch.head)) continue;
			rows.push({
				sha: `change:${ch.id}`,
				shortSha: ch.id,
				parents: ch.base && seenHeads.has(ch.base) ? [ch.base] : [],
				refs: [ch.branch],
				author: AGENT_LABEL[ch.agent] ?? ch.agent,
				at: ch.updatedAt,
				subject: ch.task,
				filesCount: ch.files.length,
				add: ch.add,
				del: ch.del,
				isHead: false,
				isUpstream: false,
				unpushed: false,
				changes: [{
					id: ch.id, agent: ch.agent, model: ch.model, status: ch.status, branch: ch.branch,
					base: ch.base, head: ch.head, task: ch.task, filesCount: ch.files.length, add: ch.add, del: ch.del,
					basedOn: ch.basedOn, integrationStatus: ch.integration?.status,
				}],
			});
		}
		let filtered = rows;
		if (graphFilter === "unpushed") filtered = rows.filter((r) => r.unpushed || r.isWorktree || r.changes?.some((c) => c.status === "pending"));
		else if (graphFilter === "changes") filtered = rows.filter((r) => r.changes?.length > 0 || r.isWorktree);
		const q = search.trim().toLowerCase();
		if (q) {
			filtered = filtered.filter((r) =>
				r.subject?.toLowerCase().includes(q) ||
				r.sha.toLowerCase().includes(q) ||
				r.author?.toLowerCase().includes(q) ||
				(r.refs ?? []).some((x) => x.toLowerCase().includes(q)) ||
				(r.changes ?? []).some((c) => c.id.toLowerCase().includes(q) || c.branch.toLowerCase().includes(q)),
			);
		}
		return filtered;
	}

	function render() {
		if (!root) return;
		const repo = graphData?.repo;
		const pendingGates = (workbench.gates ?? []).filter((g) => g.status === "pending");
		const rows = buildGraphRows();
		const { rows: laneRows, maxLanes } = computeCommitLanes(rows);

		root.innerHTML = `
			<div class="gl-workbench">
				<section class="card gl-topbar">
					<div class="gl-repo-row">
						<div class="gl-repos" data-n="repos">
							${repos.map((r) => `<button type="button" class="gl-repo-tab${repo && r.root.toLowerCase() === repo.root.toLowerCase() ? " on" : ""}" data-select-repo="${esc(r.root)}" title="${esc(r.root)}">
								<span class="gl-repo-name">${r.isMain ? "📦" : "📁"} ${esc(r.name)}</span>
								${r.branch ? `<span class="gl-mini-branch mono">${esc(r.branch)}</span>` : ""}
								${r.ahead > 0 ? `<span class="gl-badge sky">↑${r.ahead}</span>` : ""}
								${r.behind > 0 ? `<span class="gl-badge warn">↓${r.behind}</span>` : ""}
								${r.changeCounts?.pending ? `<span class="gl-badge mint">待合 ${r.changeCounts.pending}</span>` : ""}
							</button>`).join("")}
						</div>
						<div class="gl-top-controls">
							<button type="button" class="ghost-btn tiny gl-policy-btn${workbench.requireHumanPush ? " strict" : ""}" data-toggle-policy="1" title="切换 Agent 是否允许自主推送无分叉快进更新">
								${workbench.requireHumanPush ? "🔒 推送前需我确认" : "🤖 Agent 可推干净快进（分叉/冲突交人工）"}
							</button>
							<button type="button" class="ghost-btn tiny" data-clean-changes="1" title="清理已合并或空改动的 worktree">清理 worktree</button>
						</div>
					</div>
					${repo ? `
					<div class="gl-sync-bar">
						<div class="gl-branch-status">
							<span class="gl-branch-pill mono">⎇ ${esc(repo.branch ?? "未初始化")}</span>
							${repo.upstream ? `<span class="muted">→</span><span class="gl-up-pill mono">${esc(repo.upstream)}</span>` : repo.remote ? `<span class="gl-up-pill muted">未关联远端跟踪（${esc(repo.remote)}）</span>` : `<span class="gl-up-pill muted">无远端仓库</span>`}
							${!repo.isGit ? `<span class="gl-badge warn">未执行 git init</span>` : repo.ahead === 0 && repo.behind === 0 && repo.upstream ? `<span class="gl-badge ok">✓ 已与远端同步</span>` : ""}
							${repo.ahead > 0 ? `<span class="gl-badge sky">↑ ${repo.ahead} 个提交待推送</span>` : ""}
							${repo.behind > 0 ? `<span class="gl-badge warn">↓ 远端领先 ${repo.behind} 个提交</span>` : ""}
							${repo.dirtyCount > 0 ? `<span class="gl-badge amber">工作区 ${repo.dirtyCount} 处未提交</span>` : ""}
						</div>
						<div class="gl-sync-btns">
							<button type="button" class="ghost-btn tiny" data-git-fetch="1" ${!repo.isGit || !repo.remotes.length ? "disabled" : ""}>Fetch</button>
							<button type="button" class="${repo.behind > 0 ? "primary-btn" : "ghost-btn"} tiny" data-git-pull="1" ${!repo.isGit || !repo.remotes.length ? "disabled" : ""}>Pull${repo.behind > 0 ? ` ↓${repo.behind}` : ""}</button>
							<button type="button" class="ghost-btn tiny" data-focus-worktree="1" ${!repo.dirtyCount ? "disabled" : ""}>Commit${repo.dirtyCount ? ` (${repo.dirtyCount})` : ""}</button>
							<button type="button" class="primary-btn tiny gl-push-btn" data-git-push="1" ${!repo.isGit || !repo.remotes.length ? "disabled" : ""}>Push${repo.ahead > 0 ? ` ↑${repo.ahead}` : ""}</button>
						</div>
					</div>
					` : ""}
					${divergedPrompt ? `
					<div class="gl-diverge-alert">
						<div><strong>⚠ 分叉提示（${esc(divergedPrompt.remote)}/${esc(divergedPrompt.branch)}）</strong><p>${esc(divergedPrompt.error)}</p></div>
						<div class="row-actions">
							<button type="button" class="primary-btn tiny" data-diverge-pull="1">先拉取快进 (Pull --ff-only)</button>
							<button type="button" class="danger-btn tiny" data-diverge-force="1">确认强推 (--force-with-lease)</button>
							<button type="button" class="ghost-btn tiny" data-diverge-dismiss="1">取消</button>
						</div>
					</div>` : ""}
				</section>

				${pendingGates.length ? `
				<section class="gl-gates">
					${pendingGates.map((g) => `
						<div class="card gl-gate-card">
							<div class="gl-gate-main">
								<span class="pill" data-s="error">${esc(GATE_ACTION_LABEL[g.action] ?? g.action)}</span>
								<strong class="mono">${esc(g.repo.split(/[\\/]/).pop() || g.repo)} · ${esc(g.branch)}</strong>
								<span>${esc(g.reason)}</span>
								${g.message ? `<code class="gl-gate-msg">${esc(short(g.message, 80))}</code>` : ""}
								${g.details?.length ? `<span class="muted mono">${esc(g.details.join(" · "))}</span>` : ""}
							</div>
							<div class="row-actions">
								<button type="button" class="primary-btn tiny" data-gate-approve="${esc(g.id)}">批准并执行</button>
								<button type="button" class="ghost-btn tiny" data-gate-reject="${esc(g.id)}">驳回</button>
							</div>
						</div>
					`).join("")}
				</section>` : ""}

				<div class="gl-split">
					<section class="card gl-graph-card">
						<header class="card-head gl-graph-head">
							<div class="seg" data-n="graphFilter">
								<button type="button" data-k="all" class="${graphFilter === "all" ? "on" : ""}">全部图谱</button>
								<button type="button" data-k="unpushed" class="${graphFilter === "unpushed" ? "on" : ""}">未推送 ↑</button>
								<button type="button" data-k="changes" class="${graphFilter === "changes" ? "on" : ""}">Agent 分支</button>
							</div>
							<input class="gl-search" type="search" placeholder="筛选提交、分支、作者或 #改动编号…" value="${esc(search)}" data-n="search" />
						</header>
						<div class="gl-graph-scroll" data-n="graphList">
							${renderGraphRowsHtml(laneRows, maxLanes, repo && !repo.isGit ? "当前目录尚未初始化 Git 仓库。" : "没有匹配的提交或改动记录。")}
						</div>
					</section>

					<section class="card gl-inspector" data-n="inspector"></section>
				</div>
			</div>`;
		renderInspector();
	}

	function renderInspector() {
		const box = root?.querySelector('[data-n="inspector"]');
		if (!box) return;
		if (!selectedTarget) {
			box.innerHTML = `<div class="card-body"><div class="empty-inline"><span class="dot"></span>在左侧 GitLens 提交图谱中选择任意提交、工作区或成员改动查看详尽差异与推送操作。</div></div>`;
			return;
		}
		if (loadingDetail && !detailData) {
			box.innerHTML = `<div class="card-body"><div class="empty-inline"><span class="dot"></span>加载差异详情中…</div></div>`;
			return;
		}
		if (!detailData || detailData.kind === "error") {
			box.innerHTML = `<div class="card-body"><div class="change-msg err">${esc(detailData?.error ?? "无法读取详情")}</div></div>`;
			return;
		}

		if (detailData.kind === "change") {
			const c = detailData.change;
			const actionable = (c.status === "pending" || c.status === "conflict") && !c.integration?.supersededBy && (!c.integration || c.integration.status === "passed");
			const dispatch = store.dispatches.find((d) => d.changeId === c.id);
			box.innerHTML = renderChangeInspector(c, actionable, dispatch, detailData);
			bindInspectorEvents(box, c);
			return;
		}

		// Commit / WORKTREE Inspector
		const d = detailData;
		const linkedChanges = (graphData?.repoChanges ?? []).filter((ch) => !d.isWorktree && ch.head === d.sha && ch.status !== "dropped");
		const primaryChange = linkedChanges[0];
		const actionable = primaryChange && (primaryChange.status === "pending" || primaryChange.status === "conflict") && !primaryChange.integration?.supersededBy && (!primaryChange.integration || primaryChange.integration.status === "passed");
		const dispatch = primaryChange ? store.dispatches.find((x) => x.changeId === primaryChange.id) : null;
		const files = d.files ?? [];
		const workingFiles = d.isWorktree ? (graphData?.working ?? []) : [];

		box.innerHTML = `
			<header class="detail-head gl-insp-head">
				<div class="gl-insp-title-wrap">
					<h2 class="eyebrow">${d.isWorktree ? "WORKTREE · 未提交更改" : `COMMIT · ${esc(d.sha.slice(0, 10))}`}</h2>
					<p class="detail-title">${esc(d.subject || "(无提交说明)")}</p>
				</div>
				<div class="row-actions">
					${!d.isWorktree ? `<button type="button" class="copy-cmd mono" data-copy-sha="${esc(d.sha)}">${esc(d.sha.slice(0, 8))}</button>` : ""}
				</div>
			</header>
			${!d.isWorktree ? `<div class="detail-meta">
				<span>${esc(d.author ?? "—")}</span>
				<span class="sep"></span>
				<span>${d.at ? stamp(d.at) : "—"}</span>
				${d.parents?.length ? `<span class="sep"></span><span class="muted">父节点 ${d.parents.map((p) => `<button type="button" class="linkish mono" data-jump-sha="${esc(p)}">${esc(p.slice(0, 7))}</button>`).join(" ")}</span>` : ""}
			</div>` : ""}
			${d.body ? `<pre class="gl-commit-body">${esc(d.body)}</pre>` : ""}
			<div class="detail-scroll">
				${d.isWorktree ? `
					<div class="gl-commit-box">
						<textarea class="gl-commit-input" rows="2" placeholder="输入清晰的 Commit Message…" data-n="commitMsg">${esc(commitMessageDraft)}</textarea>
						<div class="gl-commit-foot">
							<div class="row-actions">
								<button type="button" class="ghost-btn tiny" data-stage-all="1">全选</button>
								<button type="button" class="ghost-btn tiny" data-stage-none="1">全不选</button>
								<span class="muted">已选 ${selectedFilesForCommit?.size ?? 0}/${files.length}</span>
							</div>
							<div class="row-actions">
								<button type="button" class="ghost-btn tiny" data-do-commit="0">Commit 所选</button>
								<button type="button" class="primary-btn tiny" data-do-commit="1">Commit &amp; Push</button>
							</div>
						</div>
					</div>` : ""}
				${linkedChanges.map((c) => renderLinkedChangeBanner(c, c === primaryChange && actionable, dispatch)).join("")}
				<div class="gl-files-head">
					<h3 class="eyebrow">文件变更树 <span class="eyebrow-note">${files.length} 个文件</span></h3>
					${selectedFile ? `<button type="button" class="linkish tiny" data-clear-file="1">显示全部 Diff</button>` : ""}
				</div>
				<div class="file-list gl-file-tree">
					${files.length ? files.map((f) => {
						const wf = workingFiles.find((w) => w.path === f.path);
						const checked = d.isWorktree ? (selectedFilesForCommit?.has(f.path) ?? false) : false;
						const activeFile = selectedFile === f.path;
						return `<div class="file-row gl-file-row${activeFile ? " on" : ""}" data-select-file="${esc(f.path)}">
							<span class="gl-file-left">
								${d.isWorktree ? `<input type="checkbox" data-check-file="${esc(f.path)}" ${checked ? "checked" : ""} />` : ""}
								<span class="gl-file-tag mono">${esc((wf?.statusLabel ?? f.statusLabel ?? "改").slice(0, 2))}</span>
								<span class="mono gl-file-path">${esc(f.path)}</span>
								${f.sensitive ? `<span class="gl-badge warn">敏感</span>` : ""}
								${wf?.conflict ? `<span class="gl-badge warn">冲突</span>` : ""}
							</span>
							${diffBlocksHtml(f.add, f.del)}
						</div>`;
					}).join("") : `<div class="empty-inline"><span class="dot"></span>没有文件变更</div>`}
				</div>
				<h3 class="eyebrow">${selectedFile ? `Diff · ${esc(selectedFile)}` : "Diff 视图"}</h3>
				<div data-n="diff">${d.diff ? renderDiff(d.diff) : `<div class="empty-inline"><span class="dot"></span>无文本差异（可能是二进制或未跟踪空文件）</div>`}${d.truncated ? `<p class="footnote">差异超过 350KB 已截断，可点击上方单个文件查看局部 Diff。</p>` : ""}</div>
			</div>`;
		bindInspectorEvents(box, primaryChange, d.isWorktree);
	}

	function renderLinkedChangeBanner(c, actionable, dispatch) {
		const cmd = (verb) => `/${verb} ${c.id}`;
		return `<div class="change-msg gl-change-card">
			<div class="gl-change-card-top">
				<strong>Lemma 改动 #${esc(c.id)}</strong>
				<span class="pill" data-s="${CHANGE_PILL[c.status]}">${CHANGE_LABEL[c.status] ?? c.status}</span>
				<span class="mono muted">${esc(c.branch)}</span>
				${dispatch ? `<button type="button" class="linkish" data-open-dispatch="${esc(dispatch.key)}">查看派工</button>` : ""}
			</div>
			${c.message ? `<p>${esc(c.message)}</p>` : ""}
			<div class="row-actions">
				${actionable ? `<button type="button" class="primary-btn tiny" data-apply-change="${esc(c.id)}">合并到主目录</button>` : ""}
				${c.branch && c.status !== "dropped" ? `<button type="button" class="ghost-btn tiny" data-push-branch="${esc(c.branch)}">推送分支到远端</button>` : ""}
				${actionable ? `<button type="button" class="ghost-btn tiny" data-drop-change="${esc(c.id)}">丢弃改动</button>` : ""}
				${actionable ? `<button type="button" class="copy-cmd mono" data-copy="${cmd("apply")}">${cmd("apply")}</button>` : ""}
			</div>
			${c.integration ? `<div class="gl-int-sub"><strong>联合集成 · ${esc(c.integration.status)}${c.integration.supersededBy ? `（已被 #${esc(c.integration.supersededBy)} 替代）` : ""}</strong><p>来源：${c.integration.sources.map((s) => `<a href="#/changes/${esc(s.id)}">#${esc(s.id)}</a>`).join(" + ")}</p>${(c.integration.reports ?? []).map((rp) => `<details><summary>${esc(rp.name)} · ${rp.passed ? "通过" : "失败"}</summary><pre>${esc(rp.output || "没有输出")}</pre></details>`).join("")}${!c.integration.supersededBy && !["applied", "dropped"].includes(c.status) ? `<div class="row-actions">${["conflict", "failed"].includes(c.integration.status) ? `<button type="button" class="primary-btn tiny" data-int-repair="${esc(c.id)}">派成员修复</button>` : ""}${!["preparing", "merging", "repairing", "testing"].includes(c.integration.status) ? `<button type="button" class="ghost-btn tiny" data-int-rerun="${esc(c.id)}">重跑集成检查</button>` : ""}</div>` : ""}</div>` : ""}
		</div>`;
	}

	function renderChangeInspector(c, actionable, dispatch, d) {
		return `<header class="detail-head">
			<div><h2 class="eyebrow">改动 #${esc(c.id)}</h2><p class="detail-title">${esc(c.task)}</p></div>
			<span class="pill" data-s="${CHANGE_PILL[c.status]}">${CHANGE_LABEL[c.status] ?? c.status}</span>
		</header>
		<div class="detail-scroll">
			${renderLinkedChangeBanner(c, actionable, dispatch)}
			<h3 class="eyebrow">改了哪些文件 <span class="eyebrow-note">${c.files.length} 个 · +${c.add} −${c.del}</span></h3>
			<div class="file-list">${c.files.length ? c.files.map((f) => `<div class="file-row"><span class="mono">${esc(f.path)}</span>${diffBlocksHtml(f.add, f.del)}</div>`).join("") : `<div class="empty-inline"><span class="dot"></span>没有修改文件</div>`}</div>
			<h3 class="eyebrow">差异</h3>
			<div>${d.error ? `<div class="change-msg err">${esc(d.error)}</div>` : renderDiff(d.diff)}</div>
		</div>`;
	}

	function bindInspectorEvents(box, _change, isWorktree) {
		box.querySelector("[data-copy-sha]")?.addEventListener("click", (e) => copy(e.currentTarget.dataset.copySha));
		box.querySelector("[data-open-dispatch]")?.addEventListener("click", (e) => openDispatch(e.currentTarget.dataset.openDispatch));
		box.querySelectorAll("[data-jump-sha]").forEach((btn) => {
			btn.addEventListener("click", () => {
				selectedTarget = btn.dataset.jumpSha;
				selectedFile = null;
				render();
				loadDetail();
			});
		});
		box.querySelector("[data-clear-file]")?.addEventListener("click", () => {
			selectedFile = null;
			loadDetail();
		});
		box.querySelectorAll("[data-select-file]").forEach((row) => {
			row.addEventListener("click", (e) => {
				if (e.target instanceof HTMLInputElement) return;
				selectedFile = selectedFile === row.dataset.selectFile ? null : row.dataset.selectFile;
				loadDetail();
			});
		});
		if (isWorktree) {
			const msgEl = box.querySelector('[data-n="commitMsg"]');
			msgEl?.addEventListener("input", () => { commitMessageDraft = msgEl.value; });
			box.querySelectorAll("[data-check-file]").forEach((cb) => {
				cb.addEventListener("change", () => {
					selectedFilesForCommit ??= new Set();
					if (cb.checked) selectedFilesForCommit.add(cb.dataset.checkFile);
					else selectedFilesForCommit.delete(cb.dataset.checkFile);
					const counter = box.querySelector(".gl-commit-foot .muted");
					if (counter) counter.textContent = `已选 ${selectedFilesForCommit.size}/${detailData?.files?.length ?? 0}`;
				});
			});
			box.querySelector("[data-stage-all]")?.addEventListener("click", () => {
				selectedFilesForCommit = new Set((detailData?.files ?? []).map((f) => f.path));
				renderInspector();
			});
			box.querySelector("[data-stage-none]")?.addEventListener("click", () => {
				selectedFilesForCommit = new Set();
				renderInspector();
			});
			box.querySelectorAll("[data-do-commit]").forEach((btn) => {
				btn.addEventListener("click", async () => {
					const message = commitMessageDraft.trim();
					if (!message) { toast("请填写 Commit 提交说明"); msgEl?.focus(); return; }
					const files = [...(selectedFilesForCommit ?? [])];
					if (!files.length) { toast("请至少勾选一个要提交的文件"); return; }
					btn.disabled = true;
					try {
						const res = await post("/api/git/commit", { repo: activeRepo, message, files });
						commitMessageDraft = "";
						selectedFilesForCommit = null;
						selectedTarget = res.sha;
						toast(`已提交 ${res.sha.slice(0, 7)}（${res.committedFiles} 个文件）`);
						if (btn.dataset.doCommit === "1") await doPush();
						else await loadGraph();
					} catch (err) {
						toast(err.message);
					} finally {
						btn.disabled = false;
					}
				});
			});
		}
	}

	async function doPush(opts = {}) {
		try {
			const res = await post("/api/git/push", { repo: activeRepo, ...opts });
			divergedPrompt = null;
			toast(res.output || `已推送到 ${res.remote}/${res.branch}`);
			await loadGraph();
		} catch (err) {
			if (err.code === "DIVERGED") {
				divergedPrompt = {
					branch: opts.branch || graphData?.repo?.branch || "HEAD",
					remote: opts.remote || graphData?.repo?.remote || "origin",
					ahead: err.ahead ?? 0,
					behind: err.behind ?? 0,
					error: err.message,
				};
				render();
				return;
			}
			toast(err.message);
		}
	}

	return {
		title: "改动 · GitLens",
		sub: "",
		mount(r, params) {
			root = r;
			const initialId = params[0] ?? null;
			root.addEventListener("click", async (e) => {
				const target = e.target instanceof Element ? e.target : null;
				if (!target) return;
				const repoBtn = target.closest("[data-select-repo]");
				if (repoBtn) {
					activeRepo = repoBtn.dataset.selectRepo;
					selectedTarget = null;
					selectedFile = null;
					divergedPrompt = null;
					await loadGraph();
					return;
				}
				const filterBtn = target.closest('[data-n="graphFilter"] button');
				if (filterBtn) {
					graphFilter = filterBtn.dataset.k;
					render();
					return;
				}
				const nodeRow = target.closest("[data-select-node]");
				if (nodeRow) {
					selectedTarget = nodeRow.dataset.selectNode;
					selectedFile = null;
					render();
					await loadDetail();
					return;
				}
				if (target.closest("[data-git-fetch]")) {
					try { const r2 = await post("/api/git/fetch", { repo: activeRepo }); toast(r2.output); await loadGraph(); }
					catch (err) { toast(err.message); }
					return;
				}
				if (target.closest("[data-git-pull]")) {
					try { const r2 = await post("/api/git/pull", { repo: activeRepo }); divergedPrompt = null; toast(r2.output); await loadGraph(); }
					catch (err) { toast(err.message); }
					return;
				}
				if (target.closest("[data-focus-worktree]")) {
					selectedTarget = "WORKTREE";
					selectedFile = null;
					render();
					await loadDetail();
					return;
				}
				if (target.closest("[data-git-push]")) { await doPush(); return; }
				if (target.closest("[data-diverge-pull]")) {
					try { const r2 = await post("/api/git/pull", { repo: activeRepo }); divergedPrompt = null; toast(r2.output); await loadGraph(); }
					catch (err) { toast(err.message); }
					return;
				}
				if (target.closest("[data-diverge-force]")) {
					const b = divergedPrompt?.branch ?? graphData?.repo?.branch;
					if (!confirm(`确认使用 --force-with-lease 强推分支 ${b}？远端未被本地包含的提交将被安全覆盖。`)) return;
					await doPush({ branch: b, forceWithLease: true });
					return;
				}
				if (target.closest("[data-diverge-dismiss]")) { divergedPrompt = null; render(); return; }
				if (target.closest("[data-toggle-policy]")) {
					try {
						const next = !workbench.requireHumanPush;
						await post("/api/git/policy", { requireHumanPush: next });
						workbench.requireHumanPush = next;
						render();
						toast(next ? "已开启“推送前需我确认”" : "已恢复 Agent 干净快进自主推送");
					} catch (err) { toast(err.message); }
					return;
				}
				const gateApprove = target.closest("[data-gate-approve]");
				if (gateApprove) {
					gateApprove.disabled = true;
					try { await post(`/api/git/gates/${encodeURIComponent(gateApprove.dataset.gateApprove)}/resolve`, { action: "approve" }); toast("已批准并执行"); await loadGraph(); }
					catch (err) { toast(err.message); gateApprove.disabled = false; }
					return;
				}
				const gateReject = target.closest("[data-gate-reject]");
				if (gateReject) {
					gateReject.disabled = true;
					try { await post(`/api/git/gates/${encodeURIComponent(gateReject.dataset.gateReject)}/resolve`, { action: "reject" }); toast("已驳回该请求"); await loadGraph(); }
					catch (err) { toast(err.message); gateReject.disabled = false; }
					return;
				}
				const pushBrBtn = target.closest("[data-push-branch]");
				if (pushBrBtn) { await doPush({ branch: pushBrBtn.dataset.pushBranch, setUpstream: true }); return; }
				if (target.closest("[data-clean-changes]")) {
					if (!confirm("清理所有已合并（applied）或无改动的 worktree 和分支？")) return;
					try { await runControlAction("/api/changes/clean", {}); await refreshAll(); }
					catch (err) { toast(err.message); }
					return;
				}
				const applyBtn = target.closest("[data-apply-change]");
				if (applyBtn) {
					const cid = applyBtn.dataset.applyChange;
					const rec = store.changes.find((x) => x.id === cid);
					if (!confirm(`确认将改动 #${cid}（${rec?.files?.length ?? 0} 个文件，+${rec?.add ?? 0} -${rec?.del ?? 0}）合并到主工作目录？不自动 commit。`)) return;
					try { await runControlAction(`/api/changes/${encodeURIComponent(cid)}/apply`, {}); await loadGraph(); }
					catch (err) { toast(err.message); }
					return;
				}
				const dropBtn = target.closest("[data-drop-change]");
				if (dropBtn) {
					const cid = dropBtn.dataset.dropChange;
					if (!confirm(`确认丢弃改动 #${cid}？对应的 worktree 和未合并分支将被删除！`)) return;
					try { await runControlAction(`/api/changes/${encodeURIComponent(cid)}/drop`, {}); selectedTarget = null; await refreshAll(); }
					catch (err) { toast(err.message); }
					return;
				}
				const rerunBtn = target.closest("[data-int-rerun]");
				if (rerunBtn) {
					try { await runControlAction(`/api/integrations/${encodeURIComponent(rerunBtn.dataset.intRerun)}/rerun`, {}, "已重跑联合集成检查"); await loadGraph(); }
					catch (err) { toast(err.message); }
					return;
				}
				const repairBtn = target.closest("[data-int-repair]");
				if (repairBtn) {
					const cid = repairBtn.dataset.intRepair;
					const it = (store.state?.integrations ?? []).find((x) => x.id === cid) ?? store.changes.find((x) => x.id === cid)?.integration;
					if (it) openRepairIntegrationDialog({ ...it, id: cid }, store.state?.agents ?? []);
				}
			});
			root.addEventListener("input", (e) => {
				const target = e.target;
				if (target instanceof HTMLInputElement && target.dataset.n === "search") {
					search = target.value;
					const listBox = root.querySelector('[data-n="graphList"]');
					if (listBox) {
						const { rows: laneRows, maxLanes } = computeCommitLanes(buildGraphRows());
						listBox.innerHTML = renderGraphRowsHtml(laneRows, maxLanes, "没有匹配的提交或改动记录。");
					}
				}
			});
			lastGateSig = JSON.stringify(store.state?.gitWorkbench ?? null);
			refreshAll(initialId);
		},
		update(kind) {
			if (!root) return;
			if (kind === "all") {
				activeRepo = null;
				selectedTarget = null;
				selectedFile = null;
				lastGateSig = JSON.stringify(store.state?.gitWorkbench ?? null);
				refreshAll();
				return;
			}
			if (kind === "changes") {
				refreshAll();
				return;
			}
			if (kind === "state") {
				const sig = JSON.stringify(store.state?.gitWorkbench ?? null);
				if (sig !== lastGateSig) {
					lastGateSig = sig;
					refreshAll();
				}
			}
		},
	};
}
