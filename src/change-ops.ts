// 改动的合并 / 丢弃：只在终端里由用户触发（网页只看）。
import type { ChangeRecord, ChangeStore } from "./changes.ts";
import { applyRange, removeWorktree } from "./git.ts";

export interface OpResult {
	ok: boolean;
	message: string;
}

function find(store: ChangeStore, id: string): ChangeRecord | undefined {
	return id ? store.get(id) : undefined;
}

/** 待处理的改动：有文件改动、还没合并也没丢弃 */
export function pendingChanges(store: ChangeStore): ChangeRecord[] {
	return store.list().filter((c) => c.status === "pending" || c.status === "conflict");
}

export async function applyChange(store: ChangeStore, id: string): Promise<OpResult> {
	const c = find(store, id);
	if (!c) return { ok: false, message: `找不到改动 ${id}` };
	if (c.status === "running") return { ok: false, message: `改动 #${c.id} 还在进行中，等它完成再合并` };
	if (c.status === "dropped") return { ok: false, message: `改动 #${c.id} 已经丢弃` };
	if (c.status === "applied" || c.status === "empty") return { ok: false, message: `改动 #${c.id} 没有需要合并的内容` };
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
