// Web 控制与配置接口测试：成员增改（密钥只写不漏）、并发/总控配置、workflow/apply/clean/operations/recover 与拓扑任务图数据。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startAdmin } from "../src/admin.ts";
import { openApp } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { loadConfig } from "../src/config.ts";
import { readCredential } from "../src/credentials.ts";
import { addWorktree, commitAll, numstat, snapshot } from "../src/git.ts";
import { createOrchestratorModel } from "../src/models.ts";
import { Operations } from "../src/operations.ts";
import { check, fauxOrchestrator, testConfig } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "lemma-web-ctrl-"));
const oldCredFile = process.env.LEMMA_CREDENTIALS_FILE;
process.env.LEMMA_CREDENTIALS_FILE = join(dir, "secrets/credentials.json");

const configPath = join(dir, "config.json");
const baseSeed = testConfig(dir);
writeFileSync(configPath, JSON.stringify({
	workdir: dir,
	storage: join(dir, "session.sqlite"),
	agents: {
		claude: { enabled: true, command: baseSeed.agents.claude.command, extraArgs: [], models: [{ id: "claude-s", tier: "standard" }, { id: "claude-p", tier: "premium" }], defaultModel: "claude-s" },
		codex: { enabled: false, command: baseSeed.agents.codex.command, extraArgs: [] },
		gemini: { enabled: false, command: baseSeed.agents.gemini.command, extraArgs: [] },
		deepseek: { enabled: false },
	},
	orchestrator: { type: "openai-compatible", baseUrl: "https://orch.invalid/v1", modelId: "orch-one" },
}));

const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
writeFileSync(join(dir, ".gitignore"), "*.sqlite*\nsecrets/\nworktrees/\nconfig.json\n");
writeFileSync(join(dir, "app.ts"), "export const v = 1;\n");
git("init", "-q");
git("config", "core.autocrlf", "false");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

let config = loadConfig(configPath);
const orchestrator = fauxOrchestrator();
let app = await openApp(config, orchestrator, BACKGROUND_CONTEXT);
let busy = false;
const notes: string[] = [];

const admin = await startAdmin({
	app,
	config,
	configPath,
	orchestrator: { ...orchestrator, describe: "faux" },
	port: 0,
	context: BACKGROUND_CONTEXT,
	session: { id: "s1", title: "测试会话", controllerId: String(app.root.id) },
	notify: (line) => notes.push(line),
	settings: {
		path: configPath,
		config: () => config,
		assertIdle: async () => { if (busy) throw new Error("有会话正在执行任务，请先等待完成或 /abort all，再修改团队配置。"); },
		commit: async (draft, next, controller) => {
			const apply = app.prepareMembers(next);
			draft.save();
			apply();
			config = next;
			if (controller) assert(createOrchestratorModel(next.orchestrator).models.getModel("orchestrator", next.orchestrator.modelId));
			await admin.rebind({
				app,
				config,
				configPath,
				orchestrator: { ...orchestrator, describe: "faux" },
				port: Number(new URL(admin.url).port),
				context: BACKGROUND_CONTEXT,
				session: { id: "s1", title: "测试会话", controllerId: String(app.root.id) },
				notify: (line) => notes.push(line),
				settings: {
					path: configPath,
					config: () => config,
					assertIdle: async () => { if (busy) throw new Error("有会话正在执行任务，请先等待完成或 /abort all，再修改团队配置。"); },
					commit: async (d, n, c) => {
						const fn = app.prepareMembers(n); d.save(); fn(); config = n;
						if (c) assert(createOrchestratorModel(n.orchestrator).models.getModel("orchestrator", n.orchestrator.modelId));
					},
				},
			});
		},
	},
});

async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; data: any; raw: string }>((resolve, reject) => {
		const req = request(admin.url + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
		}, (res) => {
			let text = "";
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				let parsed: any;
				try { parsed = JSON.parse(text); } catch { parsed = null; }
				resolve({ status: res.statusCode!, data: parsed, raw: text });
			});
		});
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

