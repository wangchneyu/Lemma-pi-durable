// GitLens 风格多仓库图谱、提交与推送工作台，以及 Agent 自主管理 + 关键风险人工确认网关。
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineTool, type Harness } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { autonomyChecksForRoot, type AppConfig } from "./config.ts";
import { git } from "./git.ts";

export type GitPushGate = {
	id: string;
	repo: string;
	action: "commit" | "push" | "pull" | "force_push";
	branch: string;
	remote?: string;
	message?: string;
	files?: string[];
	reason: string;
	details?: string[];
	status: "pending" | "approved" | "rejected";
	createdAt: number;
	resolvedAt?: number;
	resolutionNote?: string;
};

export type GitWorkbenchState = {
	requireHumanPush: boolean;
	gates: Record<string, GitPushGate>;
};

export const GitWorkbench = defineDoc<GitWorkbenchState>({
	kind: "lemma.git.workbench",
	version: 1,
	scope: "session",
	initial: () => ({ requireHumanPush: false, gates: {} }),
	checkpointWhen: () => false,
});

export interface ManagedRepoEntry {
	root: string;
	name: string;
	isMain: boolean;
	isGit: boolean;
	branch: string | null;
	head: string | null;
	upstream: string | null;
	remote: string | null;
	ahead: number;
	behind: number;
	dirtyCount: number;
	conflictCount: number;
	remotes: { name: string; url: string }[];
	changeCounts: { pending: number; conflict: number; running: number; applied: number };
}

export interface WorkingFileEntry {
	path: string;
	origPath?: string;
	indexStatus: string;
	workStatus: string;
	statusLabel: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	conflict: boolean;
	sensitive: boolean;
}

export interface GraphCommitNode {
	sha: string;
	shortSha: string;
	parents: string[];
	refs: string[];
	author: string;
	email: string;
	at: number;
	subject: string;
	filesCount: number;
	add: number;
	del: number;
	isHead: boolean;
	isUpstream: boolean;
	unpushed: boolean;
	changes: {
		id: string;
		agent: string;
		model?: string;
		status: ChangeRecord["status"];
		branch: string;
		base: string;
		head: string;
		task: string;
		filesCount: number;
		add: number;
		del: number;
		basedOn?: string;
		integrationStatus?: string;
	}[];
}

export interface GitActionError extends Error {
	code?: string;
	statusCode?: number;
	gate?: GitPushGate;
	ahead?: number;
	behind?: number;
}

function makeGitError(message: string, extra: Partial<GitActionError> = {}): GitActionError {
	const err = new Error(message) as GitActionError;
	Object.assign(err, extra);
	return err;
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a), right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findGitRootSync(dir: string): { root: string; isGit: boolean } {
	let cur = resolve(dir);
	while (true) {
		if (existsSync(join(cur, ".git"))) return { root: cur, isGit: true };
		const parent = dirname(cur);
		if (parent === cur) return { root: resolve(dir), isGit: false };
		cur = parent;
	}
}

export function isSensitiveGitPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	const base = norm.split("/").pop() ?? norm;
	return (
		/^\.env($|\.)/i.test(base) ||
		/\.sqlite([-.]|$)/i.test(base) ||
		/credentials\.json$/i.test(base) ||
		/\.(pem|key|p12|pfx)$/i.test(base) ||
		/(^|\/)(secrets?|private)\//i.test(norm)
	);
}

function sanitizeRemoteUrl(url: string): string {
	return url.replace(/\/\/[^/@\s]+@/g, "//***@");
}

function validRefName(ref: string): boolean {
	return Boolean(ref) && !ref.startsWith("-") && !/[\s~^:?*[\\]|\.\./.test(ref);
}

function gitWithTimeout(cwd: string, args: string[], timeoutMs = 25_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((res) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{
				maxBuffer: 64 * 1024 * 1024,
				timeout: timeoutMs,
				windowsHide: true,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
				const extraErr = error && (error as { killed?: boolean }).killed ? "Git 命令执行超时（可能是网络或凭据确认等待超时）。\n" : "";
				res({ code, stdout: String(stdout ?? ""), stderr: extraErr + String(stderr ?? "") });
			},
		);
	});
}

/** 列出当前会话涉及的 Git 仓库（主工作目录 + 外部改动所属仓库） */
export function discoverManagedRepoRoots(config: Pick<AppConfig, "workdir">, changes: ChangeStore): { root: string; isMain: boolean; isGit: boolean }[] {
	const main = findGitRootSync(config.workdir);
	const out: { root: string; isMain: boolean; isGit: boolean }[] = [{ root: main.root, isMain: true, isGit: main.isGit }];
	for (const ch of changes.list()) {
		if (!ch.root || !existsSync(ch.root)) continue;
		const resolved = findGitRootSync(ch.root);
		if (!out.some((item) => samePath(item.root, resolved.root))) {
			out.push({ root: resolved.root, isMain: false, isGit: resolved.isGit });
		}
	}
	return out;
}

/** 校验并解析前端或工具请求的仓库路径，禁止越界访问会话外任意目录 */
export function resolveManagedRepo(config: Pick<AppConfig, "workdir">, changes: ChangeStore, requested?: string): { root: string; isMain: boolean; isGit: boolean } {
	const repos = discoverManagedRepoRoots(config, changes);
	if (!requested?.trim()) return repos[0]!;
	const target = findGitRootSync(requested.trim()).root;
	const hit = repos.find((item) => samePath(item.root, target) || samePath(item.root, requested.trim()));
	if (!hit) throw makeGitError("只能管理当前会话主仓库或已发生改动的关联仓库。", { statusCode: 403, code: "REPO_NOT_ALLOWED" });
	return hit;
}

