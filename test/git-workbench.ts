// GitLens 多仓库图谱、Agent 自主提交流转、关键风险人工网关与 Web 推送控制测试。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startAdmin } from "../src/admin.ts";
import { openApp } from "../src/app.ts";
import { GitWorkbench } from "../src/git-workbench.ts";
import { check, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const rootTmp = mkdtempSync(join(tmpdir(), "lemma-gitlens-"));
const bareRemote = join(rootTmp, "origin.git");
const peerClone = join(rootTmp, "peer");
const extRepo = join(rootTmp, "external-js");
const extRemote = join(rootTmp, "ext-origin.git");

const config = testConfig(join(rootTmp, "main-repo"));
const mainRepo = config.workdir;
mkdirSync(mainRepo, { recursive: true });
const gitRun = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();

execFileSync("git", ["init", "--bare", bareRemote], { windowsHide: true });
execFileSync("git", ["init", "--bare", extRemote], { windowsHide: true });
gitRun(mainRepo, "init", "-q", "-b", "main");
gitRun(mainRepo, "config", "user.name", "Tester");
gitRun(mainRepo, "config", "user.email", "tester@local");
writeFileSync(join(mainRepo, ".gitignore"), "*.sqlite*\ncalls.jsonl\nworktrees/\n.pi-agent/\n");
writeFileSync(join(mainRepo, "README.md"), "# main\n");
gitRun(mainRepo, "add", "-A");
gitRun(mainRepo, "commit", "-qm", "init main");
gitRun(mainRepo, "remote", "add", "origin", bareRemote);
gitRun(mainRepo, "push", "-qu", "origin", "main");
execFileSync("git", ["--git-dir", bareRemote, "symbolic-ref", "HEAD", "refs/heads/main"], { windowsHide: true });
execFileSync("git", ["clone", "-q", bareRemote, peerClone], { windowsHide: true });
gitRun(peerClone, "config", "user.name", "Peer");
gitRun(peerClone, "config", "user.email", "peer@local");

mkdirSync(extRepo, { recursive: true });
gitRun(extRepo, "init", "-q", "-b", "main");
gitRun(extRepo, "config", "user.name", "Tester");
gitRun(extRepo, "config", "user.email", "tester@local");
writeFileSync(join(extRepo, "index.js"), "export const x = 1;\n");
gitRun(extRepo, "add", "-A");
gitRun(extRepo, "commit", "-qm", "init ext");
gitRun(extRepo, "remote", "add", "origin", extRemote);
gitRun(extRepo, "push", "-qu", "origin", "main");
gitRun(extRepo, "remote", "add", "credtest", "https://user:SUPER_SECRET_TOKEN_123@example.invalid/org/repo.git");

config.autonomy = { enabled: false, maxRepairAttempts: 0, resultMaxChars: 4000, checks: [] };
const ctx = BACKGROUND_CONTEXT;
const orch = fauxOrchestrator();
const app = await openApp(config, orch, ctx);

// 挂入一条外部仓库改动记录，验证多仓库发现与隔离边界
const extHead = gitRun(extRepo, "rev-parse", "HEAD");
app.changes.upsert({
	id: "ext001", agent: "codex", callId: "c-ext", task: "更新外部仓库示例", root: extRepo, subdir: "",
	path: extRepo, branch: "main", base: extHead, head: extHead, files: [{ path: "index.js", add: 1, del: 0 }], add: 1, del: 0,
	status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
});

const admin = await startAdmin({ app, config, configPath: "test.json", orchestrator: { ...orch, describe: "faux" }, port: 0, context: ctx });

async function toolCall(name: string, args: JsonObject) {
	let reply: any;
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		(req: any) => { reply = toolResults(req).at(-1); return fauxAssistantMessage(fauxText("OK")); },
	]);
	await (await app.root.submit({ type: "input", content: name }, ctx)).wait(ctx);
	assert(reply);
	return reply;
}

