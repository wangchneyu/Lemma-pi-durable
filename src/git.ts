// 工作区隔离用到的 git 操作：快照、worktree、提交、差异、合并回主目录。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 在 worktree 里提交时用的身份：不依赖用户的全局 git 配置 */
const AUTHOR = ["-c", "user.name=pi-agent", "-c", "user.email=pi-agent@localhost", "-c", "commit.gpgsign=false"];

export function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8", ...(env ? { env } : {}) }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

async function must(cwd: string, args: string[], input?: string): Promise<string> {
	const r = await git(cwd, args, input);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
	return r.stdout.trim();
}

/** cwd 所在仓库的根目录；不在 git 仓库里（或仓库还没有任何提交）时返回 undefined */
export async function repoRoot(cwd: string): Promise<string | undefined> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return undefined;
	const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
	if (head.code !== 0) return undefined;
	return top.stdout.trim();
}

/** 在独立临时索引中拍工作区快照，包含未跟踪且未忽略的新文件，不改用户索引或分支。 */
export async function snapshot(root: string): Promise<string> {
	// 干净工作区直接复用 HEAD，跳过全仓临时索引扫描，大幅降低新派工启动耗时
	const status = await git(root, ["status", "--porcelain"]);
	if (status.code === 0 && !status.stdout.trim()) {
		return must(root, ["rev-parse", "HEAD"]);
	}
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-index-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
	const run = async (args: string[]) => {
		const result = await git(root, args, undefined, env);
		if (result.code !== 0) throw new Error(`创建隔离快照失败：${result.stderr.trim().slice(-500)}`);
		return result.stdout.trim();
	};
	try {
		const head = await run(["rev-parse", "HEAD"]);
		await run(["read-tree", head]);
		await run(["add", "-A", "--", "."]);
		const tree = await run(["write-tree"]);
		if (tree === await run(["rev-parse", `${head}^{tree}`])) return head;
		return await run([...AUTHOR, "commit-tree", tree, "-p", head, "-m", "pi-agent workspace snapshot"]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function addWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	await must(root, ["worktree", "add", "-f", "-b", branch, path, base]);
}

/**
 * 主目录里被 git 忽略、但干活需要的目录（依赖等）：用目录联接挂进 worktree，不复制。
 * 只挂被忽略的目录，避免把它们提交进分支。
 */
export async function linkIgnoredDirs(root: string, path: string, subdir: string, names: string[]): Promise<string[]> {
	const linked: string[] = [];
	for (const name of names) {
		for (const rel of new Set([name, subdir ? join(subdir, name) : name])) {
			const source = join(root, rel);
			const target = join(path, rel);
			if (!existsSync(source) || existsSync(target)) continue;
			const ignored = await git(root, ["check-ignore", "-q", rel]);
			if (ignored.code !== 0) continue;
			try {
				mkdirSync(dirname(target), { recursive: true });
				symlinkSync(source, target, "junction");
				linked.push(rel);
			} catch {
				/* 联接失败不影响干活，只是可能缺依赖 */
			}
		}
	}
	return linked;
}

/** 提交 worktree 里的全部改动；exclude 里的文件（从主目录带进来的规范文件）不提交。没有改动返回 undefined */
export async function commitAll(path: string, message: string, exclude: string[] = []): Promise<string | undefined> {
	await must(path, ["add", "-A"]);
	if (exclude.length) await git(path, ["reset", "-q", "--", ...exclude]);
	const staged = await git(path, ["diff", "--cached", "--quiet"]);
	if (staged.code === 0) return undefined;
	await must(path, [...AUTHOR, "commit", "-q", "--no-verify", "-m", message]);
	return must(path, ["rev-parse", "HEAD"]);
}

export type FileStat = {
	path: string;
	add: number;
	del: number;
	binary?: boolean;
}

export async function numstat(root: string, from: string, to: string): Promise<FileStat[]> {
	const out = await must(root, ["diff", "--numstat", "-z", "--no-renames", from, to]);
	const files: FileStat[] = [];
	for (const rec of out.split("\0").filter(Boolean)) {
		const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
		if (!m) continue;
		files.push({ path: m[3]!, add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" || undefined });
	}
	return files;
}

export async function diffText(root: string, from: string, to: string, maxBytes = 400_000): Promise<{ text: string; truncated: boolean }> {
	const out = await must(root, ["diff", "--no-color", "--no-renames", from, to]);
	return out.length > maxBytes ? { text: out.slice(0, maxBytes), truncated: true } : { text: out, truncated: false };
}

/**
 * 把 from..to 的改动应用到主目录的工作区（不提交、不动分支）。
 * 先直接应用；冲突时退回三方合并，冲突标记留在文件里由用户处理。
 */
export async function applyRange(root: string, from: string, to: string): Promise<{ ok: boolean; conflicts: string[]; message: string }> {
	const patch = await git(root, ["diff", "--binary", "--no-color", "--no-renames", from, to]);
	if (patch.code !== 0) return { ok: false, conflicts: [], message: patch.stderr.trim() };
	if (!patch.stdout.trim()) return { ok: true, conflicts: [], message: "没有需要应用的改动" };
	const direct = await git(root, ["apply", "--whitespace=nowarn", "-"], patch.stdout);
	if (direct.code === 0) return { ok: true, conflicts: [], message: "已应用到工作区" };
	const merged = await git(root, ["apply", "--3way", "--whitespace=nowarn", "-"], patch.stdout);
	const text = `${merged.stdout}\n${merged.stderr}`;
	const conflicts = [...text.matchAll(/(?:with conflicts|conflict[s]? in|U )\s*:?\s*(\S+)/gi)].map((m) => m[1]!);
	if (merged.code === 0) return { ok: true, conflicts: [], message: "已通过三方合并应用到工作区" };
	return {
		ok: false,
		conflicts,
		message: (direct.stderr || merged.stderr).trim().split("\n").slice(-6).join("\n"),
	};
}

export async function removeWorktree(root: string, path: string, branch: string): Promise<void> {
	await git(root, ["worktree", "remove", "--force", path]);
	if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	await git(root, ["worktree", "prune"]);
	await git(root, ["branch", "-D", branch]);
}