export function parseWorkingStatus(porcelainZ: string): WorkingFileEntry[] {
	const entries: WorkingFileEntry[] = [];
	const parts = porcelainZ.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec || rec.length < 4) continue;
		const x = rec[0]!;
		const y = rec[1]!;
		const path = rec.slice(3);
		let origPath: string | undefined;
		if (x === "R" || x === "C") origPath = parts[++i];
		const untracked = x === "?" && y === "?";
		const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
		const staged = !untracked && x !== " ";
		const unstaged = !untracked && y !== " ";
		const statusLabel = conflict ? "冲突" : untracked ? "未跟踪" : x === "A" ? "新增" : x === "D" || y === "D" ? "删除" : x === "R" || y === "R" ? "重命名" : "修改";
		entries.push({ path, origPath, indexStatus: x, workStatus: y, statusLabel, staged, unstaged, untracked, conflict, sensitive: isSensitiveGitPath(path) });
	}
	return entries;
}

export async function readRepoSummary(
	entry: { root: string; isMain: boolean; isGit: boolean },
	changes: ChangeStore,
): Promise<ManagedRepoEntry> {
	const allChanges = changes.list().filter((c) => samePath(c.root, entry.root));
	const changeCounts = {
		pending: allChanges.filter((c) => c.status === "pending").length,
		conflict: allChanges.filter((c) => c.status === "conflict").length,
		running: allChanges.filter((c) => c.status === "running").length,
		applied: allChanges.filter((c) => c.status === "applied").length,
	};
	const name = entry.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || entry.root;
	if (!entry.isGit) {
		return {
			root: entry.root, name, isMain: entry.isMain, isGit: false,
			branch: null, head: null, upstream: null, remote: null, ahead: 0, behind: 0, dirtyCount: 0, conflictCount: 0, remotes: [], changeCounts,
		};
	}
	const [headRes, branchRes, upRes, remoteRes, statusRes] = await Promise.all([
		git(entry.root, ["rev-parse", "--verify", "-q", "HEAD"]),
		git(entry.root, ["symbolic-ref", "--short", "-q", "HEAD"]),
		git(entry.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
		git(entry.root, ["remote", "-v"]),
		git(entry.root, ["status", "--porcelain=v1", "-z"]),
	]);
	const head = headRes.code === 0 ? headRes.stdout.trim() : null;
	const branch = branchRes.code === 0 ? branchRes.stdout.trim() : head ? `HEAD@${head.slice(0, 7)}` : null;
	const upstream = upRes.code === 0 ? upRes.stdout.trim() : null;
	const remotesMap = new Map<string, string>();
	for (const line of remoteRes.stdout.split(/\r?\n/)) {
		const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
		if (m && (!remotesMap.has(m[1]!) || m[3] === "push")) remotesMap.set(m[1]!, sanitizeRemoteUrl(m[2]!));
	}
	const remotes = [...remotesMap.entries()].map(([rName, url]) => ({ name: rName, url }));
	let ahead = 0;
	let behind = 0;
	let remote: string | null = upstream ? upstream.split("/")[0] ?? null : remotes[0]?.name ?? null;
	if (upstream && head) {
		const lr = await git(entry.root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
		if (lr.code === 0) {
			const [a, b] = lr.stdout.trim().split(/\s+/).map(Number);
			if (Number.isFinite(a)) ahead = a!;
			if (Number.isFinite(b)) behind = b!;
		}
	} else if (head && remote && branch) {
		// 本地分支未设置 tracking 时，如远端已存在同名分支（如 origin/main）则计算差值，否则视为本地新建待发布提交数
		const remoteRef = `${remote}/${branch}`;
		const verifyRemote = await git(entry.root, ["rev-parse", "--verify", "-q", `refs/remotes/${remoteRef}`]);
		if (verifyRemote.code === 0) {
			const lr = await git(entry.root, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${remoteRef}`]);
			if (lr.code === 0) {
				const [a, b] = lr.stdout.trim().split(/\s+/).map(Number);
				if (Number.isFinite(a)) ahead = a!;
				if (Number.isFinite(b)) behind = b!;
			}
		} else {
			const cnt = await git(entry.root, ["rev-list", "--count", "HEAD"]);
			if (cnt.code === 0 && Number.isFinite(Number(cnt.stdout.trim()))) ahead = Number(cnt.stdout.trim());
		}
	}
	const working = statusRes.code === 0 ? parseWorkingStatus(statusRes.stdout) : [];
	return {
		root: entry.root,
		name,
		isMain: entry.isMain,
		isGit: true,
		branch,
		head,
		upstream,
		remote,
		ahead,
		behind,
		dirtyCount: working.length,
		conflictCount: working.filter((w) => w.conflict).length,
		remotes,
		changeCounts,
	};
}

export async function listManagedRepos(config: Pick<AppConfig, "workdir">, changes: ChangeStore): Promise<ManagedRepoEntry[]> {
	const entries = discoverManagedRepoRoots(config, changes);
	return Promise.all(entries.map((e) => readRepoSummary(e, changes)));
}

/** 获取 GitLens Commit Graph 所需完整拓扑数据（工作区变更、提交图谱、分支与 Lemma worktree 关联） */
export async function inspectRepoGraph(
	config: Pick<AppConfig, "workdir">,
	changes: ChangeStore,
	requestedRepo?: string,
	limit = 60,
): Promise<{
	repo: ManagedRepoEntry;
	working: WorkingFileEntry[];
	branches: { name: string; upstream?: string; head: boolean; sha: string; subject: string }[];
	commits: GraphCommitNode[];
	repoChanges: ChangeRecord[];
}> {
	const entry = resolveManagedRepo(config, changes, requestedRepo);
	const repo = await readRepoSummary(entry, changes);
	const repoChanges = changes.list().filter((c) => samePath(c.root, entry.root));
	if (!entry.isGit) {
		return { repo, working: [], branches: [], commits: [], repoChanges };
	}

	const statusRes = await git(entry.root, ["status", "--porcelain=v1", "-z"]);
	const working = statusRes.code === 0 ? parseWorkingStatus(statusRes.stdout) : [];

	const refFmt = "%(refname:short)%x1f%(upstream:short)%x1f%(HEAD)%x1f%(objectname:short)%x1f%(subject)";
	const brRes = await git(entry.root, ["for-each-ref", `--format=${refFmt}`, "refs/heads"]);
	const branches = brRes.code === 0
		? brRes.stdout
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const [name = "", upstream = "", headMark = "", sha = "", subject = ""] = line.split("\x1f");
				return { name, ...(upstream ? { upstream } : {}), head: headMark === "*", sha, subject };
			})
		: [];

	const upstreamTipRes = repo.upstream ? await git(entry.root, ["rev-parse", "--verify", "-q", repo.upstream]) : null;
	const upstreamTip = upstreamTipRes?.code === 0 ? upstreamTipRes.stdout.trim() : null;
	const unpushedSet = new Set<string>();
	if (repo.upstream && repo.head) {
		const upList = await git(entry.root, ["rev-list", `${repo.upstream}..HEAD`]);
		if (upList.code === 0) for (const s of upList.stdout.split(/\r?\n/).filter(Boolean)) unpushedSet.add(s.trim());
	} else if (repo.head && repo.remote && repo.branch) {
		const fallbackRef = `refs/remotes/${repo.remote}/${repo.branch}`;
		const v = await git(entry.root, ["rev-parse", "--verify", "-q", fallbackRef]);
		if (v.code === 0) {
			const upList = await git(entry.root, ["rev-list", `${fallbackRef}..HEAD`]);
			if (upList.code === 0) for (const s of upList.stdout.split(/\r?\n/).filter(Boolean)) unpushedSet.add(s.trim());
		} else {
			const upList = await git(entry.root, ["rev-list", "-n", String(Math.max(10, Math.min(120, limit))), "HEAD"]);
			if (upList.code === 0) for (const s of upList.stdout.split(/\r?\n/).filter(Boolean)) unpushedSet.add(s.trim());
		}
	}

	const changesByHead = new Map<string, GraphCommitNode["changes"]>();
	for (const ch of repoChanges) {
		if (!ch.head || ch.status === "dropped") continue;
		const list = changesByHead.get(ch.head) ?? [];
		list.push({
			id: ch.id,
			agent: ch.agent,
			model: ch.model,
			status: ch.status,
			branch: ch.branch,
			base: ch.base,
			head: ch.head,
			task: ch.task,
			filesCount: ch.files.length,
			add: ch.add,
			del: ch.del,
			basedOn: ch.basedOn,
			integrationStatus: ch.integration?.status,
		});
		changesByHead.set(ch.head, list);
	}

	const commits: GraphCommitNode[] = [];
	if (repo.head) {
		const safeLimit = Math.max(10, Math.min(120, Math.floor(limit)));
		const logRes = await git(entry.root, [
			"log",
			"--all",
			"--topo-order",
			`-n`,
			String(safeLimit),
			"--shortstat",
			`--format=__COMMIT__%n%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s`,
		]);
		if (logRes.code === 0) {
			const blocks = logRes.stdout.split("__COMMIT__\n").slice(1);
			for (const block of blocks) {
				const lines = block.split(/\r?\n/);
				const header = lines[0];
				if (!header) continue;
				const [sha = "", parentsRaw = "", refsRaw = "", author = "", email = "", atSec = "0", subject = ""] = header.split("\x1f");
				let filesCount = 0, add = 0, del = 0;
				const statLine = lines.find((l) => /file[s]? changed/.test(l));
				if (statLine) {
					const mf = statLine.match(/(\d+)\s+file/);
					const ma = statLine.match(/(\d+)\s+insertion/);
					const md = statLine.match(/(\d+)\s+deletion/);
					if (mf) filesCount = Number(mf[1]);
					if (ma) add = Number(ma[1]);
					if (md) del = Number(md[1]);
				}
				const refs = refsRaw
					.split(",")
					.map((r) => r.trim())
					.filter(Boolean);
				commits.push({
					sha,
					shortSha: sha.slice(0, 7),
					parents: parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [],
					refs,
					author,
					email,
					at: Number(atSec) * 1000,
					subject,
					filesCount,
					add,
					del,
					isHead: sha === repo.head,
					isUpstream: !!upstreamTip && sha === upstreamTip,
					unpushed: unpushedSet.has(sha),
					changes: changesByHead.get(sha) ?? [],
				});
			}
		}
	}

	return { repo, working, branches, commits, repoChanges };
}

/** 获取单次提交或当前未提交工作区的文件树与 Diff */
export async function inspectRepoCommit(
	config: Pick<AppConfig, "workdir">,
	changes: ChangeStore,
	requestedRepo: string | undefined,
	shaOrWorktree: string,
	fileFilter?: string,
): Promise<{
	sha: string;
	isWorktree: boolean;
	author?: string;
	at?: number;
	parents?: string[];
	refs?: string[];
	subject?: string;
	body?: string;
	files: { path: string; add: number; del: number; binary?: boolean; statusLabel?: string; sensitive?: boolean }[];
	diff: string;
	truncated: boolean;
}> {
	const entry = resolveManagedRepo(config, changes, requestedRepo);
	if (!entry.isGit) throw makeGitError("该目录还不是 Git 仓库。", { statusCode: 400 });
	const maxBytes = 350_000;
	const filterArgs = fileFilter?.trim() ? ["--", fileFilter.trim()] : [];

	if (shaOrWorktree === "WORKTREE") {
		const statusRes = await git(entry.root, ["status", "--porcelain=v1", "-z"]);
		const working = statusRes.code === 0 ? parseWorkingStatus(statusRes.stdout) : [];
		const hasHead = (await git(entry.root, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
		const statsMap = new Map<string, { add: number; del: number; binary?: boolean }>();
		if (hasHead) {
			const ns = await git(entry.root, ["diff", "--numstat", "-z", "--no-renames", "HEAD"]);
			if (ns.code === 0) {
				for (const rec of ns.stdout.split("\0").filter(Boolean)) {
					const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
					if (m) statsMap.set(m[3]!, { add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" || undefined });
				}
			}
		}
		const files = working.map((w) => {
			const st = statsMap.get(w.path);
			let add = st?.add ?? 0;
			let del = st?.del ?? 0;
			if (w.untracked && !st) {
				try {
					const full = join(entry.root, w.path);
					const sz = statSync(full).size;
					if (sz <= 128 * 1024) {
						const raw = readFileSync(full);
						if (!raw.includes(0)) add = raw.toString("utf8").split(/\r?\n/).length;
					}
				} catch {}
			}
			return { path: w.path, add, del, binary: st?.binary, statusLabel: w.statusLabel, sensitive: w.sensitive };
		});
		let diffText = "";
		if (hasHead) {
			const d = await git(entry.root, ["diff", "--no-color", "--no-renames", "HEAD", ...filterArgs]);
			if (d.code === 0) diffText = d.stdout;
		}
		const targetUntracked = working.filter((w) => w.untracked && (!fileFilter?.trim() || w.path === fileFilter.trim()));
		for (const u of targetUntracked.slice(0, 12)) {
			try {
				const full = join(entry.root, u.path);
				const sz = statSync(full).size;
				if (sz > 64 * 1024) {
					diffText += `\ndiff --git a/${u.path} b/${u.path}\n@@ -0,0 +1,1 @@\n+[未跟踪文件过大（${sz} bytes），请直接在工作区查看]\n`;
					continue;
				}
				const buf = readFileSync(full);
				if (buf.includes(0)) {
					diffText += `\ndiff --git a/${u.path} b/${u.path}\n@@ -0,0 +1,1 @@\n+[二进制未跟踪文件（${sz} bytes）]\n`;
					continue;
				}
				const lines = buf.toString("utf8").split(/\r?\n/).slice(0, 200);
				diffText += `\ndiff --git a/${u.path} b/${u.path}\nnew file mode 100644\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
			} catch {}
		}
		const truncated = diffText.length > maxBytes;
		return {
			sha: "WORKTREE",
			isWorktree: true,
			subject: "当前工作区未提交改动",
			files,
			diff: truncated ? diffText.slice(0, maxBytes) : diffText,
			truncated,
		};
	}

	if (!/^[a-fA-F0-9]{4,40}$/.test(shaOrWorktree)) throw makeGitError("提交哈希格式无效。", { statusCode: 400 });
	const verify = await git(entry.root, ["rev-parse", "--verify", "-q", `${shaOrWorktree}^{commit}`]);
	if (verify.code !== 0) throw makeGitError(`找不到提交 ${shaOrWorktree}。`, { statusCode: 404 });
	const fullSha = verify.stdout.trim();
	const metaRes = await git(entry.root, ["show", "-s", "--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1f%b", fullSha]);
	const [sha = fullSha, parentsRaw = "", refsRaw = "", author = "", atSec = "0", subject = "", body = ""] = metaRes.stdout.split("\x1f");
	const ns = await git(entry.root, ["diff-tree", "--no-commit-id", "--numstat", "-r", "--root", "-z", "--no-renames", fullSha]);
	const files: { path: string; add: number; del: number; binary?: boolean; sensitive?: boolean }[] = [];
	if (ns.code === 0) {
		for (const rec of ns.stdout.split("\0").filter(Boolean)) {
			const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
			if (m) files.push({ path: m[3]!, add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" || undefined, sensitive: isSensitiveGitPath(m[3]!) });
		}
	}
	const patchRes = await git(entry.root, ["show", "--no-color", "--no-renames", "--format=", "--patch", "--root", fullSha, ...filterArgs]);
	const rawDiff = patchRes.code === 0 ? patchRes.stdout : "";
	const truncated = rawDiff.length > maxBytes;
	return {
		sha,
		isWorktree: false,
		author,
		at: Number(atSec) * 1000,
		parents: parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [],
		refs: refsRaw.split(",").map((r) => r.trim()).filter(Boolean),
		subject,
		body: body.trim(),
		files,
		diff: truncated ? rawDiff.slice(0, maxBytes) : rawDiff,
		truncated,
	};
}

export async function recordPushGate(
	harness: Harness | undefined,
	context: Context | undefined,
	gateInput: Omit<GitPushGate, "id" | "status" | "createdAt">,
): Promise<GitPushGate> {
	const gate: GitPushGate = { ...gateInput, id: `gate-${randomUUID().slice(0, 8)}`, status: "pending", createdAt: Date.now() };
	if (harness && context) {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(GitWorkbench);
			// 若同一仓库同一动作已存在未处理网关，更新它以免重复刷屏
			const existing = Object.values(doc.gates).find((g) => g.status === "pending" && samePath(g.repo, gate.repo) && g.action === gate.action && g.branch === gate.branch);
			if (existing) {
				gate.id = existing.id;
				doc.gates[existing.id] = gate;
			} else {
				doc.gates[gate.id] = gate;
			}
		}, context);
	}
	return gate;
}

export async function setGitPushPolicy(
	harness: Harness,
	context: Context,
	requireHumanPush: boolean,
): Promise<GitWorkbenchState> {
	let out!: GitWorkbenchState;
	await harness.commit(async (tx) => {
		const doc = await tx.doc(GitWorkbench);
		doc.requireHumanPush = requireHumanPush;
		out = JSON.parse(JSON.stringify(doc)) as GitWorkbenchState;
	}, context);
	return out;
}

export async function fetchManagedRepo(config: Pick<AppConfig, "workdir">, changes: ChangeStore, requestedRepo?: string, remote?: string): Promise<{ repo: ManagedRepoEntry; output: string }> {
	const entry = resolveManagedRepo(config, changes, requestedRepo);
	if (!entry.isGit) throw makeGitError("该目录不是 Git 仓库。", { statusCode: 400 });
	const targetRemote = remote?.trim() || (await readRepoSummary(entry, changes)).remote || "origin";
	if (!validRefName(targetRemote)) throw makeGitError("Remote 名称无效。", { statusCode: 400 });
	const res = await gitWithTimeout(entry.root, ["fetch", "--prune", targetRemote]);
	if (res.code !== 0) throw makeGitError(`git fetch 失败：${(res.stderr || res.stdout).trim() || "请检查网络或代理/凭据设置"}`, { statusCode: 409 });
	return { repo: await readRepoSummary(entry, changes), output: (res.stdout + res.stderr).trim() || `已从 ${targetRemote} 更新远端状态` };
}

export async function pullManagedRepo(
	deps: { config: Pick<AppConfig, "workdir">; changes: ChangeStore; harness?: Harness; context?: Context },
	opts: { repo?: string; remote?: string; branch?: string; actor: "human" | "agent" },
): Promise<{ repo: ManagedRepoEntry; output: string }> {
	const entry = resolveManagedRepo(deps.config, deps.changes, opts.repo);
	if (!entry.isGit) throw makeGitError("该目录不是 Git 仓库。", { statusCode: 400 });
	const summary = await readRepoSummary(entry, deps.changes);
	if (summary.dirtyCount > 0) throw makeGitError("工作区有未提交改动，请先提交后再拉取（pull --ff-only）。", { statusCode: 409 });
	const remote = opts.remote?.trim() || summary.remote || "origin";
	const branch = opts.branch?.trim() || summary.branch || "";
	if (!validRefName(remote) || (branch && !validRefName(branch))) throw makeGitError("分支或 Remote 名称无效。", { statusCode: 400 });
	const args = branch ? ["pull", "--ff-only", remote, branch] : ["pull", "--ff-only"];
	const res = await gitWithTimeout(entry.root, args);
	if (res.code !== 0) {
		const msg = (res.stderr || res.stdout).trim();
		if (opts.actor === "agent") {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "pull",
				branch: branch || "HEAD",
				remote,
				reason: `无法快进拉取（ff-only），本地与 ${remote} 可能已分叉，需人工决策合并或变基。`,
				details: [msg.slice(-400)],
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		throw makeGitError(`快进拉取失败：${msg}`, { statusCode: 409 });
	}
	return { repo: await readRepoSummary(entry, deps.changes), output: (res.stdout + res.stderr).trim() || "快进拉取成功" };
}

export async function commitManagedRepo(
	deps: { config: Pick<AppConfig, "workdir" | "autonomy">; changes: ChangeStore; harness?: Harness; context?: Context },
	opts: { repo?: string; message: string; files?: string[]; actor: "human" | "agent" },
): Promise<{ repo: ManagedRepoEntry; sha: string; message: string; committedFiles: number }> {
	const entry = resolveManagedRepo(deps.config, deps.changes, opts.repo);
	if (!entry.isGit) throw makeGitError("该目录不是 Git 仓库。", { statusCode: 400 });
	const message = opts.message.trim();
	if (!message) throw makeGitError("提交说明（Commit message）不能为空。", { statusCode: 400 });
	const statusRes = await git(entry.root, ["status", "--porcelain=v1", "-z"]);
	const working = statusRes.code === 0 ? parseWorkingStatus(statusRes.stdout) : [];
	if (!working.length) throw makeGitError("工作区干净，没有待提交的改动。", { statusCode: 409 });

	const summary = await readRepoSummary(entry, deps.changes);
	const targets = opts.files?.length ? working.filter((w) => opts.files!.includes(w.path)) : working;
	if (!targets.length) throw makeGitError("未匹配到指定的待提交文件。", { statusCode: 400 });

	const conflicts = targets.filter((w) => w.conflict).map((w) => w.path);
	const diffCheck = await git(entry.root, ["diff", "--check"]);
	const hasMarkers = diffCheck.code !== 0 && /conflict marker/i.test(diffCheck.stdout + diffCheck.stderr);
	if (conflicts.length || hasMarkers) {
		const reason = conflicts.length ? `存在未解决合并冲突：${conflicts.join("、")}` : "检测到残留冲突标记（<<<<<<< / >>>>>>>），不能提交。";
		if (opts.actor === "agent") {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "commit",
				branch: summary.branch ?? "HEAD",
				message,
				files: targets.map((t) => t.path),
				reason,
			});
			throw makeGitError(reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		throw makeGitError(reason, { statusCode: 409 });
	}

	if (opts.actor === "agent") {
		const sensitive = targets.filter((w) => w.sensitive).map((w) => w.path);
		if (sensitive.length) {
			const reason = `包含敏感或本地数据文件（${sensitive.join("、")}），已转为关键人工确认，禁止 Agent 自动提交。`;
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "commit",
				branch: summary.branch ?? "HEAD",
				message,
				files: targets.map((t) => t.path),
				reason,
				details: sensitive,
			});
			throw makeGitError(reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		const checks = autonomyChecksForRoot(entry.root, deps.config);
		const failedApplied = deps.changes.list().find(
			(ch) => samePath(ch.root, entry.root) && ch.status === "applied" && deps.config.autonomy.enabled && checks.length > 0 && ch.verification && !ch.verification.passed,
		);
		if (failedApplied) {
			const reason = `改动 #${failedApplied.id} 的验收检查未通过，Agent 不能自动提交，需人工复核。`;
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "commit",
				branch: summary.branch ?? "HEAD",
				message,
				files: targets.map((t) => t.path),
				reason,
			});
			throw makeGitError(reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
	}

	if (opts.files?.length) {
		await git(entry.root, ["reset", "-q"]);
		const addRes = await git(entry.root, ["add", "-A", "--", ...targets.map((t) => t.path)]);
		if (addRes.code !== 0) throw makeGitError(`暂存文件失败：${addRes.stderr.trim()}`, { statusCode: 409 });
	} else {
		const addRes = await git(entry.root, ["add", "-A"]);
		if (addRes.code !== 0) throw makeGitError(`暂存全部文件失败：${addRes.stderr.trim()}`, { statusCode: 409 });
	}
	const stagedCheck = await git(entry.root, ["diff", "--cached", "--quiet"]);
	if (stagedCheck.code === 0) throw makeGitError("暂存区没有实际变动内容，未生成空提交。", { statusCode: 409 });

	const hasName = (await git(entry.root, ["config", "user.name"])).code === 0;
	const hasEmail = (await git(entry.root, ["config", "user.email"])).code === 0;
	const authorArgs = hasName && hasEmail ? [] : ["-c", "user.name=pi-agent", "-c", "user.email=pi-agent@localhost"];
	const commitRes = await git(entry.root, [...authorArgs, "commit", "-q", "-m", message]);
	if (commitRes.code !== 0) throw makeGitError(`提交失败：${(commitRes.stderr || commitRes.stdout).trim()}`, { statusCode: 409 });
	const newHead = (await git(entry.root, ["rev-parse", "HEAD"])).stdout.trim();
	return { repo: await readRepoSummary(entry, deps.changes), sha: newHead, message, committedFiles: targets.length };
}

export async function pushManagedRepo(
	deps: { config: Pick<AppConfig, "workdir" | "autonomy">; changes: ChangeStore; harness?: Harness; context?: Context },
	opts: { repo?: string; branch?: string; remote?: string; forceWithLease?: boolean; setUpstream?: boolean; actor: "human" | "agent" },
): Promise<{ repo: ManagedRepoEntry; remote: string; branch: string; output: string }> {
	const entry = resolveManagedRepo(deps.config, deps.changes, opts.repo);
	if (!entry.isGit) throw makeGitError("该目录不是 Git 仓库。", { statusCode: 400 });
	const summary = await readRepoSummary(entry, deps.changes);
	const remote = opts.remote?.trim() || summary.remote || "";
	if (!remote) throw makeGitError("当前仓库尚未配置远程仓库（remote），无法推送。", { statusCode: 409 });
	const branch = opts.branch?.trim() || summary.branch || "";
	if (!branch || branch.startsWith("HEAD@") || !validRefName(remote) || !validRefName(branch)) {
		throw makeGitError("请先签出有效分支后再推送（当前处于游离 HEAD 或分支名无效）。", { statusCode: 409 });
	}
	const isCurrentBranch = summary.branch === branch;

	if (opts.forceWithLease && opts.actor === "agent") {
		const gate = await recordPushGate(deps.harness, deps.context, {
			repo: entry.root,
			action: "force_push",
			branch,
			remote,
			reason: "强制推送（--force-with-lease）属于高危历史改写操作，禁止 Agent 自动执行，必须由人工确认。",
		});
		throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
	}

	if (opts.actor === "agent") {
		const wb = deps.harness && deps.context ? await deps.harness.snapshot(GitWorkbench, deps.context) : undefined;
		if (wb?.requireHumanPush) {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "push",
				branch,
				remote,
				reason: "已启用「推送前人工确认」，请核对 GitLens 提交图与改动后批准推送。",
				details: [`目标：${remote}/${branch}`, `待推送提交：${summary.ahead}`],
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		if (isCurrentBranch && summary.conflictCount > 0) {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "push",
				branch,
				remote,
				reason: "工作区仍存在未解决冲突，禁止 Agent 推送。",
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		if (isCurrentBranch && summary.dirtyCount > 0) {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "push",
				branch,
				remote,
				reason: `工作区还有 ${summary.dirtyCount} 个未提交文件，Agent 不在未确认状态自动推送，请先提交或人工确认。`,
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		const checks = autonomyChecksForRoot(entry.root, deps.config);
		const failed = deps.changes.list().find(
			(ch) => samePath(ch.root, entry.root) && ["applied", "pending"].includes(ch.status) && (isCurrentBranch || ch.branch === branch) && deps.config.autonomy.enabled && checks.length > 0 && ch.verification && !ch.verification.passed,
		);
		if (failed) {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "push",
				branch,
				remote,
				reason: `改动 #${failed.id} 未通过配置验收检查，禁止 Agent 自动推送，需人工决定。`,
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
	}

	// 推送当前分支且未勾选强推时，先探测是否落后/分叉
	if (isCurrentBranch && !opts.forceWithLease) {
		await gitWithTimeout(entry.root, ["fetch", "--quiet", remote], 15_000).catch(() => null);
		const latest = await readRepoSummary(entry, deps.changes);
		if (latest.behind > 0) {
			const reason = `远端 ${remote}/${branch} 领先本地 ${latest.behind} 个提交（本地领先 ${latest.ahead} 个），存在分叉不能直接快进推送。`;
			if (opts.actor === "agent") {
				const gate = await recordPushGate(deps.harness, deps.context, {
					repo: entry.root,
					action: "force_push",
					branch,
					remote,
					reason: `${reason} 已转人工处理（先拉取或安全强推）。`,
					details: [`ahead: ${latest.ahead}`, `behind: ${latest.behind}`],
				});
				throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate, ahead: latest.ahead, behind: latest.behind });
			}
			throw makeGitError(reason, { statusCode: 409, code: "DIVERGED", ahead: latest.ahead, behind: latest.behind });
		}
	}

	const args = ["push"];
	if (opts.forceWithLease) args.push("--force-with-lease");
	if (opts.setUpstream || !summary.upstream) args.push("-u");
	args.push(remote, branch);
	const pushRes = await gitWithTimeout(entry.root, args, 30_000);
	if (pushRes.code !== 0) {
		const msg = (pushRes.stderr || pushRes.stdout).trim();
		const diverged = /non-fast-forward|fetch first|rejected/i.test(msg);
		if (diverged && opts.actor === "agent") {
			const gate = await recordPushGate(deps.harness, deps.context, {
				repo: entry.root,
				action: "force_push",
				branch,
				remote,
				reason: `推送被远端拒绝（non-fast-forward），需人工确认拉取合并或强推。`,
				details: [msg.slice(-400)],
			});
			throw makeGitError(gate.reason, { statusCode: 409, code: "HUMAN_GATE", gate });
		}
		throw makeGitError(`git push 失败：${msg || "请检查网络/代理或远端权限"}`, { statusCode: 409, ...(diverged ? { code: "DIVERGED" } : {}) });
	}
	return { repo: await readRepoSummary(entry, deps.changes), remote, branch, output: (pushRes.stdout + pushRes.stderr).trim() || `已成功推送到 ${remote}/${branch}` };
}

export async function resolvePushGate(
	deps: { config: Pick<AppConfig, "workdir" | "autonomy">; changes: ChangeStore; harness: Harness; context: Context },
	gateId: string,
	decision: "approve" | "reject",
	note?: string,
): Promise<{ gate: GitPushGate; result?: unknown }> {
	const wb = await deps.harness.snapshot(GitWorkbench, deps.context);
	const gate = wb?.gates[gateId];
	if (!gate) throw makeGitError(`找不到待确认记录 ${gateId}。`, { statusCode: 404 });
	if (gate.status !== "pending") throw makeGitError(`该记录已经处理（${gate.status}）。`, { statusCode: 409 });

	let result: unknown;
	if (decision === "approve") {
		if (gate.action === "commit") {
			result = await commitManagedRepo(deps, { repo: gate.repo, message: gate.message || "commit reviewed changes", files: gate.files, actor: "human" });
		} else if (gate.action === "push") {
			result = await pushManagedRepo(deps, { repo: gate.repo, branch: gate.branch, remote: gate.remote, actor: "human" });
		} else if (gate.action === "force_push") {
			result = await pushManagedRepo(deps, { repo: gate.repo, branch: gate.branch, remote: gate.remote, forceWithLease: true, actor: "human" });
		} else if (gate.action === "pull") {
			result = await pullManagedRepo(deps, { repo: gate.repo, branch: gate.branch, remote: gate.remote, actor: "human" });
		}
	}

	let saved!: GitPushGate;
	await deps.harness.commit(async (tx) => {
		const doc = await tx.doc(GitWorkbench);
		const cur = doc.gates[gateId]!;
		cur.status = decision === "approve" ? "approved" : "rejected";
		cur.resolvedAt = Date.now();
		if (note?.trim()) cur.resolutionNote = note.trim();
		saved = JSON.parse(JSON.stringify(cur)) as GitPushGate;
	}, deps.context);
	return { gate: saved, result };
}

/** 供总调度自主管理日常 Git（status / fetch / clean commit / clean ff push），关键风险自动转人工网关 */
export function createRepoGitTool(deps: {
	config: AppConfig;
	changes: ChangeStore;
	getHarness: () => Harness | undefined;
	onChanged?: (message: string) => void;
}) {
	return defineTool({
		name: "repo_git",
		description:
			"管理主仓库及本次会话关联外部仓库的 Git 状态与日常提交流转。支持 status（查看分支/ahead-behind/未提交/worktree）、fetch、commit（仅在无冲突、无敏感文件和检查未失败时提交）、push（仅允许干净无分叉的快进推送）及 pull（仅 ff-only）。凡涉及历史分叉、强制推送、冲突、敏感文件或“推送前需人工确认”设置，系统会自动拦截并生成待人工确认单提交到后台网页 GitLens 工作台，绝不强行越权。",
		parameters: obj({
			action: oneOf(["status", "fetch", "commit", "push", "pull"]),
			repo: opt(str({ description: "可选：目标仓库根目录（不传默认为主工作目录；跨仓库协作时可传对应外部仓库路径）" })),
			message: opt(str({ description: "commit 时必填：清晰语义化的提交说明" })),
			files: opt(arr(str(), { description: "可选：commit 时仅提交指定的相对路径列表" })),
			remote: opt(str({ description: "可选：remote 名称，默认使用当前跟踪远端或 origin" })),
			branch: opt(str({ description: "可选：push/pull 的目标分支，默认当前签出分支" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const harness = deps.getHarness();
			try {
				if (args.action === "status") {
					const repos = await listManagedRepos(deps.config, deps.changes);
					const target = args.repo ? await inspectRepoGraph(deps.config, deps.changes, args.repo, 20) : null;
					const wb = harness ? await harness.snapshot(GitWorkbench, context) : undefined;
					const pendingGates = Object.values(wb?.gates ?? {}).filter((g) => g.status === "pending");
					return {
						output: [{ type: "text" as const, text: JSON.stringify({ repos, detail: target ? { repo: target.repo, working: target.working, branches: target.branches, recentCommits: target.commits.slice(0, 12) } : undefined, requireHumanPush: wb?.requireHumanPush ?? false, pendingGates }) }],
					};
				}
				if (args.action === "fetch") {
					const res = await fetchManagedRepo(deps.config, deps.changes, args.repo, args.remote);
					deps.onChanged?.(`Agent fetch (${res.repo.name})：${res.output}`);
					return { output: [{ type: "text" as const, text: JSON.stringify(res) }] };
				}
				if (args.action === "pull") {
					const res = await pullManagedRepo({ config: deps.config, changes: deps.changes, harness, context }, { repo: args.repo, remote: args.remote, branch: args.branch, actor: "agent" });
					deps.onChanged?.(`Agent pull --ff-only (${res.repo.name})：${res.output}`);
					return { output: [{ type: "text" as const, text: JSON.stringify(res) }] };
				}
				if (args.action === "commit") {
					if (!args.message?.trim()) return { output: [{ type: "text" as const, text: "action=commit 需要提供 message 提交说明。" }], isError: true };
					const res = await commitManagedRepo({ config: deps.config, changes: deps.changes, harness, context }, { repo: args.repo, message: args.message, files: args.files, actor: "agent" });
					deps.onChanged?.(`Agent 提交 (${res.repo.name}@${res.sha.slice(0, 7)})：${res.message}`);
					return { output: [{ type: "text" as const, text: JSON.stringify(res) }] };
				}
				const res = await pushManagedRepo({ config: deps.config, changes: deps.changes, harness, context }, { repo: args.repo, remote: args.remote, branch: args.branch, actor: "agent" });
				deps.onChanged?.(`Agent 推送 (${res.repo.name} -> ${res.remote}/${res.branch})：${res.output}`);
				return { output: [{ type: "text" as const, text: JSON.stringify(res) }] };
			} catch (error) {
				const ge = error as GitActionError;
				if (ge.code === "HUMAN_GATE" && ge.gate) {
					deps.onChanged?.(`需人工确认 Git 操作（${ge.gate.action} · ${ge.gate.branch}）：${ge.gate.reason}`);
					return {
						output: [{ type: "text" as const, text: `【已触发关键人工确认单 #${ge.gate.id}】${ge.gate.reason}\n请提示用户在后台网页「改动 → GitLens 工作台」核对后一键批准或驳回，勿尝试强行绕过。` }],
						isError: true,
					};
				}
				return { output: [{ type: "text" as const, text: ge.message || String(error) }], isError: true };
			}
		},
	});
}
