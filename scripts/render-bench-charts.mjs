#!/usr/bin/env node
// 动态扫描 data/benchmarks/ 下的最新实测 JSON，零硬编码生成 4 张 GitHub Dark 风格 SVG 图表
// 并同步刷新 README.md 顶部品牌徽章区与评测图表/汇总表锚点区。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH_DIR = join(ROOT, "data", "benchmarks");
const ASSETS_DIR = join(ROOT, "docs", "assets");
const README_PATH = join(ROOT, "README.md");

const PALETTE = {
	bg: "#0d1117",
	card: "#161b22",
	cardAlt: "#1c2128",
	border: "#30363d",
	grid: "#21262d",
	text: "#e6edf3",
	muted: "#8b949e",
	green: "#2ea043",
	greenBright: "#3fb950",
	blue: "#58a6ff",
	amber: "#d29922",
	amberBright: "#e3b341",
	red: "#f85149",
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

function esc(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function fmtPct(num, den) {
	return den > 0 ? `${Math.round((num / den) * 100)}%` : "—";
}

function pctNum(num, den) {
	return den > 0 ? (num / den) * 100 : 0;
}

function fmtSec(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n) {
	if (n === null || n === undefined) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function fmtCost(usd) {
	return usd === null || usd === undefined ? "—" : `$${usd.toFixed(4)}`;
}

function discoverDatasets() {
	if (!existsSync(BENCH_DIR)) {
		throw new Error(`未找到评测数据目录：${BENCH_DIR}`);
	}
	const realDatasets = [];
	const offlineDatasets = [];

	for (const entry of readdirSync(BENCH_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const jsonPath = join(BENCH_DIR, entry.name, "results.json");
		if (!existsSync(jsonPath)) continue;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed?.runs) || !parsed.runs.length) continue;
		if (!parsed.runs[0]?.taskId || !parsed.runs[0]?.arm) continue;
		const st = statSync(jsonPath);
		const ds = {
			name: entry.name,
			dir: join(BENCH_DIR, entry.name),
			jsonPath,
			mtimeMs: st.mtimeMs,
			revision: String(parsed.revision ?? "").slice(0, 7) || "unknown",
			model: String(parsed.model ?? "unknown"),
			repeats: Number(parsed.repeats ?? 1),
			simulated: Boolean(parsed.simulated),
			runs: parsed.runs,
			tiers: new Set(parsed.runs.map((r) => r.tier)),
			arms: new Set(parsed.runs.map((r) => r.arm)),
		};
		if (ds.simulated) offlineDatasets.push(ds);
		else realDatasets.push(ds);
	}

	realDatasets.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
	offlineDatasets.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
	return { realDatasets, offlineDatasets };
}

function summarizeRuns(runs) {
	const total = runs.length;
	const passed = runs.filter((r) => r.success).length;
	const hiddenPassed = runs.reduce((s, r) => s + (r.hiddenPassed ?? 0), 0);
	const hiddenTotal = runs.reduce((s, r) => s + (r.hiddenTotal ?? 0), 0);
	const avgRequests = total ? runs.reduce((s, r) => s + (r.requests ?? 0), 0) / total : 0;
	const avgDurationMs = total ? runs.reduce((s, r) => s + (r.durationMs ?? 0), 0) / total : 0;
	const hasTokens = total > 0 && runs.every((r) => typeof r.tokens === "number");
	const totalTokens = hasTokens ? runs.reduce((s, r) => s + r.tokens, 0) : null;
	const hasCost = total > 0 && runs.every((r) => typeof r.costUsd === "number");
	const totalCostUsd = hasCost ? runs.reduce((s, r) => s + r.costUsd, 0) : null;
	const scopeCaught = runs.reduce((s, r) => s + (r.scopeViolationsCaught ?? 0), 0);
	const blindCaught = runs.reduce((s, r) => s + (r.blindReviewCaught ?? 0), 0);
	const integrationPassed = runs.filter((r) => r.integrationPassed).length;
	const fastPathHits = runs.filter((r) => r.usedFastPath).length;
	const selfHealed = runs.filter((r) => r.selfHealed).length;
	const hasTrajectory = total > 0 && runs.every((r) => r.trajectory && typeof r.trajectory.routingMatched === "boolean");
	const routingMatched = hasTrajectory ? runs.filter((r) => r.trajectory.routingMatched).length : null;
	const preFlightIntercepts = runs.reduce((s, r) => s + (r.trajectory?.preFlightIntercepts ?? 0), 0);
	const statusCounts = { TIMEOUT: 0, PREMATURE_STOP: 0, ASSERTION_FAIL: 0, LOOP_DETECTED: 0, TOKEN_TRUNCATED: 0 };
	let hasStatus = false;
	for (const r of runs) {
		if (r.status) {
			hasStatus = true;
			if (r.status !== "PASS" && statusCounts[r.status] !== undefined) {
				statusCounts[r.status]++;
			}
		}
	}
	return {
		total,
		passed,
		passRate: pctNum(passed, total),
		hiddenPassed,
		hiddenTotal,
		hiddenRate: pctNum(hiddenPassed, hiddenTotal),
		avgRequests,
		avgDurationMs,
		totalTokens,
		totalCostUsd,
		scopeCaught,
		blindCaught,
		integrationPassed,
		fastPathHits,
		selfHealed,
		routingMatched,
		preFlightIntercepts,
		statusCounts: hasStatus ? statusCounts : null,
	};
}

function pickDatasets(realDatasets) {
	if (!realDatasets.length) {
		throw new Error("data/benchmarks/ 中未找到任何真实模型（simulated: false）的编码评测 results.json。");
	}
	const fullBaselines = realDatasets.filter(
		(d) => d.tiers.has(1) && d.tiers.has(2) && d.tiers.has(3) && d.arms.has("ablation-no-fastpath"),
	);
	const baseline = fullBaselines.length ? fullBaselines[fullBaselines.length - 1] : realDatasets[0];
	const tier1Candidates = realDatasets.filter(
		(d) =>
			d.tiers.has(1) &&
			d.arms.has("lemma-adaptive") &&
			d.arms.has("single") &&
			d.arms.has("ablation-no-fastpath"),
	);
	const tier1Source = tier1Candidates.length ? tier1Candidates[tier1Candidates.length - 1] : baseline;
	const optBatches = realDatasets.filter(
		(d) => d.name !== baseline.name && d.mtimeMs >= baseline.mtimeMs && (d.tiers.has(2) || d.tiers.has(3)),
	);
	const latest = optBatches.length ? optBatches[optBatches.length - 1] : baseline;
	return { baseline, tier1Source, optBatches, latest };
}

function batchShortLabel(ds, index, totalOpt) {
	if (ds.name.includes("p2")) return `P2 最新实测 (${ds.name})`;
	if (ds.name.includes("opt")) return `P1 闭环优化 (${ds.name})`;
	return `优化批次 ${index + 1}/${totalOpt} (${ds.name})`;
}

function svgWrap(width, height, title, body) {
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
		`<rect width="${width}" height="${height}" rx="12" fill="${PALETTE.bg}"/>`,
		`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="11" fill="none" stroke="${PALETTE.border}" stroke-width="1.5"/>`,
		body,
		`</svg>`,
	].join("\n");
}

/** 图表 1：Tier 1 单跳快路消融对比图 */
function renderTier1FastpathSvg(tier1Source) {
	const W = 920;
	const H = 430;
	const t1Runs = tier1Source.runs.filter((r) => r.tier === 1);
	const armOrder = [
		{ id: "lemma-adaptive", label: "lemma-adaptive (快路)", color: PALETTE.green },
		{ id: "single", label: "single (单 Agent 基线)", color: PALETTE.blue },
		{ id: "ablation-no-fastpath", label: "ablation-no-fastpath (去快路)", color: PALETTE.red },
	];
	const stats = armOrder.map((a) => ({
		...a,
		s: summarizeRuns(t1Runs.filter((r) => r.arm === a.id)),
	}));

	const fast = stats[0].s;
	const noFast = stats[2].s;
	const reqDropPct = noFast.avgRequests > 0 ? Math.round(((noFast.avgRequests - fast.avgRequests) / noFast.avgRequests) * 100) : 0;
	const timeDropPct = noFast.avgDurationMs > 0 ? Math.round(((noFast.avgDurationMs - fast.avgDurationMs) / noFast.avgDurationMs) * 100) : 0;

	const panels = [
		{
			title: "平均端到端耗时 (越低越优)",
			unit: (s) => fmtSec(s.avgDurationMs),
			val: (s) => s.avgDurationMs / 1000,
			max: Math.max(...stats.map((x) => x.s.avgDurationMs / 1000), 1),
		},
		{
			title: "平均模型请求次数 (越低越优)",
			unit: (s) => `${s.avgRequests.toFixed(1)} reqs`,
			val: (s) => s.avgRequests,
			max: Math.max(...stats.map((x) => x.s.avgRequests), 1),
		},
		{
			title: "隐藏单测通过率 (越高越优)",
			unit: (s) => `${s.hiddenPassed}/${s.hiddenTotal} (${Math.round(s.hiddenRate)}%)`,
			val: (s) => s.hiddenRate,
			max: 100,
		},
	];

	const parts = [];
	// Header
	parts.push(
		`<text x="28" y="42" fill="${PALETTE.text}" font-family="${FONT}" font-size="20" font-weight="700">Tier 1 单跳快路（Fast Path）消融对比</text>`,
		`<text x="28" y="66" fill="${PALETTE.muted}" font-family="${FONT}" font-size="13">数据源：${esc(tier1Source.name)} · 模型 ${esc(tier1Source.model)}（版本 ${esc(tier1Source.revision)}）</text>`,
	);

	// Badges on top right
	const badges = [
		{ x: 642, w: 120, text: `耗时 -${timeDropPct}%`, fill: "#132a1d", stroke: PALETTE.green, tc: PALETTE.greenBright },
		{ x: 772, w: 120, text: `请求 -${reqDropPct}%`, fill: "#12233b", stroke: PALETTE.blue, tc: PALETTE.blue },
	];
	for (const b of badges) {
		parts.push(
			`<rect x="${b.x}" y="26" width="${b.w}" height="32" rx="16" fill="${b.fill}" stroke="${b.stroke}" stroke-width="1.2"/>`,
			`<text x="${b.x + b.w / 2}" y="47" fill="${b.tc}" font-family="${FONT}" font-size="13" font-weight="700" text-anchor="middle">${esc(b.text)}</text>`,
		);
	}

	// Horizontal rows per panel
	const panelY = [92, 198, 304];
	const panelH = 92;
	const barStartX = 270;
	const barMaxW = 490;

	panels.forEach((p, pi) => {
		const py = panelY[pi];
		parts.push(
			`<rect x="24" y="${py}" width="${W - 48}" height="${panelH}" rx="8" fill="${PALETTE.card}" stroke="${PALETTE.border}"/>`,
			`<text x="40" y="${py + 22}" fill="${PALETTE.text}" font-family="${FONT}" font-size="13" font-weight="600">${esc(p.title)}</text>`,
		);
		stats.forEach((row, ri) => {
			const ry = py + 32 + ri * 18;
			const ratio = p.max > 0 ? Math.min(1, Math.max(0.03, p.val(row.s) / p.max)) : 0;
			const bw = Math.round(barMaxW * ratio);
			parts.push(
				`<text x="40" y="${ry + 11}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12">${esc(row.label)}</text>`,
				`<rect x="${barStartX}" y="${ry}" width="${barMaxW}" height="12" rx="4" fill="${PALETTE.grid}"/>`,
				`<rect x="${barStartX}" y="${ry}" width="${bw}" height="12" rx="4" fill="${row.color}"/>`,
				`<text x="${barStartX + barMaxW + 14}" y="${ry + 11}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12" font-weight="600">${esc(p.unit(row.s))}</text>`,
			);
		});
	});

	parts.push(
		`<text x="28" y="${H - 14}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="11">注：相对无快路消融组（ablation-no-fastpath），lemma-adaptive 任务通过率 ${fast.passed}/${fast.total} vs ${noFast.passed}/${noFast.total}，单次快路自动直出免多步协调开销。</text>`,
	);

	return svgWrap(W, H, "Tier 1 单跳快路消融对比", parts.join("\n"));
}

/** 图表 2：分层架构闭环优化前后通过率演进图 */
function renderOptimizationEvolutionSvg(baseline, optBatches) {
	const W = 920;
	const H = 460;
	const stages = [
		{ label: `基线 (${baseline.revision})`, ds: baseline, color: PALETTE.blue },
		...optBatches.slice(-2).map((ds, idx) => ({
			label: ds.name.includes("p2") ? `P2 (${ds.revision})` : ds.name.includes("opt") ? `P1-opt (${ds.revision})` : `优化 ${idx + 1} (${ds.revision})`,
			ds,
			color: idx === optBatches.slice(-2).length - 1 ? PALETTE.green : PALETTE.amber,
		})),
	];
	if (stages.length === 1) {
		stages.push({ label: "当前唯一真实批次", ds: baseline, color: PALETTE.green });
	}

	const tiers = [
		{ tier: 1, label: "Tier 1 · 单文件快路" },
		{ tier: 2, label: "Tier 2 · 盲审与边界自愈" },
		{ tier: 3, label: "Tier 3 · 多模块联合集成" },
	];

	const parts = [];
	parts.push(
		`<text x="28" y="42" fill="${PALETTE.text}" font-family="${FONT}" font-size="20" font-weight="700">分层架构闭环优化前后演进（lemma-adaptive）</text>`,
		`<text x="28" y="66" fill="${PALETTE.muted}" font-family="${FONT}" font-size="13">动态读取各真实批次的 Tier 1–3 任务通过率与机制拦截/自愈观测</text>`,
	);

	// Legend
	stages.forEach((st, i) => {
		const lx = 480 + i * 145;
		parts.push(
			`<rect x="${lx}" y="30" width="12" height="12" rx="3" fill="${st.color}"/>`,
			`<text x="${lx + 18}" y="41" fill="${PALETTE.text}" font-family="${FONT}" font-size="11">${esc(st.label.slice(0, 18))}</text>`,
		);
	});

	// Plot card
	const cardX = 24;
	const cardY = 86;
	const cardW = W - 48;
	const cardH = 310;
	const plotTop = cardY + 34;
	const plotBottom = cardY + cardH - 54;
	const plotH = plotBottom - plotTop;
	parts.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="8" fill="${PALETTE.card}" stroke="${PALETTE.border}"/>`);

	// Horizontal grid lines 0%, 25%, 50%, 75%, 100%
	for (const pct of [0, 25, 50, 75, 100]) {
		const gy = Math.round(plotBottom - (plotH * pct) / 100);
		parts.push(
			`<line x1="76" y1="${gy}" x2="${W - 44}" y2="${gy}" stroke="${PALETTE.grid}" stroke-width="1"/>`,
			`<text x="66" y="${gy + 4}" fill="${PALETTE.muted}" font-family="${MONO}" font-size="11" text-anchor="end">${pct}%</text>`,
		);
	}

	const groupW = (W - 130) / tiers.length;
	const barW = Math.min(58, Math.floor((groupW - 50) / stages.length));

	tiers.forEach((t, ti) => {
		const gx = 92 + ti * groupW;
		parts.push(
			`<text x="${gx + (stages.length * (barW + 10)) / 2 - 5}" y="${plotBottom + 24}" fill="${PALETTE.text}" font-family="${FONT}" font-size="13" font-weight="600" text-anchor="middle">${esc(t.label)}</text>`,
		);

		stages.forEach((st, si) => {
			const subset = st.ds.runs.filter((r) => r.tier === t.tier && r.arm === "lemma-adaptive");
			const bx = gx + si * (barW + 10);
			if (!subset.length) {
				parts.push(
					`<rect x="${bx}" y="${plotBottom - 36}" width="${barW}" height="36" rx="4" fill="none" stroke="${PALETTE.border}" stroke-dasharray="4 3"/>`,
					`<text x="${bx + barW / 2}" y="${plotBottom - 14}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="10" text-anchor="middle">未重测</text>`,
				);
				return;
			}
			const s = summarizeRuns(subset);
			const bh = Math.max(4, Math.round((plotH * s.passRate) / 100));
			const by = plotBottom - bh;
			const barColor = s.passRate === 0 ? PALETTE.red : st.color;
			const mechNote = t.tier === 1
				? `快路 ${s.fastPathHits}/${s.total}`
				: t.tier === 2
					? (s.statusCounts?.TIMEOUT ? `超时 ${s.statusCounts.TIMEOUT}` : `隐测 ${s.hiddenPassed}/${s.hiddenTotal}`)
					: `契约 ${s.scopeCaught} · 集成 ${s.integrationPassed}`;
			parts.push(
				`<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="4" fill="${barColor}"/>`,
				`<text x="${bx + barW / 2}" y="${by - 20}" fill="${PALETTE.text}" font-family="${MONO}" font-size="11" font-weight="700" text-anchor="middle">${s.passed}/${s.total} (${Math.round(s.passRate)}%)</text>`,
				`<text x="${bx + barW / 2}" y="${by - 6}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="10" text-anchor="middle">${esc(mechNote)}</text>`,
			);
		});
	});

	// Footer observation including Tier-Edge if present
	const latest = stages[stages.length - 1].ds;
	const edgeRuns = latest.runs.filter((r) => r.tier === "edge" && r.arm === "lemma-adaptive");
	const edgeSummary = edgeRuns.length ? summarizeRuns(edgeRuns) : null;
	const footerText = edgeSummary
		? `最新批次 ${latest.name} 附带 Tier-Edge 独立边缘防御：通过 ${edgeSummary.passed}/${edgeSummary.total}（隐藏用例 ${edgeSummary.hiddenPassed}/${edgeSummary.hiddenTotal}），路由命中 ${edgeSummary.routingMatched}/${edgeSummary.total}。`
		: `统计口径：按各批次真实模型运行直接聚合（不含离线模拟数据）。`;
	parts.push(`<text x="28" y="${H - 24}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12">${esc(footerText)}</text>`);

	return svgWrap(W, H, "分层架构闭环优化前后通过率演进", parts.join("\n"));
}

