import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import { startAdmin } from "../src/admin.ts";
import { memberProvider } from "../src/api-member.ts";
import { addWorktree, commitAll, snapshot } from "../src/git.ts";
import { applyChange, dropChange, pendingChanges } from "../src/change-ops.ts";
import { Integrations } from "../src/integrations.ts";
import { integrationTerminal, mergeIntegrationSource } from "../src/integration-git.ts";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { check, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";
const ctx = BACKGROUND_CONTEXT, config = testConfig(), repo = config.workdir;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
git("init", "-q"); writeFileSync(join(repo, ".gitignore"), "*.sqlite*\nworktrees/\nintegrations/\ncalls.jsonl\n.pi-agent/\nignored-check-counter\n"); writeFileSync(join(repo, "README.md"), "# integration fixture\n"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
config.autonomy.checks = [{ name: "joint", command: "node", args: ["-e", "const f=require('fs'); if(f.readFileSync('left.txt','utf8')!=='LEFT' || f.readFileSync('right.txt','utf8')!=='RIGHT') process.exit(1)"] }];
const orch = fauxOrchestrator(); let app = await openApp(config, orch, ctx);
async function member(id: string, file: string, text: string, base?: string) {
	const start = base ?? await snapshot(repo), path = join(repo, "worktrees", id), branch = `codex/fixture-${id}`;
	await addWorktree(repo, path, branch, start); writeFileSync(join(path, file), text);
	const head = (await commitAll(path, id))!;
	return app.changes.upsert({ id, agent: "claude", callId: id, task: id, root: repo, subdir: "", path, branch, base: start, head, files: [{ path: file, add: 1, del: 0 }], add: 1, del: 0, status: "pending", createdAt: Date.now(), updatedAt: Date.now() });
}
async function wait(id: string) {
	const end = Date.now() + 15000; while (Date.now() < end) { const record = (await app.harness.snapshot(Integrations, ctx))?.records[id]; if (record && integrationTerminal(record)) return record; await new Promise((resolve) => setTimeout(resolve, 25)); }
	throw new Error(JSON.stringify(await app.harness.snapshot(Integrations, ctx)));
}
try {
	const originalHead = git("rev-parse", "HEAD"), originalIndex = git("diff", "--cached", "--name-only");
	const left = await member("left", "left.txt", "LEFT"), right = await member("right", "right.txt", "RIGHT");
	const first = await app.integrate(app.root.id, [left.id, right.id], ctx), record = await wait(first.id);
	assert.equal(record.integration!.status, "passed", JSON.stringify(record)); assert(record.integration!.reports[0]!.passed);
	assert(!existsSync(join(repo, "left.txt")) && !existsSync(join(repo, "right.txt")));
	assert.equal(git("rev-parse", "HEAD"), originalHead); assert.equal(git("diff", "--cached", "--name-only"), originalIndex);
	assert.equal(readFileSync(join(record.path, "left.txt"), "utf8"), "LEFT"); assert.equal(readFileSync(join(record.path, "right.txt"), "utf8"), "RIGHT");
	check(true, "多分支只在集成工作区合并并运行真实联合检查，主目录、分支和暂存区保持原样");
	assert(!(await applyChange(app.changes, left.id)).ok); assert(!pendingChanges(app.changes).some((change) => change.id === left.id));
	writeFileSync(join(repo, "unrelated.txt"), "new main edit");
	assert(!(await applyChange(app.changes, record.id)).ok);
	const { unlinkSync } = await import("node:fs"); unlinkSync(join(repo, "unrelated.txt"));
	writeFileSync(join(left.path, "left.txt"), "CHANGED_AFTER_CHECK");
	assert(!(await applyChange(app.changes, record.id)).ok); writeFileSync(join(left.path, "left.txt"), "LEFT");
	check(true, "来源或主目录变化后旧检查不能应用，apply all 不会绕过集成直接应用来源");
	await app.harness.close(ctx); app = await openApp(config, orch, ctx);
	assert.equal(app.changes.get(record.id)?.integration?.status, "passed");
	const applied = await applyChange(app.changes, record.id); assert(applied.ok, applied.message);
	assert.equal(readFileSync(join(repo, "left.txt"), "utf8"), "LEFT"); assert.equal(readFileSync(join(repo, "right.txt"), "utf8"), "RIGHT");
	assert.equal(app.changes.get(left.id)!.status, "applied"); assert.equal(git("rev-parse", "HEAD"), originalHead); assert.equal(git("diff", "--cached", "--name-only"), originalIndex);
	assert(!(await applyChange(app.changes, record.id)).ok);
	check(true, "重启保留联合检查证据，人工确认后整体应用并标记来源，不自动提交或重复应用");
	const a = await member("conflict-a", "conflict.txt", "A"), b = await member("conflict-b", "conflict.txt", "B");
	const conflict = await wait((await app.integrate(app.root.id, [a.id, b.id], ctx)).id);
	assert.equal(conflict.integration!.status, "conflict", JSON.stringify(conflict)); assert(conflict.integration!.conflicts?.includes("conflict.txt"));
	assert(!existsSync(join(repo, "conflict.txt"))); assert(!(await applyChange(app.changes, conflict.id)).ok);
	check(true, "合并冲突只保留在集成副本，记录冲突文件并禁止应用，不污染主目录");
	await dropChange(app.changes, conflict.id);
	config.autonomy.checks = [{ name: "fail", command: "node", args: ["-e", "console.error(" + JSON.stringify("JOINT_FAILURE_EVIDENCE") + ");process.exit(3)"] }];
	const c = await member("check-a", "check-a.txt", "A"), d = await member("check-b", "check-b.txt", "B");
	const failed = await wait((await app.integrate(app.root.id, [c.id, d.id], ctx)).id);
	assert.equal(failed.integration!.status, "failed"); assert(failed.integration!.reports[0]!.output.includes("JOINT_FAILURE_EVIDENCE")); assert(!(await applyChange(app.changes, failed.id)).ok);
	check(true, "联合检查失败保留退出码与完整尾部证据，失败集成不可应用");
	await dropChange(app.changes, failed.id);
	config.autonomy.checks = [{ name: "long", command: "node", args: ["-e", "setTimeout(()=>{},20000)"], timeoutSeconds: 30 }];
	const cancel = await app.integrate(app.root.id, [c.id, d.id], ctx);
	const cancelEnd = Date.now() + 10000; while (!app.jobs.running(`integration:${cancel.id}`) && Date.now() < cancelEnd) await new Promise((resolve) => setTimeout(resolve, 25));
	assert(app.jobs.running(`integration:${cancel.id}`)); await app.cancelIntegration(app.root.id, cancel.id, ctx);
	assert.equal((await wait(cancel.id)).integration!.status, "cancelled"); assert(!(await applyChange(app.changes, cancel.id)).ok);
	check(true, "运行中的联合检查可取消并终止子进程，取消状态持久保存且无法应用");
	await dropChange(app.changes, cancel.id);
	config.autonomy.checks = [{ name: "timeout", command: "node", args: ["-e", "setTimeout(()=>{},20000)"], timeoutSeconds: 0.2 }];
	const timeout = await wait((await app.integrate(app.root.id, [c.id, d.id], ctx)).id);
	assert.equal(timeout.integration!.status, "failed"); assert(timeout.message!.includes("超时"));
	check(true, "联合检查超时会停止命令并留下失败证据，不误报成功");
	await dropChange(app.changes, timeout.id);
	config.autonomy.checks = [{ name: "restart-once", command: "node", args: ["-e", "require('fs').appendFileSync('ignored-check-counter','1\\n');setTimeout(()=>{},20000)"], timeoutSeconds: 30 }];
	// Ignore only the fixture check counter; its existence reveals accidental replay.
	const e = await member("restart-a", "restart-a.txt", "A"), f = await member("restart-b", "restart-b.txt", "B");
	const restart = await app.integrate(app.root.id, [e.id, f.id], ctx);
	const restartEnd = Date.now() + 10000; while (!existsSync(join(restart.path, "ignored-check-counter")) && Date.now() < restartEnd) await new Promise((resolve) => setTimeout(resolve, 25));
	assert(existsSync(join(restart.path, "ignored-check-counter")));
	await app.harness.close(ctx); app = await openApp(config, orch, ctx); app.harness.resume();
	const restored = await wait(restart.id); assert.equal(restored.integration!.status, "failed"); assert(restored.message!.includes("中途被打断"), restored.message ?? "缺少中断依据");
	assert.equal(readFileSync(join(restored.path, "ignored-check-counter"), "utf8"), "1\n"); assert(!(await applyChange(app.changes, restored.id)).ok);
	check(true, "检查中途重启不重复执行未知结果的命令，不伪造通过，保留现场供用户重建集成");
	const replayPath = join(repo, "worktrees", "replay"), replayBranch = "codex/fixture-replay", base = await snapshot(repo);
	await addWorktree(repo, replayPath, replayBranch, base);
	const replayRecord = { ...restored, id: "replay", path: replayPath, branch: replayBranch, base, head: base };
	const source = { id: e.id, base: e.base, head: e.head };
	const once = await mergeIntegrationSource(replayRecord, source, 0), twice = await mergeIntegrationSource(replayRecord, source, 0);
	assert.equal(once.head, twice.head); assert(!twice.error);
	check(true, "合并后尚未提交 Durable 检查点时重放产生同一 Git 提交，不重复合并");

	// ---- rerunIntegration：被打断或基线变化后一键基于最新主目录重建验证 ----
	config.autonomy.checks = [{ name: "rerun-ok", command: "node", args: ["-e", "const f=require('fs');if(f.readFileSync('restart-a.txt','utf8')!=='A'||f.readFileSync('restart-b.txt','utf8')!=='B')process.exit(1)"] }];
	writeFileSync(join(repo, "main-note.txt"), "MAIN_UPDATED");
	const rerun = await wait((await app.rerunIntegration(app.root.id, restored.id, ctx)).id);
	assert.equal(rerun.integration!.status, "passed", JSON.stringify(rerun));
	assert.equal(rerun.integration!.replacesId, restored.id);
	assert.equal((await app.harness.snapshot(Integrations, ctx))!.records[restored.id]!.integration!.supersededBy, rerun.id);
	assert(!(await applyChange(app.changes, restored.id)).ok, "被替代的旧集成不可应用");
	assert(!pendingChanges(app.changes).some((ch) => ch.id === restored.id));
	const rerunApplied = await applyChange(app.changes, rerun.id);
	assert(rerunApplied.ok, rerunApplied.message);
	assert.equal(readFileSync(join(repo, "restart-a.txt"), "utf8"), "A");
	assert.equal(readFileSync(join(repo, "restart-b.txt"), "utf8"), "B");
	check(true, "rerun 基于更新后的主目录重建合并并重跑联合检查，旧记录自动归档不可应用");

	// ---- repairIntegration：三方合并冲突在独立修复副本解决并重过全量联合检查，不污染原来源分支 ----
	process.env.DEEPSEEK_API_KEY = "fixture-repair-key";
	config.agents.deepseek.enabled = true;
	config.agents.deepseek.models = [{ id: "faux-ds", tier: "standard" }];
	config.agents.deepseek.defaultModel = "faux-ds";
	await app.harness.close(ctx);
	app = await openApp(config, orch, ctx);
	const ds = fauxProvider({ provider: memberProvider("deepseek"), models: [{ id: "faux-ds" }] });
	orch.models.setProvider(ds.provider);
	writeFileSync(join(repo, "shared.ts"), "export const val = 'BASE';\n");
	git("add", "shared.ts");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", "commit", "-qm", "add shared.ts");
	config.autonomy.checks = [{ name: "verify-merged", command: "node", args: ["-e", "const s=require('fs').readFileSync('shared.ts','utf8');if(!s.includes('R1_AND_R2'))process.exit(1)"] }];
	const r1 = await member("repair-left", "shared.ts", "export const val = 'R1';\n");
	const r2 = await member("repair-right", "shared.ts", "export const val = 'R2';\n");
	const broken = await wait((await app.integrate(app.root.id, [r1.id, r2.id], ctx)).id);
	assert.equal(broken.integration!.status, "conflict");
	// 第一次修复故意残留冲突标记 -> 必须被拦截不能通过
	ds.setResponses([
		() => fauxAssistantMessage([fauxToolCall("write", { path: "shared.ts", content: "<<<<<<< HEAD\nR1_AND_R2\n=======\n>>>>>>> branch\n" }, { id: "bad1" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("故意保留了冲突标记")),
	]);
	const badRepair = await wait((await app.repairIntegration(app.root.id, broken.id, "deepseek", "先测试残留冲突拦截", ctx)).id);
	assert.equal(badRepair.integration!.status, "conflict", JSON.stringify(badRepair));
	assert(!(await applyChange(app.changes, badRepair.id)).ok);
	// 第二次修复读取带冲突标记的现场并正确合并 -> 重跑全量联合检查通过
	let sawMarkersInWorktree = false;
	ds.setResponses([
		() => fauxAssistantMessage([fauxToolCall("read", { path: "shared.ts" }, { id: "rd1" })], { stopReason: "toolUse" }),
		(req: any) => {
			const content = toolResults(req).at(-1)!.text;
			sawMarkersInWorktree = content.includes("<<<<<<<") && content.includes("R1") && content.includes("R2");
			return fauxAssistantMessage([fauxToolCall("write", { path: "shared.ts", content: "export const val = 'R1_AND_R2';\n" }, { id: "fix1" })], { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage(fauxText("已合并两侧改动为 R1_AND_R2")),
	]);
	const goodRepair = await wait((await app.repairIntegration(app.root.id, broken.id, "deepseek", "合并 R1 与 R2", ctx)).id);
	assert.equal(goodRepair.integration!.status, "passed", JSON.stringify(goodRepair));
	assert(sawMarkersInWorktree, "修复成员应看到三方冲突标记现场");
	assert.equal(readFileSync(join(r1.path, "shared.ts"), "utf8"), "export const val = 'R1';\n", "来源分支 1 未被污染");
	assert.equal(readFileSync(join(r2.path, "shared.ts"), "utf8"), "export const val = 'R2';\n", "来源分支 2 未被污染");
	assert(!(await applyChange(app.changes, goodRepair.integration!.repair!.changeId!)).ok, "内部修复副本不可绕过集成单独应用");

	// ---- 网页状态与合流拓扑同步验证 ----
	const admin = await startAdmin({ app, config, configPath: "test.json", orchestrator: { ...orch, describe: "faux" }, port: 0, context: ctx });
	try {
		const webState = await (await fetch(`${admin.url}/api/state`)).json() as any;
		assert.equal(typeof webState.workflow?.paused, "boolean");
		assert(Array.isArray(webState.readyTasks));
		assert(webState.integrations.some((it: any) => it.id === goodRepair.id && it.status === "passed"));
		const topo = await (await fetch(`${admin.url}/api/topology`)).json() as any;
		assert(topo.bars.some((b: any) => b.mode === "integration" && b.changeId === goodRepair.id));
		assert(topo.bars.some((b: any) => b.agent === "deepseek" && b.basedOn === goodRepair.id));
	} finally { await admin.close(); }

	const repairApplied = await applyChange(app.changes, goodRepair.id);
	assert(repairApplied.ok, repairApplied.message);
	assert.equal(readFileSync(join(repo, "shared.ts"), "utf8").replace(/\r\n/g, "\n"), "export const val = 'R1_AND_R2';\n");
	check(true, "冲突集成修复：拦截残留冲突标记，在独立副本解冲突并重过全量检查后应用，网页拓扑同步展示");
} finally { await app.harness.close(ctx); delete process.env.DEEPSEEK_API_KEY; }
