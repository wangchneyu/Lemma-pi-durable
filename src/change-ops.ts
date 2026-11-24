// 改动的合并 / 丢弃：只在终端里由用户触发（网页只看）。
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { applyRange, removeWorktree, git } from "./git.ts";
import { integrationStale, integrationGit } from "./integration-git.ts";

export interface OpResult {
	ok: boolean;
	message: string;
}

function find(store: ChangeStore, id: string): ChangeRecord | undefined {
	return id ? store.get(id) : undefined;
}

/** 待处理的改动：有文件改动、还没合并也没丢弃（已被新集成替代或由集成覆盖的来源/修复副本不单独重复列出） */
export function pendingChanges(store: ChangeStore): ChangeRecord[] {
	const bundles = store.list().filter((c) => c.integration && !c.integration.supersededBy && !["applied", "dropped"].includes(c.status));
	const covered = new Set(bundles.flatMap((c) => [...c.integration!.sources.map((source) => source.id), ...(c.integration!.repair?.changeId ? [c.integration!.repair.changeId] : [])]));
	return store.list().filter((c) => (c.status === "pending" || c.status === "conflict") && !c.integration?.supersededBy && (!covered.has(c.id) || !!c.integration));
}

export async function applyChange(store: ChangeStore, id: string): Promise<OpResult> {
	const c = find(store, id);
	if (!c) return { ok: false, message: `找不到改动 ${id}` };
	if (c.status === "running") return { ok: false, message: `改动 #${c.id} 还在进行中，等它完成再合并` };
	if (c.status === "dropped") return { ok: false, message: `改动 #${c.id} 已经丢弃` };
	if (c.status === "applied" || c.status === "empty") return { ok: false, message: `改动 #${c.id} 没有需要合并的内容` };
	const parent = store.list().find((bundle) => bundle.integration && !bundle.integration.supersededBy && !["applied", "dropped"].includes(bundle.status) && (bundle.integration.sources.some((source) => source.id === c.id) || bundle.integration.repair?.changeId === c.id));
	if (parent) return { ok: false, message: `改动 #${c.id} 属于集成 #${parent.id}，请检查并应用集成结果；要单独应用需先 /drop ${parent.id}。` };
	if (c.integration) {
		if (c.integration.supersededBy) return { ok: false, message: `集成 #${c.id} 已被新集成 #${c.integration.supersededBy} 替代，请检查并应用新集成结果。` };
		if (c.integration.status !== "passed" || !c.verification?.passed || c.verification.head !== c.head || c.integration.reports.length !== c.integration.checks.length || c.integration.reports.some((report) => !report.passed)) return { ok: false, message: "联合集成尚未完整通过检查，不能应用。" };
		const stale = await integrationStale(store, c); if (stale) return { ok: false, message: stale };
		if (await integrationGit(c.path, ["rev-parse", "HEAD"]) !== c.head || await integrationGit(c.path, ["status", "--porcelain"])) return { ok: false, message: "集成工作区在验证后发生变化，拒绝应用旧的测试结论。" };
		const patch = await git(c.root, ["diff", "--binary", "--no-color", "--no-renames", c.base, c.head]);
		if (patch.code) return { ok: false, message: patch.stderr };
		if (patch.stdout.trim()) {
			const canApply = await git(c.root, ["apply", "--check", "--whitespace=nowarn", "-"], patch.stdout);
			if (canApply.code) return { ok: false, message: `主目录无法无冲突应用，未修改文件：${canApply.stderr}` };
			const result = await git(c.root, ["apply", "--whitespace=nowarn", "-"], patch.stdout);
			if (result.code) return { ok: false, message: result.stderr };
		}
		store.upsert({ ...c, status: "applied", appliedHead: c.head, message: "联合验证改动已应用到主目录，等待人工提交。" });
		for (const source of c.integration.sources) { const item = store.get(source.id); if (item?.head === source.head) store.upsert({ ...item, status: "applied", appliedHead: source.head, message: `已随集成 #${c.id} 应用。` }); }
		if (c.integration.repair?.changeId) { const fix = store.get(c.integration.repair.changeId); if (fix && fix.head === c.head) store.upsert({ ...fix, status: "applied", appliedHead: fix.head, message: `已随集成 #${c.id} 应用。` }); }
		return { ok: true, message: `集成 #${c.id} 已整体应用，${c.integration.sources.length} 项来源标为已应用；主目录未自动提交。` };
	}
	const [from, to] = store.range(c);
	const r = await applyRange(c.root, from, to);
	if (!r.ok) {
		store.upsert({ ...c, status: "conflict", message: r.message });
		return {
			ok: false,
			message: `改动 #${c.id} 和主目录当前的内容冲突，没有应用：\n${r.message}\n可以让成员基于最新代码重做，或者手动处理（分支 ${c.branch}）。`,
		};
	}
	store.upsert({ ...c, status: "applied", appliedHead: c.head, message: r.message });
	return { ok: true, message: `改动 #${c.id} ${r.message}（${c.files.length} 个文件 +${c.add} −${c.del}，没有提交，请检查后自行 commit）` };
}

export async function dropChange(store: ChangeStore, id: string): Promise<OpResult> {
	const c = find(store, id);
	if (!c) return { ok: false, message: `找不到改动 ${id}` };
	if (c.status === "running") return { ok: false, message: `改动 #${c.id} 还在进行中，先中止本轮再丢弃` };
	if (c.status === "dropped") return { ok: false, message: `改动 #${c.id} 已经丢弃过了` };
	await removeWorktree(c.root, c.path, c.branch);
	store.upsert({ ...c, status: "dropped" });
	return { ok: true, message: `已丢弃改动 #${c.id}，删除了 worktree 和分支 ${c.branch}` };
}

/** 清理：已合并 / 没改动的改动，删掉 worktree 和分支（之后不能再续接它们的会话） */
export async function cleanChanges(store: ChangeStore): Promise<OpResult> {
	const targets = store.list().filter((c) => c.status === "applied" || c.status === "empty");
	for (const c of targets) {
		await removeWorktree(c.root, c.path, c.branch);
		store.upsert({ ...c, status: "dropped", message: c.status === "applied" ? "已合并，worktree 已清理" : "没有改动，worktree 已清理" });
	}
	return { ok: true, message: targets.length ? `清理了 ${targets.length} 个 worktree` : "没有需要清理的 worktree" };
}