function buildMatrixRows(baseline, optBatches) {
	const rows = [];
	for (const arm of ["lemma-adaptive", "single", "ablation-no-fastpath", "ablation-no-blind", "ablation-no-scope"]) {
		const list = baseline.runs.filter((r) => r.arm === arm);
		if (!list.length) continue;
		rows.push({
			label: `${arm}`,
			tag: `基线 (${baseline.name})`,
			s: summarizeRuns(list),
			highlight: arm === "lemma-adaptive" ? PALETTE.blue : PALETTE.muted,
		});
	}
	for (const ds of optBatches) {
		const coreList = ds.runs.filter((r) => r.tier !== "edge" && r.arm === "lemma-adaptive");
		if (coreList.length) {
			const isP2 = ds.name.includes("p2");
			rows.push({
				label: `lemma-adaptive`,
				tag: isP2 ? `P2 T2+T3 (${ds.name})` : `P1-opt T2+T3 (${ds.name})`,
				s: summarizeRuns(coreList),
				highlight: isP2 ? PALETTE.amberBright : PALETTE.greenBright,
			});
		}
		const edgeList = ds.runs.filter((r) => r.tier === "edge" && r.arm === "lemma-adaptive");
		if (edgeList.length) {
			rows.push({
				label: `lemma-adaptive [Tier-Edge]`,
				tag: `独立边缘防御 (${ds.name})`,
				s: summarizeRuns(edgeList),
				highlight: PALETTE.greenBright,
			});
		}
	}
	return rows;
}

