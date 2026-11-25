// 工作区隔离 + 改动追踪 + 选模型 + 预算：用一个临时 git 仓库和模拟 CLI 走完整流程。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { applyChange, dropChange } from "../src/change-ops.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
process.env.FAKE_AGENT_WRITE = "1"; // 让模拟 CLI 在临时仓库的 worktree 里真的写文件
const repo = config.workdir;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();

// 一个小仓库：已提交的文件 + 一个还没提交的改动 + 被忽略的依赖目录
writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.sqlite*\ncalls.jsonl\nworktrees/\n");
git("init", "-q");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
writeFileSync(join(repo, "app.ts"), "export const a = 2; // 未提交的改动\n");
writeFileSync(join(repo, "new-module.ts"), "export const untracked = true;\n");
const originalIndex = git("diff", "--cached", "--name-only");
writeFileSync(join(repo, "CLAUDE.md"), "# 刚写、还没提交的项目说明\n");
mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");

config.agents.claude.models = [
	{ id: "cheap-model", tier: "economy" },
	{ id: "good-model", tier: "standard" },
];
config.agents.claude.defaultModel = "good-model";
config.agents.codex.models = [{ id: "codex-model", tier: "standard", price: { input: 1, output: 10 } }];
config.agents.codex.defaultModel = "codex-model";
config.budget.perRunUsd = 0.02;

const orch = fauxOrchestrator();
const app = await openApp(config, orch, context);
const { harness, root, changes } = app;

let results: ReturnType<typeof toolResults> = [];
const capture = (ctx: any) => {
	results = toolResults(ctx);
	return fauxAssistantMessage(fauxText("ok"));
};
const ask = async (text: string) => (await root.submit({ type: "input", content: text }, context)).wait(context);

// ---- 1. 模型白名单 + 隔离：Claude 在 worktree 里写文件 ----
orch.faux.setResponses([
	fauxAssistantMessage(
		[
			fauxToolCall("ask_claude", { task: "写设计", model: "cheap-model" }, { id: "a1" }),
			fauxToolCall("ask_claude", { task: "用不存在的模型", model: "gpt-x" }, { id: "a2" }),
		],
		{ stopReason: "toolUse" },
	),
	capture,
]);
await ask("第一轮");
const ok = results.find((r) => r.text.includes("CLAUDE_OK"));
const bad = results.find((r) => r.text.includes("没有配置模型"));
check(ok && !ok.isError, "Claude 派工成功");
check(bad?.isError && bad.text.includes("cheap-model"), "清单外的模型被拒绝，并列出可选模型");
const call = fakeCalls(config).find((c) => c.kind === "claude")!;
check(call.args.includes("--model") && call.args[call.args.indexOf("--model") + 1] === "cheap-model", "选的模型通过 --model 传给了 CLI");
check(ok!.text.includes("模型: cheap-model"), "结果里写明了实际用的模型");

const first = changes.list()[0]!;
check(first && first.status === "pending" && first.files.some((f) => f.path.startsWith("docs/notes-")), "改动被提交到独立分支，状态是待合并");
check(call.cwd.toLowerCase().startsWith(first.path.toLowerCase()), "CLI 在 worktree 里运行，而不是主目录");
check(!existsSync(join(repo, "docs")), "主目录没有被改动");
check(readFileSync(join(first.path, "app.ts"), "utf8").includes("未提交的改动"), "worktree 以快照开工，包含主目录里还没提交的改动");
check(readFileSync(join(first.path, "new-module.ts"), "utf8").includes("untracked"), "快照包含未跟踪的新模块，成员不会因为漏文件反复修复");
check(git("diff", "--cached", "--name-only") === originalIndex, "创建快照不修改用户暂存区");
check(existsSync(join(first.path, "node_modules", "dep", "index.js")), "被忽略的依赖目录挂进了 worktree");
check(readFileSync(join(first.path, "CLAUDE.md"), "utf8").includes("还没提交的项目说明"), "还没提交的规范文件（CLAUDE.md）也带进了 worktree");
check(git("branch", "--list", first.branch).includes(first.branch), `分支 ${first.branch} 已创建`);
check(ok!.text.includes(`改动 #${first.id}`), "结果里告诉总调度改动编号和合并方式");
check(git("log", "-1", "--format=%s", first.branch) === "pi-agent(claude): 写设计", "worktree 的提交标题是「成员 + 任务首句」");

