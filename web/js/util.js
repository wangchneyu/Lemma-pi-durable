// 公共小工具：DOM、格式化、极简 Markdown、提示。
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const AGENT_LABEL = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const KINDS = ["claude", "codex", "gemini"];
export const SLOT_LABEL = { pending: "排队", running: "执行中", sleeping: "等待中", waiting: "等待中", done: "完成" };
export const STATUS_LABEL = { open: "无结果", running: "执行中", done: "完成", error: "失败", aborted: "已中止", interrupted: "被中断" };
export const FAILURE_LABEL = {
	model_error: "模型出错",
	no_model: "没有可用模型",
	aborted: "已中止",
	faulted: "内部错误",
	interrupted: "进程中断",
	restart_limit: "反复崩溃，已放弃",
	turn_limit: "达到轮数上限",
	nothing_to_answer: "没有需要回答的内容",
	orphaned: "任务定义缺失",
	reset: "上下文已重置",
};

export function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function el(tag, cls, html) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (html !== undefined) node.innerHTML = html;
	return node;
}
export function kindOf(toolName) {
	return String(toolName ?? "").replace(/^ask_/, "");
}
export function agentColor(kind) {
	return KINDS.includes(kind) ? `var(--${kind})` : "var(--muted)";
}

const pad = (n) => String(n).padStart(2, "0");
export function clock(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function stamp(ts) {
	if (!ts) return "—";
	const d = new Date(ts);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function duration(ms) {
	if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}
export function ago(ts) {
	if (!ts) return "—";
	const s = (Date.now() - ts) / 1000;
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
	return `${Math.floor(s / 86400)} 天前`;
}
export function money(v) {
	if (v === undefined || v === null) return "—";
	if (v === 0) return "$0";
	return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
export function num(v) {
	return Number(v ?? 0).toLocaleString();
}
export function short(text, max) {
	const t = String(text ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ---------- 提示 / 复制 / 请求 ----------
let toastTimer;
export function toast(text) {
	const t = $("#toast");
	t.textContent = text;
	t.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
export async function copy(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast("已复制");
	} catch {
		toast(text);
	}
}
export async function getJson(path) {
	const res = await fetch(path);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
}
export async function post(path, body = {}) {
	const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
}

// ---------- 工具结果解析（与后端 parseToolResult 对应） ----------
export function parseResult(item) {
	let body = item.text ?? "";
	const meta = {};
	const footer = body.match(/\n*\[(agent: [^\]]+)\]\s*$/);
	if (footer) {
		body = body.slice(0, footer.index);
		for (const part of footer[1].split("|")) {
			const [k, ...v] = part.split(":");
			meta[k.trim()] = v.join(":").trim();
		}
	}
	let status = item.isError ? "error" : "done";
	const harness = (item.text ?? "").match(/<harness>([\s\S]*?)<\/harness>\s*$/);
	if (harness) {
		if (/aborted/i.test(harness[1])) {
			status = "aborted";
			body = "这项任务被中止了，CLI 进程已结束。";
		} else {
			if (/interrupted/i.test(harness[1])) status = "interrupted";
			body = harness[1]
				.split("\n")
				.map((l) => l.trim().replace(/^\[(error|info|warning)\]\s*/, ""))
				.filter(Boolean)
				.join("\n");
		}
	}
	const d = item.details ?? {};
	const seconds = meta["耗时"] ? Number.parseFloat(meta["耗时"]) : undefined;
	return {
		status,
		body: body.trim(),
		sessionId: d.sessionId ?? meta["session_id"],
		durationMs: d.durationMs ?? (seconds !== undefined ? seconds * 1000 : undefined),
		cost: d.costUsd ?? (meta["花费"] ? Number.parseFloat(meta["花费"].replace("$", "")) : undefined),
		cwd: d.cwd,
		exitCode: d.exitCode,
	};
}

// ---------- 极简 Markdown（先转义，再加格式，不允许任何原始 HTML） ----------
function inline(text) {
	return esc(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function markdown(src) {
	const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^```/.test(line)) {
			const code = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
			i++;
			out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
			continue;
		}
		const h = line.match(/^(#{1,4})\s+(.*)$/);
		if (h) {
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			i++;
			continue;
		}
		if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
			const ordered = /^\s*\d+[.)]\s+/.test(line);
			const items = [];
			while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))}</li>`);
				i++;
			}
			out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
			continue;
		}
		if (/^>\s?/.test(line)) {
			const quote = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
			out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const para = [];
		while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
		out.push(`<p>${para.map(inline).join("<br>")}</p>`);
	}
	return out.join("");
}