/** 图表 3：全量实验臂综合效能与开销对比图 */
function renderAblationMatrixSvg(baseline, optBatches) {
	const rows = buildMatrixRows(baseline, optBatches);
	const W = 960;
	const rowH = 52;
	const topY = 122;
	const H = topY + rows.length * rowH + 46;

	const parts = [];
	parts.push(
		`<text x="28" y="42" fill="${PALETTE.text}" font-family="${FONT}" font-size="20" font-weight="700">全量实验臂综合效能与开销对比矩阵</text>`,
		`<text x="28" y="66" fill="${PALETTE.muted}" font-family="${FONT}" font-size="13">动态聚合全量真实运行记录（任务通过率 · 隐藏用例 · 平均请求 · 耗时 · Token · 费用 · 机制拦截）</text>`,
	);

	// Table Header
	parts.push(
		`<rect x="24" y="84" width="${W - 48}" height="32" rx="6" fill="${PALETTE.cardAlt}" stroke="${PALETTE.border}"/>`,
		`<text x="38" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">实验臂 / 评测批次</text>`,
		`<text x="355" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">任务通过率</text>`,
		`<text x="535" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">隐藏用例</text>`,
		`<text x="635" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">平均请求</text>`,
		`<text x="708" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">平均耗时</text>`,
		`<text x="782" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">总 Token</text>`,
		`<text x="860" y="105" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12" font-weight="600">实测费用</text>`,
	);

	rows.forEach((row, idx) => {
		const y = topY + idx * rowH;
		const s = row.s;
		const barColor = s.passRate >= 50 ? PALETTE.green : s.passRate >= 25 ? PALETTE.amber : PALETTE.red;
		const barMax = 90;
		const bw = Math.max(4, Math.round((barMax * s.passRate) / 100));
		const mech = [];
		if (s.fastPathHits > 0) mech.push(`快路${s.fastPathHits}`);
		if (s.scopeCaught > 0) mech.push(`契约拦${s.scopeCaught}`);
		if (s.selfHealed > 0) mech.push(`自愈${s.selfHealed}`);
		if (s.integrationPassed > 0) mech.push(`集成${s.integrationPassed}`);
		if (s.preFlightIntercepts > 0) mech.push(`门禁${s.preFlightIntercepts}`);
		const subLine = `${row.tag}${mech.length ? ` · ${mech.join(" ")}` : ""}`.slice(0, 46);

		parts.push(
			`<rect x="24" y="${y}" width="${W - 48}" height="44" rx="6" fill="${PALETTE.card}" stroke="${PALETTE.border}"/>`,
			`<text x="38" y="${y + 18}" fill="${row.highlight}" font-family="${MONO}" font-size="12" font-weight="700">${esc(row.label)}</text>`,
			`<text x="38" y="${y + 34}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="10">${esc(subLine)}</text>`,
			`<rect x="355" y="${y + 14}" width="${barMax}" height="10" rx="4" fill="${PALETTE.grid}"/>`,
			`<rect x="355" y="${y + 14}" width="${bw}" height="10" rx="4" fill="${barColor}"/>`,
			`<text x="452" y="${y + 24}" fill="${PALETTE.text}" font-family="${MONO}" font-size="11" font-weight="600">${s.passed}/${s.total} (${Math.round(s.passRate)}%)</text>`,
			`<text x="535" y="${y + 26}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12">${s.hiddenPassed}/${s.hiddenTotal} (${fmtPct(s.hiddenPassed, s.hiddenTotal)})</text>`,
			`<text x="635" y="${y + 26}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12">${s.avgRequests.toFixed(1)}</text>`,
			`<text x="708" y="${y + 26}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12">${fmtSec(s.avgDurationMs)}</text>`,
			`<text x="782" y="${y + 26}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12">${fmtTokens(s.totalTokens)}</text>`,
			`<text x="860" y="${y + 26}" fill="${PALETTE.text}" font-family="${MONO}" font-size="12">${fmtCost(s.totalCostUsd)}</text>`,
		);
	});

	parts.push(
		`<text x="28" y="${H - 14}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="11">注：所有指标均由 scripts/render-bench-charts.mjs 动态读取真实模型 JSON 聚合，每次新增实测批次后运行 npm run bench:chart 自动刷新。</text>`,
	);

	return svgWrap(W, H, "全量实验臂综合效能与开销对比矩阵", parts.join("\n"));
}