// ---- 2. based_on：Codex 在 Claude 的改动基础上开工；估算花费计入预算 ----
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_codex", { task: "接着实现", based_on: first.id }, { id: "b1" })], { stopReason: "toolUse" }),
	capture,
]);
await ask("第二轮");
const second = changes.list().find((c) => c.basedOn === first.id)!;
check(second && readdirSync(join(second.path, "docs")).some((f) => f.startsWith("notes-")), "based_on：新 worktree 里能看到上一次改动的文件");
check(second.files.every((f) => !f.path.startsWith("docs/")), "based_on 的改动只统计它自己新增的部分");
const codexResult = results.filter((r) => r.name === "ask_codex").at(-1)!;
check(/花费: \$0\.\d+（估算）/.test(codexResult.text), "Codex 不自报花费时按单价估算");

// ---- 3. 预算：同一次运行里串行派工，超过上限后被拒绝 ----
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_codex", { task: "第一步" }, { id: "c1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxToolCall("ask_codex", { task: "第二步" }, { id: "c2" })], { stopReason: "toolUse" }),
	capture,
]);
await ask("第三轮");
const blocked = results.find((r) => r.text.includes("花费已达上限"));
check(blocked?.isError, "同一次运行花费超过上限后，后续派工被拒绝");

// ---- 4. 合并与丢弃 ----
const applied = await applyChange(changes, first.id);
check(applied.ok && readdirSync(join(repo, "docs")).some((f) => f.startsWith("notes-")), "/apply 把改动应用到主目录");
check(readFileSync(join(repo, "app.ts"), "utf8").includes("未提交的改动"), "合并没有冲掉主目录里原有的未提交改动");
check(changes.get(first.id)!.status === "applied", "改动状态变成已合并");
const again = await applyChange(changes, first.id);
check(!again.ok, "已合并的改动不会重复合并");
const dropped = await dropChange(changes, second.id);
check(dropped.ok && !existsSync(second.path) && !git("branch", "--list", second.branch), "/drop 删除了 worktree 和分支");

// ---- 5. request_apply：交互确认合并（先校验验收，再由用户弹窗同意或拒批）----
const third = changes.list().find((c) => c.status === "pending")!;
check(!!third, "存在第三轮生成的待合并改动");
config.autonomy = { enabled: true, maxRepairAttempts: 0, resultMaxChars: 4000, checks: [{ name: "未验不可弹合并", command: "node", args: ["-v"] }] };
let promptCalled = false;
app.confirmApply = async () => { promptCalled = true; return { approvedIds: [third.id] }; };
orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("request_apply", { changes: [third.id] }, { id: "ra1" })], { stopReason: "toolUse" }), capture]);
await ask("第四轮");
check(results.find((r) => r.name === "request_apply")?.isError && !promptCalled, "验收未通过时 request_apply 提前拒绝，不会弹出确认");

config.autonomy.enabled = false;
app.confirmApply = undefined;
orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("request_apply", { changes: [third.id] }, { id: "ra2" })], { stopReason: "toolUse" }), capture]);
await ask("第五轮");
check(JSON.parse(results.findLast((r) => r.name === "request_apply")!.text).status === "deferred" && changes.get(third.id)!.status === "pending", "无交互终端时 request_apply 返回 deferred，不私自合并");

app.confirmApply = async () => ({ approvedIds: [] });
orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("request_apply", { changes: [third.id] }, { id: "ra3" })], { stopReason: "toolUse" }), capture]);
await ask("第六轮");
check(JSON.parse(results.findLast((r) => r.name === "request_apply")!.text).status === "rejected" && changes.get(third.id)!.status === "pending", "用户在确认框暂不合并时保留改动");

app.confirmApply = async (req) => {
	check(req.summary === "仅保留有效实现" && req.items.length === 1 && req.items[0]!.id === third.id, "确认框收到精确的改动摘要与清单");
	return { approvedIds: [third.id] };
};
orch.faux.setResponses([fauxAssistantMessage([fauxToolCall("request_apply", { changes: [third.id], summary: "仅保留有效实现" }, { id: "ra4" })], { stopReason: "toolUse" }), capture]);
await ask("第七轮");
const raOk = JSON.parse(results.findLast((r) => r.name === "request_apply")!.text);
check(raOk.status === "applied" && raOk.results[0].ok && changes.get(third.id)!.status === "applied", "用户同意合并后 request_apply 立即应用到工作区并标为已合并");

await harness.close(context);
console.log("\n工作区隔离测试通过 ✅");