try {
	// 1. 多仓库列表、凭证脱敏、越界路径拦截
	const reposRes = await (await fetch(`${admin.url}/api/git/repos`)).json() as any;
	assert.equal(reposRes.repos.length, 2);
	assert(!JSON.stringify(reposRes).includes("SUPER_SECRET_TOKEN_123"), "remote URL 必须脱敏隐藏凭据");
	const forbidRes = await fetch(`${admin.url}/api/git/graph?repo=${encodeURIComponent(rootTmp)}`);
	assert.equal(forbidRes.status, 403, "禁止访问未受管理的任意目录");
	check(true, "GitLens 多仓库自动发现、远端凭据脱敏与路径越界拦截 (403) 通过");

	// 2. 前端泳道算法测试（WORKTREE -> HEAD -> 分叉/合并）
	(globalThis as any).document = { querySelector: () => ({ addEventListener() {} }), addEventListener() {}, createElementNS: () => ({}), createElement: () => ({}) };
	(globalThis as any).location = { hash: "" };
	const origSetInterval = globalThis.setInterval;
	(globalThis as any).setInterval = () => 0;
	const glPath = "../web/js/gitlens.js";
	const { computeCommitLanes } = await import(glPath);
	globalThis.setInterval = origSetInterval;
	const laneOut = computeCommitLanes([
		{ sha: "WORKTREE", parents: ["c3"], isWorktree: true, changes: [] },
		{ sha: "c3", parents: ["c2", "b1"], changes: [] },
		{ sha: "b1", parents: ["c1"], changes: [{ agent: "codex" }] },
		{ sha: "c2", parents: ["c1"], changes: [] },
		{ sha: "c1", parents: [], changes: [] },
	]);
	assert.equal(laneOut.rows.length, 5);
	assert(laneOut.maxLanes >= 2);
	check(true, "GitLens 多泳道 SVG 布局算法通过");

	// 3. Agent 自主管理干净 Commit 与快进 Push
	writeFileSync(join(mainRepo, "feature.ts"), "export const ok = true;\n");
	const graphBefore = await (await fetch(`${admin.url}/api/git/graph`)).json() as any;
	assert.equal(graphBefore.working.length, 1);
	const wtDetail = await (await fetch(`${admin.url}/api/git/commit?sha=WORKTREE`)).json() as any;
	assert.equal(wtDetail.files[0].path, "feature.ts");
	assert(wtDetail.diff.includes("export const ok = true;"));

	const agCommit = await toolCall("repo_git", { action: "commit", message: "feat: add clean feature" });
	assert(!agCommit.isError, agCommit.text);
	const agPush = await toolCall("repo_git", { action: "push" });
	assert(!agPush.isError, agPush.text);
	assert.equal(gitRun(bareRemote, "rev-parse", "main"), gitRun(mainRepo, "rev-parse", "HEAD"));
	check(true, "Agent 可自主完成干净工作区 Commit 与无分叉快进 Push");

	// 4. 关键风险 1：敏感文件 (.env.local) 拦截为人工确认单，人工审批后才提交
	writeFileSync(join(mainRepo, ".env.local"), "API_KEY=demo_123\n");
	const envCommit = await toolCall("repo_git", { action: "commit", message: "oops env" });
	assert(envCommit.isError && envCommit.text.includes("关键人工确认单"), `unexpected envCommit: ${JSON.stringify(envCommit)}`);
	const stGates = await app.harness.snapshot(GitWorkbench, ctx);
	const envGate = Object.values(stGates!.gates).find((g) => g.status === "pending" && g.action === "commit");
	assert(envGate && envGate.files?.includes(".env.local"));
	const rejectEnv = await fetch(`${admin.url}/api/git/gates/${envGate.id}/resolve`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject", note: "不提交密钥文件" }),
	});
	assert.equal(rejectEnv.status, 200);
	rmSync(join(mainRepo, ".env.local"));
	check(true, "敏感文件自动触发关键人工确认单，支持网页端驳回");

	// 5. 关键风险 2：远端分叉 (behind > 0) 拦截 Agent 自动推送，Web 端返回 DIVERGED 并支持人工强制覆盖或批准
	gitRun(peerClone, "pull", "--ff-only", "-q");
	writeFileSync(join(peerClone, "peer.txt"), "from peer\n");
	gitRun(peerClone, "add", ".");
	gitRun(peerClone, "commit", "-qm", "peer ahead");
	gitRun(peerClone, "push", "-q", "origin", "main");
	writeFileSync(join(mainRepo, "local.ts"), "export const v = 2;\n");
	gitRun(mainRepo, "add", ".");
	gitRun(mainRepo, "commit", "-qm", "local diverge");

	const divPush = await toolCall("repo_git", { action: "push" });
	assert(divPush.isError && divPush.text.includes("关键人工确认单"), divPush.text);
	const webPushReject = await fetch(`${admin.url}/api/git/push`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
	});
	assert.equal(webPushReject.status, 409);
	const divBody = await webPushReject.json() as any;
	assert.equal(divBody.code, "DIVERGED");
	assert.equal(divBody.behind, 1);

	const divGate = Object.values((await app.harness.snapshot(GitWorkbench, ctx))!.gates).find((g) => g.status === "pending" && g.action === "force_push");
	assert(divGate);
	const approveDiv = await fetch(`${admin.url}/api/git/gates/${divGate.id}/resolve`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
	});
	assert.equal(approveDiv.status, 200);
	assert.equal(gitRun(bareRemote, "rev-parse", "main"), gitRun(mainRepo, "rev-parse", "HEAD"));
	check(true, "远端分叉自动拦截 Agent 并转入人工网关，Web 返回 DIVERGED 且人工批准 (--force-with-lease) 成功");

	// 6. 策略开关 (requireHumanPush) + 外部仓库 Commit & Push
	const polRes = await fetch(`${admin.url}/api/git/policy`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requireHumanPush: true }),
	});
	assert.equal(polRes.status, 200);
	writeFileSync(join(extRepo, "index.js"), "export const x = 2;\n");
	const extCommitRes = await fetch(`${admin.url}/api/git/commit`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: extRepo, message: "update ext", files: ["index.js"] }),
	});
	assert.equal(extCommitRes.status, 200);
	const extAgentPush = await toolCall("repo_git", { action: "push", repo: extRepo });
	assert(extAgentPush.isError && extAgentPush.text.includes("关键人工确认单"), extAgentPush.text);
	const policyGate = Object.values((await app.harness.snapshot(GitWorkbench, ctx))!.gates).find((g) => g.status === "pending" && g.action === "push");
	assert(policyGate);
	const approveExt = await fetch(`${admin.url}/api/git/gates/${policyGate.id}/resolve`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
	});
	assert.equal(approveExt.status, 200);
	assert.equal(gitRun(extRemote, "rev-parse", "main"), gitRun(extRepo, "rev-parse", "HEAD"));
	check(true, "人工确认策略开关与外部关联仓库 Commit/Push 全流程通过");
} finally {
	await admin.close();
	await app.harness.close(ctx);
	try { rmSync(rootTmp, { recursive: true, force: true }); } catch {}
}