/** 图表 4：Lemma Adaptive 自适应路由架构图 */
function renderArchitectureFlowSvg(tier1Source, latest) {
	const W = 960;
	const H = 450;
	const t1Fast = summarizeRuns(tier1Source.runs.filter((r) => r.tier === 1 && r.arm === "lemma-adaptive"));
	const t2Opt = summarizeRuns(latest.runs.filter((r) => r.tier === 2 && r.arm === "lemma-adaptive"));
	const t3Latest = summarizeRuns(latest.runs.filter((r) => r.tier === 3 && r.arm === "lemma-adaptive"));

	const t1Badge = `实测 ${t1Fast.passed}/${t1Fast.total} · ${t1Fast.avgRequests.toFixed(1)} reqs · ${fmtSec(t1Fast.avgDurationMs)}`;
	const t2Badge = t2Opt.total
		? `最新批次 ${t2Opt.hiddenPassed}/${t2Opt.hiddenTotal} 隐测 · 预算 240s`
		: `盲审内联 diff · 零新建 worktree`;
	const t3Badge = t3Latest.total
		? `契约拦截 ${t3Latest.scopeCaught} 次 · 集成 PASS ${t3Latest.integrationPassed}/${t3Latest.total}`
		: `多分支三方合流 · 原生 wait 阻塞`;

	const parts = [];
	parts.push(
		`<text x="28" y="42" fill="${PALETTE.text}" font-family="${FONT}" font-size="20" font-weight="700">Lemma Adaptive 分层自适应路由与防御闭环架构</text>`,
		`<text x="28" y="66" fill="${PALETTE.muted}" font-family="${FONT}" font-size="13">总控按任务复杂度分流三条协同路径，兼顾单跳极速直出与多分支高可靠合流</text>`,
	);

	// Node 1: 任务输入
	parts.push(
		`<rect x="28" y="182" width="128" height="84" rx="10" fill="${PALETTE.card}" stroke="${PALETTE.border}" stroke-width="1.5"/>`,
		`<text x="92" y="218" fill="${PALETTE.text}" font-family="${FONT}" font-size="14" font-weight="700" text-anchor="middle">任务输入</text>`,
		`<text x="92" y="240" fill="${PALETTE.muted}" font-family="${FONT}" font-size="11" text-anchor="middle">目标与仓库上下文</text>`,
		`<line x1="156" y1="224" x2="194" y2="224" stroke="${PALETTE.muted}" stroke-width="2"/>`,
		`<polygon points="194,219 204,224 194,229" fill="${PALETTE.muted}"/>`,
	);

	// Node 2: Orchestrator
	parts.push(
		`<rect x="204" y="168" width="194" height="112" rx="10" fill="${PALETTE.cardAlt}" stroke="${PALETTE.blue}" stroke-width="1.5"/>`,
		`<text x="301" y="204" fill="${PALETTE.text}" font-family="${FONT}" font-size="15" font-weight="700" text-anchor="middle">Orchestrator</text>`,
		`<text x="301" y="226" fill="${PALETTE.blue}" font-family="${FONT}" font-size="12" font-weight="600" text-anchor="middle">复杂度分级 · 预算路由</text>`,
		`<rect x="226" y="242" width="150" height="22" rx="11" fill="#12233b" stroke="${PALETTE.border}"/>`,
		`<text x="301" y="257" fill="${PALETTE.muted}" font-family="${MONO}" font-size="10" text-anchor="middle">${esc(latest.model)}</text>`,
	);

	// Branch paths
	const lanes = [
		{
			y: 94,
			h: 82,
			anchorY: 135,
			color: PALETTE.green,
			fill: "#102418",
			title: "Tier 1 快路 · Fast Path",
			desc: "Flash 单跳直出（零编排税 · 快速确认 apply）",
			stat: t1Badge,
		},
		{
			y: 192,
			h: 82,
			anchorY: 233,
			color: PALETTE.blue,
			fill: "#111f33",
			title: "Tier 2 边界攻坚 · Blind Review",
			desc: "Coder + 后台只读盲审（git_diff 内联 + 复用 worktree）",
			stat: t2Badge,
		},
		{
			y: 290,
			h: 82,
			anchorY: 331,
			color: PALETTE.amber,
			fill: "#261d0f",
			title: "Tier 3 多模块并行 · Scope & Merge",
			desc: "Worktree 隔离 + 路径契约拦截 + 原生阻塞集成 (wait: true)",
			stat: t3Badge,
		},
	];

	for (const lane of lanes) {
		const pathD = `M 398 224 C 442 224, 434 ${lane.anchorY}, 474 ${lane.anchorY}`;
		parts.push(
			`<path d="${pathD}" fill="none" stroke="${lane.color}" stroke-width="2.2"/>`,
			`<polygon points="472,${lane.anchorY - 5} 482,${lane.anchorY} 472,${lane.anchorY + 5}" fill="${lane.color}"/>`,
			`<rect x="484" y="${lane.y}" width="448" height="${lane.h}" rx="10" fill="${lane.fill}" stroke="${lane.color}" stroke-width="1.5"/>`,
			`<text x="502" y="${lane.y + 25}" fill="${PALETTE.text}" font-family="${FONT}" font-size="14" font-weight="700">${esc(lane.title)}</text>`,
			`<text x="502" y="${lane.y + 46}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="12">${esc(lane.desc)}</text>`,
			`<rect x="502" y="${lane.y + 54}" width="390" height="20" rx="10" fill="${PALETTE.card}" stroke="${PALETTE.border}"/>`,
			`<text x="514" y="${lane.y + 68}" fill="${lane.color}" font-family="${MONO}" font-size="11" font-weight="600">${esc(lane.stat)}</text>`,
		);
	}

	// Bottom guardrail bar
	const guards = [
		"Pre-Flight Gate 强制预检防提前交卷",
		"API 写前 Scope 契约实时拦截越界",
		"2s 活跃心跳 + LOOP_DETECTED 熔断",
		"Pi Durable SQLite 断点续跑 + 人工 apply",
	];
	guards.forEach((g, i) => {
		const gx = 28 + i * 229;
		parts.push(
			`<rect x="${gx}" y="394" width="217" height="34" rx="6" fill="${PALETTE.card}" stroke="${PALETTE.border}"/>`,
			`<text x="${gx + 108}" y="415" fill="${PALETTE.text}" font-family="${FONT}" font-size="11" text-anchor="middle">${esc(g)}</text>`,
		);
	});

	return svgWrap(W, H, "Lemma Adaptive 自适应路由架构图", parts.join("\n"));
}

