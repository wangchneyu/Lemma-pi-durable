import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { git, snapshot } from "./git.ts";

export const integrationTerminal = (change: ChangeRecord) => !!change.integration && !["preparing", "merging", "repairing", "testing"].includes(change.integration.status);
export async function integrationGit(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await git(cwd, args, input, env);
	if (result.code) throw new Error((result.stderr || result.stdout).trim().slice(-3000));
	return result.stdout.trim();
}
export async function workspaceTree(root: string): Promise<{ head: string; tree: string }> {
	const head = await snapshot(root); return { head, tree: await integrationGit(root, ["rev-parse", `${head}^{tree}`]) };
}

/** A passed check is valid only for the captured inputs and unchanged target workspace. */
export async function integrationStale(store: ChangeStore, change: ChangeRecord, checkWorkspace = true): Promise<string | undefined> {
	const integration = change.integration; if (!integration) return "不是集成改动。";
	for (const source of integration.sources) {
		const actual = store.get(source.id);
		if (!actual || ["running", "dropped", "conflict"].includes(actual.status) || actual.head !== source.head || store.range(actual)[0] !== source.base) return `来源 #${source.id} 已变化、尚在运行或已丢弃，请重新集成。`;
		if (existsSync(actual.path)) {
			if (await integrationGit(actual.path, ["rev-parse", "HEAD"]) !== source.head || await integrationGit(actual.path, ["diff", "--name-only", "HEAD", "--"])) return `来源 #${source.id} 工作副本发生变化，请重新交付后集成。`;
			const untracked = await integrationGit(actual.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
			if (untracked.split("\0").some((file) => file && !actual.copied?.includes(file))) return `来源 #${source.id} 存在未交付的新文件，请完成交付后重建集成。`;
		}
	}
	if (checkWorkspace && (await workspaceTree(change.root)).tree !== integration.baselineTree) return "主目录已变化，联合检查基线已过期，请重新集成并验证。";
}

/** Compute one source delta in a private index; no main-workspace index or files change. */
export async function mergeIntegrationSource(change: ChangeRecord, source: { id: string; base: string; head: string }, index: number, snapshotConflict = false): Promise<{ head: string; conflicts: string[]; error?: string }> {
	if (!change.integration) throw new Error("缺少集成来源记录。");
	const directory = mkdtempSync(join(tmpdir(), "lemma-integration-index-"));
	const date = new Date(change.createdAt + index * 1000).toISOString();
	const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index"), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
	try {
		await integrationGit(change.path, ["read-tree", change.head], undefined, env);
		const patch = await git(change.root, ["diff", "--binary", "--no-color", "--no-renames", source.base, source.head]);
		if (patch.code) throw new Error(patch.stderr);
		if (!patch.stdout.trim()) return { head: change.head, conflicts: [] };
		const applied = await git(change.path, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], patch.stdout, env);
		if (applied.code) {
			await integrationGit(change.path, ["read-tree", change.head], undefined, env);
			const already = await git(change.path, ["apply", "--cached", "--reverse", "--check", "-"], patch.stdout, env);
			if (already.code === 0) return { head: change.head, conflicts: [] };
			// Preserve conflict markers only in the integration worktree for inspection or controlled repair.
			const actualRoot = await integrationGit(change.path, ["rev-parse", "--show-toplevel"]);
			if (resolve(actualRoot).toLowerCase() !== resolve(change.path).toLowerCase() || resolve(change.path).toLowerCase() === resolve(change.root).toLowerCase()) throw new Error("集成工作区路径验证失败。");
			const actual = await git(change.path, ["apply", "--3way", "--index", "--whitespace=nowarn", "-"], patch.stdout);
			const unresolved = await integrationGit(change.path, ["diff", "--name-only", "--diff-filter=U"]);
			const conflicts = unresolved ? unresolved.split("\n").filter(Boolean) : [];
			const errorText = (actual.stderr || applied.stderr || applied.stdout).trim().slice(-3000);
			if (!snapshotConflict) return { head: change.head, conflicts, error: errorText };
			// If even --3way could not write conflict markers (e.g. missing base blob), fall back to --reject or fail cleanly.
			if (!conflicts.length && !(await integrationGit(change.path, ["status", "--porcelain"]))) return { head: change.head, conflicts, error: errorText };
			await integrationGit(change.path, ["read-tree", change.head], undefined, env);
			await integrationGit(change.path, ["add", "-A"], undefined, env);
			const conflictTree = await integrationGit(change.path, ["write-tree"], undefined, env);
			const conflictHead = await integrationGit(change.path, ["-c", "user.name=Lemma", "-c", "user.email=lemma@localhost", "commit-tree", conflictTree, "-p", change.head, "-p", source.head, "-m", `Lemma integration conflict snapshot ${change.id}: ${source.id}`], undefined, env);
			await integrationGit(change.path, ["reset", "--hard", conflictHead]);
			return { head: conflictHead, conflicts: conflicts.length ? conflicts : (await integrationGit(change.root, ["diff", "--name-only", change.head, conflictHead])).split("\n").filter(Boolean) };
		}
		const tree = await integrationGit(change.path, ["write-tree"], undefined, env);
		if (tree === await integrationGit(change.root, ["rev-parse", `${change.head}^{tree}`])) return { head: change.head, conflicts: [] };
		const head = await integrationGit(change.path, ["-c", "user.name=Lemma", "-c", "user.email=lemma@localhost", "commit-tree", tree, "-p", change.head, "-p", source.head, "-m", `Lemma integration ${change.id}: ${source.id}\nSource: ${source.base}..${source.head}`], undefined, env);
		const actualHead = await integrationGit(change.path, ["rev-parse", "HEAD"]);
		if (![change.head, head].includes(actualHead)) throw new Error("集成工作区被外部提交修改，停止恢复，保留现场。");
		if (await integrationGit(change.path, ["status", "--porcelain"])) throw new Error("集成工作区出现未提交改动，停止覆盖，保留现场。");
		// This path is a generated, integration-owned worktree; never the source or main workspace.
		const actualRoot = await integrationGit(change.path, ["rev-parse", "--show-toplevel"]);
		if (resolve(actualRoot).toLowerCase() !== resolve(change.path).toLowerCase() || resolve(change.path).toLowerCase() === resolve(change.root).toLowerCase()) throw new Error("集成工作区路径验证失败。");
		await integrationGit(change.path, ["reset", "--hard", head]);
		return { head, conflicts: [] };
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Check whether any file modified between base and head still contains Git conflict markers. */
export async function findConflictMarkers(root: string, base: string, head: string): Promise<string[]> {
	const changed = await integrationGit(root, ["diff", "--name-only", "--diff-filter=ACMR", base, head]);
	if (!changed) return [];
	const flagged: string[] = [];
	for (const file of changed.split("\n").filter(Boolean)) {
		const content = await git(root, ["show", `${head}:${file}`]);
		if (content.code === 0 && /^(<{7}(?: .*)?|={7}|>{7}(?: .*)?)\r?$/m.test(content.stdout)) flagged.push(file);
	}
	return flagged;
}
