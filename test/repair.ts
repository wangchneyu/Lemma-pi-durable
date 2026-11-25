import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { Learning, relevantLessons } from "../src/learning.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const config = testConfig();
const repo = config.workdir;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
writeFileSync(join(repo, "app.txt"), "original\n");
writeFileSync(join(repo, ".gitignore"), "*.sqlite*\ncalls.jsonl\nworktrees/\n.pi-agent/\n");
git("init", "-q"); git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
process.env.FAKE_AGENT_WRITE = "1";
process.env.FAKE_AGENT_DELAY_MS = "40";
config.autonomy = { enabled: true, maxRepairAttempts: 2, resultMaxChars: 1500, checks: [{ name: "第二次派工后通过", command: "node", args: ["-e", `const f=require('fs');const calls=f.readFileSync(${JSON.stringify(join(repo, "calls.jsonl"))},'utf8').trim().split(String.fromCharCode(10));if(calls.length<2){console.error('ASSERTION_FAILED: fix required');process.exit(1);}`] }] };
const context = BACKGROUND_CONTEXT;
const orch = fauxOrchestrator();
const app = await openApp(config, orch, context);
try {
	let result = "";
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "修复购物车模块" }, { id: "r1" })], { stopReason: "toolUse" }),
		(ctx: any) => { result = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("验收完成")); },
	]);
	await (await app.root.submit({ type: "input", content: "修复购物车" }, context)).wait(context);
	const calls = fakeCalls(config);
	assert.equal(calls.length, 2, result);
	assert.equal(calls[0]!.cwd, calls[1]!.cwd);
	assert.ok(calls[1]!.args.includes("--resume") && calls[1]!.prompt.includes("ASSERTION_FAILED"));
	assert.ok(result.includes("自动修复 1/2") && result.includes("配置验收"));
	assert.ok(app.changes.list().some((c) => c.verification?.passed && c.verification.head === c.head));
	assert.ok(!existsSync(join(repo, "docs")));
	const learned = await app.harness.snapshot(Learning, context);
	assert.equal(learned?.lessons.length, 1);
	assert.ok(relevantLessons(learned!.lessons, "修复购物车模块").includes("修复购物车"));
	assert.equal(relevantLessons(learned!.lessons, "completely unrelated zebra"), "");
	check(true, "验收失败后在同一隔离会话修复，重新检查通过才保存记录");

	config.autonomy.checks = [{ name: "始终失败的验收", command: "node", args: ["-e", "console.error('EXPECTED_FAILURE');process.exit(1)"] }];
	let blocked = "";
	const before = fakeCalls(config).length;
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "无法通过的修复" }, { id: "r2" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("ask_claude", { task: "无法通过的修复" }, { id: "r3" })], { stopReason: "toolUse" }),
		(ctx: any) => { blocked = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("停止")); },
	]);
	await (await app.root.submit({ type: "input", content: "验证修复上限" }, context)).wait(context);
	assert.equal(fakeCalls(config).length - before, 3);
	assert.ok(blocked.includes("耗尽"));
	assert.equal((await app.harness.snapshot(Learning, context))?.lessons.length, 1);
	check(true, "最多两次自动修复，同轮重复派工被拦截，失败不保存为成功经验");
	config.budget.perRunUsd = 0.001;
	const budgetBefore = fakeCalls(config).length;
	let budgetResult = "";
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "预算不足时的修复" }, { id: "r4" })], { stopReason: "toolUse" }),
		(ctx: any) => { budgetResult = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("预算停止")); },
	]);
	await (await app.root.submit({ type: "input", content: "验证预算保护" }, context)).wait(context);
	assert.equal(fakeCalls(config).length - budgetBefore, 1);
	assert.ok(budgetResult.includes("已达上限"));
	check(true, "首轮花费超预算后，不再启动自动修复");
	config.budget.perRunUsd = 3;
	let rejectedDone = "";
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("plan_tasks", { tasks: [{ title: "验收失败不准完成" }] }, { id: "p5" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "不能绕过失败", task_id: "T1" }, { id: "r5" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("update_task", { id: "T1", status: "done", note: "尝试绕过失败检查" }, { id: "d5" })], { stopReason: "toolUse" }),
		(ctx: any) => { rejectedDone = toolResults(ctx).at(-1)!.text; return fauxAssistantMessage(fauxText("保持未完成")); },
	]);
	await (await app.root.submit({ type: "input", content: "验证不能直接标成功" }, context)).wait(context);
	assert.match(rejectedDone, /不能完成|未通过|没有成功/);
	assert.notEqual((await app.harness.snapshot((await import("../src/board.ts")).Board, context))!.tasks.T1!.status, "done");
	check(true, "验收失败时，调度无法直接把任务标完成来绕过检查");

	config.autonomy.checks = [{ name: "长时间验收", command: "node", args: ["-e", "setTimeout(()=>{},30000)"] }];
	let job = "";
	const cancellationCalls = fakeCalls(config).length;
	orch.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_claude", { task: "取消时不自动重试", background: true }, { id: "r6" })], { stopReason: "toolUse" }),
		(ctx: any) => { job = toolResults(ctx).at(-1)!.text.match(/开工 (J\d+)/)![1]!; return fauxAssistantMessage(fauxText("后台运行")); },
	]);
	await (await app.root.submit({ type: "input", content: "验证用户取消" }, context)).wait(context);
	for (let i = 0; i < 150 && !app.jobs.recent(job).some((line) => line.includes("验收：")); i++) await new Promise((r) => setTimeout(r, 30));
	assert.ok(app.jobs.recent(job).some((line) => line.includes("验收：")));
	await app.jobs.cancel(job, "orchestrator", context);
	for (let i = 0; i < 150 && app.jobs.running(job); i++) await new Promise((r) => setTimeout(r, 30));
	assert.ok(!app.jobs.running(job));
	assert.equal(fakeCalls(config).length - cancellationCalls, 1);
	check(true, "后台验收可取消，取消后不再自动派工修复");
	config.autonomy.checks = [{ name: "prepare reassignment failure", command: "node", args: ["-e", "process.exit(1)"] }];
	config.budget.perRunUsd = 3;
	const tools = async (name: string, args: any) => { let reply: any; orch.faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), (request: any) => { reply = toolResults(request).at(-1); return fauxAssistantMessage(fauxText("OK")); }]); await (await app.root.submit({ type: "input", content: name }, context)).wait(context); assert(reply); return reply; };
	await tools("plan_tasks", { tasks: [{ title: "保留代码成果换成员恢复", acceptance: "original acceptance retained" }] });
	await tools("ask_claude", { task: "KEEP_CODE_ON_REASSIGN", task_id: "T2" });
	const { Board } = await import("../src/board.ts");
	const original = (await app.harness.snapshot(Board, context))!.tasks.T2!, originalChange = original.lastAttempt!.changeId!; assert(originalChange);
	config.agents.codex.models = [{ id: "fixture-code", tier: "standard" }];
	const beforeRecovery = fakeCalls(config).length;
	config.autonomy.checks = [{ name: "one recovery repair passes", command: "node", args: ["-e", `if(require('fs').readFileSync(${JSON.stringify(join(repo, "calls.jsonl"))},'utf8').trim().split(String.fromCharCode(10)).length<${beforeRecovery + 2})process.exit(1)`] }];
	const prepared = await tools("recover_task", { id: "T2", action: "reassign", member: "codex", note: "Continue existing code and correct remaining check" }); assert(!prepared.isError, prepared.text);
	const plan = JSON.parse(prepared.text); assert.equal(plan.dispatch.based_on, originalChange);
	const recovered = await tools("ask_codex", plan.dispatch); assert(!recovered.isError, recovered.text); assert(recovered.text.includes("自动修复 1/2"));
	const task = (await app.harness.snapshot(Board, context))!.tasks.T2!; assert.equal(task.status, "review"); assert.equal(task.recoveries!.at(-1)!.status, "finished"); assert.equal(task.acceptance, "original acceptance retained"); assert.equal(fakeCalls(config).length - beforeRecovery, 2);
	assert(app.changes.list().some((change) => change.basedOn === originalChange && change.verification?.passed));
	check(true, "代码恢复换成员基于原工作分支，原生返工续接仍可通过验收，恢复计划最终收尾");
	assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "original\n");

	// ---- 跨仓库派工：不误跑主仓库检查；目标仓库自配检查仍会生效 ----
	const extPlain = mkdtempSync(join(tmpdir(), "lemma-ext-plain-"));
	const extConfigured = mkdtempSync(join(tmpdir(), "lemma-ext-cfg-"));
	try {
		for (const dir of [extPlain, extConfigured]) {
			writeFileSync(join(dir, "app.txt"), "ext\n");
			writeFileSync(join(dir, ".gitignore"), ".pi-agent/\n");
			execFileSync("git", ["-C", dir, "init", "-q"], { windowsHide: true });
			execFileSync("git", ["-C", dir, "add", "-A"], { windowsHide: true });
			execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { windowsHide: true });
		}
		writeFileSync(join(extConfigured, "pi-agent.config.json"), JSON.stringify({
			autonomy: { checks: [{ name: "ext-fail-check", command: "node", args: ["-e", "console.error('EXT_CHECK_RAN');process.exit(1)"] }] },
		}));
		config.autonomy.checks = [{ name: "主仓库检查不应在外部仓库触发", command: "node", args: ["-e", "process.exit(1)"] }];
		config.autonomy.maxRepairAttempts = 0;

		await tools("plan_tasks", {
			tasks: [
				{ title: "外部纯 JS 仓库任务", acceptance: "external plain repo ok" },
				{ title: "外部带配置仓库任务", acceptance: "external configured repo fails own check" },
			],
		});
		const extPlainRes = await tools("ask_codex", { task: "修改外部无配置仓库", cwd: extPlain, task_id: "T3" });
		assert(!extPlainRes.isError, extPlainRes.text);
		assert(extPlainRes.text.includes("已跳过主工作区验收检查"), extPlainRes.text);
		const t3Result = (await app.harness.snapshot(Board, context))!.tasks.T3!.latestResult;
		assert(t3Result);
		const acceptPlain = await tools("review_task", { id: "T3", action: "accept", result_id: t3Result, evidence: "external plain check skipped safely" });
		assert(!acceptPlain.isError, acceptPlain.text);
		assert.equal((await app.harness.snapshot(Board, context))!.tasks.T3!.status, "done");

		const extCfgRes = await tools("ask_codex", { task: "修改外部带配置仓库", cwd: extConfigured, task_id: "T4" });
		assert(extCfgRes.isError, "目标仓库自有检查失败时仍应报错");
		assert(extCfgRes.text.includes("EXT_CHECK_RAN"), extCfgRes.text);
		check(true, "跨仓库派工按目标仓库隔离 autonomy.checks：无配置跳过主仓库检查，有配置按目标仓库检查执行");
	} finally {
		for (const dir of [extPlain, extConfigured]) {
			try { rmSync(dir, { recursive: true, force: true }); } catch {}
		}
	}
} finally { await app.harness.close(context); }