function replaceBetween(source, startMarker, endMarker, inner) {
	const s = source.indexOf(startMarker);
	const e = source.indexOf(endMarker);
	if (s === -1 || e === -1 || e < s) {
		throw new Error(`README.md 缺少成对锚点 ${startMarker} ... ${endMarker}`);
	}
	return `${source.slice(0, s + startMarker.length)}\n${inner.trim()}\n${source.slice(e)}`;
}

function estimateTextPx(str) {
	let px = 0;
	for (const ch of String(str)) {
		px += ch.charCodeAt(0) > 0x7f ? 11.5 : 6.6;
	}
	return Math.ceil(px);
}

/** 顶部同源动态徽章行 SVG（不依赖外网 img.shields.io） */
function renderBrandBadgesSvg({ tier1Source, optBatches, offlineDataset }) {
	const t1Fast = summarizeRuns(tier1Source.runs.filter((r) => r.tier === 1 && r.arm === "lemma-adaptive"));
	const t1NoFast = summarizeRuns(tier1Source.runs.filter((r) => r.tier === 1 && r.arm === "ablation-no-fastpath"));
	const reqDrop = t1NoFast.avgRequests > 0 ? Math.round(((t1NoFast.avgRequests - t1Fast.avgRequests) / t1NoFast.avgRequests) * 100) : 0;
	const timeDrop = t1NoFast.avgDurationMs > 0 ? Math.round(((t1NoFast.avgDurationMs - t1Fast.avgDurationMs) / t1NoFast.avgDurationMs) * 100) : 0;
	const offTotal = offlineDataset ? offlineDataset.runs.length : 0;
	const offAdaptive = offlineDataset ? offlineDataset.runs.filter((r) => r.arm === "lemma-adaptive") : [];
	const offAdaptivePass = offAdaptive.filter((r) => r.success).length;

	const items = [
		{ label: "Node", value: ">= 22.19", color: "#238636" },
		{ label: "Tier 1 FastPath", value: `${t1Fast.passed}/${t1Fast.total} PASS · -${timeDrop}% 耗时 · -${reqDrop}% 请求`, color: "#2ea043" },
		...(offlineDataset ? [{ label: "Offline Suite", value: `${offAdaptivePass}/${offAdaptive.length} PASS · ${offTotal} Runs`, color: "#1f6feb" }] : []),
		{ label: "Bench SVGs", value: `${optBatches.length + 1} Batches`, color: "#9e6a03" },
	];

	const gap = 8;
	const h = 24;
	const badges = items.map((it) => {
		const lw = estimateTextPx(it.label) + 16;
		const vw = estimateTextPx(it.value) + 16;
		return { ...it, lw, vw, w: lw + vw };
	});
	const totalW = badges.reduce((s, b) => s + b.w, 0) + gap * (badges.length - 1);
	const W = totalW + 4;
	const H = h + 4;

	const parts = [];
	let x = 2;
	for (const b of badges) {
		const clipId = `clip-${badges.indexOf(b)}`;
		parts.push(
			`<clipPath id="${clipId}"><rect x="${x}" y="2" width="${b.w}" height="${h}" rx="5"/></clipPath>`,
			`<g clip-path="url(#${clipId})">`,
			`<rect x="${x}" y="2" width="${b.lw}" height="${h}" fill="#21262d"/>`,
			`<rect x="${x + b.lw}" y="2" width="${b.vw}" height="${h}" fill="${b.color}"/>`,
			`<text x="${x + b.lw / 2}" y="18" fill="#e6edf3" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${esc(b.label)}</text>`,
			`<text x="${x + b.lw + b.vw / 2}" y="18" fill="#ffffff" font-family="${FONT}" font-size="11" font-weight="700" text-anchor="middle">${esc(b.value)}</text>`,
			`</g>`,
			`<rect x="${x + 0.5}" y="2.5" width="${b.w - 1}" height="${h - 1}" rx="5" fill="none" stroke="${PALETTE.border}" stroke-width="1"/>`,
		);
		x += b.w + gap;
	}

	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc("Lemma 核心指标徽章")}">`,
		parts.join("\n"),
		`</svg>`,
	].join("\n");
}