try {
	assert.equal((await call("/js/dag.js")).status, 200);
	assert.equal((await call("/js/editors.js")).status, 200);
	assert.equal((await call("/api/message", { text: "hi" })).status, 404);
	assert.equal((await call("/api/agents", { id: "x" }, { origin: "https://evil.example" })).status, 403);
	assert.equal((await call("/api/workflow", { action: "pause" }, { origin: "https://evil.example" })).status, 403);
	check(true, "静态资源、任务只走终端(404)与跨站控制拒止(403)正常");

	// 1. 新增 API 成员（含本机加密凭据，永不回显）
	const addRes = await call("/api/agents", {
		expectedSession: "s1",
		id: "reviewer_web",
		name: "Web 盲审员",
		description: "只读盲审代码",
		instructions: "仅看 git_diff 提问题",
		type: "openai-compatible",
		baseUrl: "https://api.example.invalid/v1",
		defaultModel: "r-model-1",
		workspace: "code",
		tools: ["read"],
		secret: "WEB_SECRET_FIXTURE_999",
	});
	assert.equal(addRes.status, 200);
	assert.equal(addRes.data.id, "reviewer_web");

	const st1 = (await call("/api/state")).data;
	assert.equal(st1.canEditSettings, true);
	const added = st1.agents.find((a: any) => a.kind === "reviewer_web");
	assert.ok(added, "新增成员出现在 /api/state");
	assert.equal(added.api.baseUrl, "https://api.example.invalid/v1");
	assert.equal(added.api.hasCredential, true);
	assert.deepEqual(added.api.builtinTools, ["read"]);
	assert(!JSON.stringify(st1).includes("WEB_SECRET_FIXTURE_999"), "状态接口绝不泄漏明文密钥");
	assert(!readFileSync(configPath, "utf8").includes("WEB_SECRET_FIXTURE_999"), "config.json 不存明文密钥");
	assert.equal(readCredential(config.agents.reviewer_web!.api!.credential), "WEB_SECRET_FIXTURE_999");
	assert((await app.root.agent(BACKGROUND_CONTEXT)).tools.some((t) => t.name === "ask_reviewer_web"));
	check(true, "网页端新增 API 成员：立即进入运行态、密钥加密落盘且全程零明文回显");

	// 2. 编辑与快捷启停/切模型
	const quickRes = await call("/api/agents/claude", { expectedSession: "s1", quick: true, enabled: false, defaultModel: "claude-p" });
	assert.equal(quickRes.status, 200);
	assert.equal(config.agents.claude.enabled, false);
	assert.equal(config.agents.claude.defaultModel, "claude-p");
	assert.equal((await call("/api/agents/claude", { expectedSession: "s1", quick: true, secret: "nope" })).status, 400);

	const editRes = await call("/api/agents/reviewer_web", {
		expectedSession: "s1",
		name: "Web 盲审员 v2",
		description: "升级版只读盲审",
		instructions: "补充规范检查",
		type: "openai-compatible",
		baseUrl: "https://api.example.invalid/v2",
		defaultModel: "r-model-2",
		workspace: "code",
		tools: ["read"],
		enabled: true,
	});
	assert.equal(editRes.status, 200);
	assert.equal(config.agents.reviewer_web!.description, "升级版只读盲审");
	assert.equal(readCredential(config.agents.reviewer_web!.api!.credential), "WEB_SECRET_FIXTURE_999", "留空密钥保留原凭据");

	busy = true;
	assert.equal((await call("/api/limits", { expectedSession: "s1", maxConcurrent: 4 })).status, 409);
	busy = false;

	assert.equal((await call("/api/limits", { expectedSession: "s1", maxConcurrent: 6, perMember: 2, perService: 3, perRunUsd: 1.5, reservePerDispatchUsd: 0.05 })).status, 200);
	assert.equal(config.execution?.maxConcurrent, 6);
	assert.equal(config.budget.perRunUsd, 1.5);

	assert.equal((await call("/api/orchestrator", { expectedSession: "s1", type: "openai-compatible", baseUrl: "https://orch.invalid/v2", modelId: "orch-two", secret: "ORCH_WEB_KEY_888" })).status, 200);
	assert.equal(config.orchestrator.modelId, "orch-two");
	assert.equal(readCredential(config.orchestrator.credential), "ORCH_WEB_KEY_888");
	assert(!JSON.stringify((await call("/api/state")).data).includes("ORCH_WEB_KEY_888"));
	check(true, "网页端快捷启停、API 成员编辑、并发预算与总控修改生效且忙碌保护 (409) 正常");

	// 3. workflow pause/resume + /api/topology 任务图字段
	assert.equal((await call("/api/workflow", { expectedSession: "s1", action: "pause" })).data.paused, true);
	assert.equal((await call("/api/state")).data.workflow.paused, true);
	assert.equal((await call("/api/workflow", { expectedSession: "s1", action: "resume" })).data.paused, false);
	assert.equal((await call("/api/state")).data.workflow.paused, false);

	await app.harness.commit(async (tx) => {
		const b = await tx.doc(Board);
		const now = Date.now();
		b.order = ["T1", "T2"];
		b.tasks.T1 = {
			id: "T1", title: "冻结契约与实现", status: "done", deps: [], changes: [], notes: [], dispatches: [],
			scope: { allow: ["src/"], forbid: ["test/"] },
			reviewer: { member: "reviewer_web", blind: true },
			checksByMember: [{ status: "accepted", member: "reviewer_web", sourceResultId: "res-1", evidence: "通过", at: now }],
			createdAt: now, updatedAt: now,
		};
		b.tasks.T2 = {
			id: "T2", title: "编写独立测试", status: "blocked", deps: ["T1"], changes: [], notes: [], dispatches: [],
			scope: { allow: ["test/"], forbid: ["src/"] },
			controllerId: String(app.root.id),
			lastAttempt: { callId: "c-last", controllerId: String(app.root.id), dispatchTaskId: "1", member: "claude", task: "x" },
			recoveries: [{ id: "rec-1", controllerId: String(app.root.id), action: "supply", member: "claude", note: "补充背景", fromResult: null, originalTask: "x", status: "prepared", at: now, previousStatus: "blocked" }],
			createdAt: now, updatedAt: now,
		};
	}, BACKGROUND_CONTEXT);

	const topo = (await call("/api/topology")).data;
	assert.equal(topo.tasks.length, 2);
	assert.equal(topo.tasks[0].reviewer.blind, true);
	assert.deepEqual(topo.tasks[0].scope.allow, ["src/"]);
	const cancelRec = await call("/api/tasks/T2/recover", { expectedSession: "s1", action: "cancel", note: "撤销恢复计划" });
	assert.equal(cancelRec.status, 200);
	assert.equal((await app.harness.snapshot(Board, BACKGROUND_CONTEXT))!.tasks.T2!.recoveries![0]!.status, "cancelled");
	check(true, "workflow 开关、topology DAG 数据下发与任务恢复取消接口正常");

	// 4. 外部操作核对与改动 Apply / Clean
	await app.harness.commit(async (tx) => {
		const ops = await tx.doc(Operations);
		ops.operations["op-1"] = {
			id: "op-1", member: "reviewer_web", tool: "submit_pr", method: "POST", endpoint: "https://api.example.invalid/pr",
			argumentsHash: "abc", taskId: "999999", conversationId: "s1", status: "unknown", createdAt: Date.now(), updatedAt: Date.now(),
		};
	}, BACKGROUND_CONTEXT);
	const opRes = await call("/api/operations/op-1/resolve", { expectedSession: "s1", outcome: "succeeded", evidence: "控制台确认编号 #42" });
	assert.equal(opRes.status, 200);
	assert.equal((await call("/api/state")).data.operations[0].resolution.outcome, "succeeded");

	const base = await snapshot(dir);
	const wtPath = join(dir, "worktrees", "web-test");
	const branch = "lemma/web-test";
	await addWorktree(dir, wtPath, branch, base);
	writeFileSync(join(wtPath, "app.ts"), "export const v = 2;\n");
	const head = (await commitAll(wtPath, "apply from web"))!;
	const files = await numstat(dir, base, head);
	app.changes.upsert({
		id: "c1", agent: "claude", callId: "call-1", task: "更新版本号", root: dir, subdir: ".", path: wtPath, branch,
		base, head, files, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0), status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
	});
	const applyRes = await call("/api/changes/c1/apply", { expectedSession: "s1" });
	assert.equal(applyRes.status, 200);
	assert.equal(readFileSync(join(dir, "app.ts"), "utf8").trim(), "export const v = 2;");
	const cleanRes = await call("/api/changes/clean", { expectedSession: "s1" });
	assert.equal(cleanRes.status, 200);
	assert(notes.some((n) => n.includes("已新增成员")));
	check(true, "外部操作人工核对、改动 Apply 到主目录、Clean worktree 与终端通知均通过");

	console.log("\n网页配置与协作控制测试全部通过 ✅");
} finally {
	await admin.close();
	if (oldCredFile === undefined) delete process.env.LEMMA_CREDENTIALS_FILE;
	else process.env.LEMMA_CREDENTIALS_FILE = oldCredFile;
	try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