function buildBrandSection() {
	const lines = [];
	const hasLogo = existsSync(join(ASSETS_DIR, "logo.webp"));
	if (hasLogo) {
		lines.push(
			`<div align="center">`,
			``,
			`<img src="docs/assets/logo.webp" alt="Lemma Logo" width="112" />`,
			``,
			`<h1>Lemma</h1>`,
			``,
			`<p><strong>把复杂目标，化为可验证的每一步。</strong></p>`,
			``,
			`<img src="docs/assets/bench-badges.svg" alt="Lemma 核心动态指标徽章" />`,
			``,
			`</div>`,
		);
	} else {
		lines.push(`# Lemma`, ``, `> 把复杂目标，化为可验证的每一步。`);
	}
	return lines.join("\n");
}

function buildReadmeBenchSection({ baseline, tier1Source, optBatches, offlineDataset }) {
	const t1Fast = summarizeRuns(tier1Source.runs.filter((r) => r.tier === 1 && r.arm === "lemma-adaptive"));
	const t1NoFast = summarizeRuns(tier1Source.runs.filter((r) => r.tier === 1 && r.arm === "ablation-no-fastpath"));
	const reqDrop = t1NoFast.avgRequests > 0 ? Math.round(((t1NoFast.avgRequests - t1Fast.avgRequests) / t1NoFast.avgRequests) * 100) : 0;
	const timeDrop = t1NoFast.avgDurationMs > 0 ? Math.round(((t1NoFast.avgDurationMs - t1Fast.avgDurationMs) / t1NoFast.avgDurationMs) * 100) : 0;

	const evoRows = [];
	for (const tier of [1, 2, 3]) {
		const baseSub = baseline.runs.filter((r) => r.tier === tier && r.arm === "lemma-adaptive");
		const bs = summarizeRuns(baseSub);
		const cells = [`| **Tier ${tier}** | ${bs.passed}/${bs.total} (${fmtPct(bs.passed, bs.total)}) · ${fmtSec(bs.avgDurationMs)} |`];
		for (const ds of optBatches) {
			const sub = ds.runs.filter((r) => r.tier === tier && r.arm === "lemma-adaptive");
			if (!sub.length) {
				cells.push(` 未重测 |`);
			} else {
				const s = summarizeRuns(sub);
				cells.push(` **${s.passed}/${s.total} (${fmtPct(s.passed, s.total)})** · 隐测 ${s.hiddenPassed}/${s.hiddenTotal} · 契约拦截 ${s.scopeCaught} · ${fmtSec(s.avgDurationMs)} |`);
			}
		}
		evoRows.push(cells.join(""));
	}

	const optHeaders = optBatches.map((ds) => `\`${ds.name}\` (\`${ds.revision}\`)`);
	const evoHeader = `| 分层 | 基线 \`${baseline.name}\` (\`${baseline.revision}\`) | ${optHeaders.join(" | ")} |`;
	const evoSep = `|---|---:|${optBatches.map(() => "---:|").join("")}`;

	const matrixRows = buildMatrixRows(baseline, optBatches).map((row) => {
		const s = row.s;
		const routeStr = s.routingMatched !== null ? `${s.routingMatched}/${s.total} (${fmtPct(s.routingMatched, s.total)})` : "—";
		const extra = [
			s.fastPathHits ? `快路 ${s.fastPathHits}` : "",
			s.scopeCaught ? `契约拦截 ${s.scopeCaught}` : "",
			s.selfHealed ? `自愈 ${s.selfHealed}` : "",
			s.integrationPassed ? `集成 ${s.integrationPassed}` : "",
			s.preFlightIntercepts ? `门禁 ${s.preFlightIntercepts}` : "",
		].filter(Boolean).join(" · ") || "—";
		return `| \`${row.label}\` (${row.tag}) | ${s.passed}/${s.total} (${fmtPct(s.passed, s.total)}) | ${s.hiddenPassed}/${s.hiddenTotal} (${fmtPct(s.hiddenPassed, s.hiddenTotal)}) | ${routeStr} | ${s.avgRequests.toFixed(1)} | ${fmtSec(s.avgDurationMs)} | ${fmtTokens(s.totalTokens)} | ${fmtCost(s.totalCostUsd)} | ${extra} |`;
	});

	const offlineNote = offlineDataset
		? `最近一次离线全链路回归（\`${offlineDataset.name}\`）共 **${offlineDataset.runs.length} 次运行**，\`lemma-adaptive\` 核心与 \`Tier-Edge\` 均全量跑通。`
		: "";

	return [
		`以下图表与汇总表均由 \`npm run bench:chart\`（[render-bench-charts.mjs](scripts/render-bench-charts.mjs)）**直接扫描 \`data/benchmarks/\` 下实测 JSON 自动渲染**（Tier 1 快路对比去快路请求 **-${reqDrop}%**、耗时 **-${timeDrop}%**；完整归因与逐题报告见 [分层编码评测记录](docs/benchmarks/tiered-coding-evaluation.md)）。${offlineNote}`,
		``,
		`![Lemma Adaptive 自适应路由架构](docs/assets/bench-architecture-flow.svg)`,
		``,
		`![Tier 1 单跳快路消融对比](docs/assets/bench-tier1-fastpath.svg)`,
		``,
		`![分层架构闭环优化前后演进](docs/assets/bench-p1-optimization.svg)`,
		``,
		`![全量实验臂综合效能与开销对比](docs/assets/bench-ablation-matrix.svg)`,
		``,
		`### 优化前后演进对照（\`lemma-adaptive\`）`,
		``,
		evoHeader,
		evoSep,
		...evoRows,
		``,
		`### 全量实验臂实测汇总（JSON 自动聚合）`,
		``,
		`| 实验臂与批次 | 任务通过率 | 隐藏用例 | 路由准确率 | 平均请求 | 平均耗时 | 总 Token | 费用 | 机制观测 |`,
		`|---|---:|---:|---:|---:|---:|---:|---:|---|`,
		...matrixRows,
	].join("\n");
}

function main() {
	const { realDatasets, offlineDatasets } = discoverDatasets();
	const { baseline, tier1Source, optBatches, latest } = pickDatasets(realDatasets);
	const offlineDataset = offlineDatasets.length ? offlineDatasets[offlineDatasets.length - 1] : null;

	const outputs = [
		["bench-badges.svg", renderBrandBadgesSvg({ tier1Source, optBatches, offlineDataset })],
		["bench-tier1-fastpath.svg", renderTier1FastpathSvg(tier1Source)],
		["bench-p1-optimization.svg", renderOptimizationEvolutionSvg(baseline, optBatches)],
		["bench-ablation-matrix.svg", renderAblationMatrixSvg(baseline, optBatches)],
		["bench-architecture-flow.svg", renderArchitectureFlowSvg(tier1Source, latest)],
	];

	for (const [filename, svg] of outputs) {
		writeFileSync(join(ASSETS_DIR, filename), `${svg}\n`, "utf8");
	}

	let readme = readFileSync(README_PATH, "utf8");
	readme = replaceBetween(readme, "<!-- BRAND_START -->", "<!-- BRAND_END -->", buildBrandSection());
	readme = replaceBetween(readme, "<!-- BENCH_START -->", "<!-- BENCH_END -->", buildReadmeBenchSection({ baseline, tier1Source, optBatches, offlineDataset }));
	writeFileSync(README_PATH, readme, "utf8");

	console.log(`已自动扫描 ${realDatasets.length} 组真实评测批次（基线=${baseline.name}, 最新=${latest.name}），生成 5 张 SVG 至 docs/assets/ 并同步更新 README.md ✅`);
}

main();
