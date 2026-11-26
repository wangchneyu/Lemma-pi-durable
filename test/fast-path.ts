// 自适应快慢路径测试：干净工作区免 snapshot、总调度只读直查、readonly 免建 worktree、/fast 单跳快路与自动升级。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { memberProvider } from "../src/api-member.ts";
import { snapshot } from "../src/git.ts";
import { check, fauxOrchestrator, testConfig } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const toolNames = (ctx: any): string[] =>
	ctx.messages.filter((m: any) => m.role === "system").flatMap((m: any) => (m.toolsAdded ?? []).map((t: any) => t.name));

const config = testConfig();
const repo = config.workdir;
const runGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
writeFileSync(join(repo, "app.ts"), "export const version = 1;\nexport function greet(name: string) { return `hi ${name}`; }\n");
writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.sqlite*\ncalls.jsonl\nworktrees/\n");
runGit("init", "-q");
runGit("add", "-A");
runGit("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
const head = runGit("rev-parse", "HEAD");

// 1. 干净工作区 snapshot() 直接返回 HEAD；脏工作区仍生成独立快照提交
const cleanSnap = await snapshot(repo);
check(cleanSnap === head, "干净工作区 snapshot() 直接复用 HEAD，跳过临时索引扫描");

writeFileSync(join(repo, "dirty.txt"), "uncommitted\n", "utf8");
const dirtySnap = await snapshot(repo);
check(dirtySnap !== head, "存在未跟踪文件时 snapshot() 仍生成独立快照提交");
rmSync(join(repo, "dirty.txt"));

// 2. 配置 DeepSeek API 成员 + faux 总控
config.agents.deepseek.models = [{ id: "faux-ds", tier: "economy", note: "编码", price: { input: 0.1, output: 0.2 } }];
config.agents.deepseek.defaultModel = "faux-ds";
process.env.DEEPSEEK_API_KEY = "test-placeholder-not-a-real-key";

const orch = fauxOrchestrator();
const app = await openApp(config, orch, context);
const ds = fauxProvider({ provider: memberProvider("deepseek"), models: [{ id: "faux-ds" }] });
orch.models.setProvider(ds.provider);

try {
	// 3. 总调度具备 5 个只读代码感知工具（无 write/edit/bash），0 派工直接回答仓库问题
	let orchTools: string[] = [];
	orch.faux.setResponses([
		(ctx: any) => {
			orchTools = toolNames(ctx);
			return fauxAssistantMessage([fauxToolCall("outline_file", { path: "app.ts" }, { id: "ro-1" })], { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage(fauxText("app.ts 定义了 version 和 greet 函数（只读直查完成）。")),
	]);
	const beforeChanges = app.changes.list().length;
	await (await app.root.submit({ type: "input", content: "app.ts 里定义了什么？" }, context)).wait(context);
	check(["list_files", "search_code", "git_diff", "outline_file", "find_symbol"].every((t) => orchTools.includes(t)), "总调度具备 5 个只读代码感知工具");
	check(!orchTools.includes("write") && !orchTools.includes("edit") && !orchTools.includes("bash"), "总调度仍严格禁止 write/edit/bash 写入工具");
	check(app.changes.list().length === beforeChanges, "总调度只读直查 0 派工、0 worktree 创建");

	// 4. ask_deepseek({ readonly: true }) 免建 worktree 且物理拦截 write 操作
	let blockedWriteText = "";
	orch.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "只读检查 app.ts", readonly: true }, { id: "ro-ask-1" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("只读审查完成。")),
	]);
	ds.setResponses([
		() => fauxAssistantMessage([fauxToolCall("write", { path: "app.ts", content: "hacked" }, { id: "mw-1" })], { stopReason: "toolUse" }),
		(ctx: any) => {
			const last = ctx.messages.at(-1);
			blockedWriteText = Array.isArray(last?.content) ? last.content.map((b: any) => b.text ?? "").join("") : String(last?.content ?? "");
			return fauxAssistantMessage(fauxText("已只读查看 app.ts。"));
		},
	]);
	await (await app.root.submit({ type: "input", content: "让 DeepSeek 只读看一下 app.ts" }, context)).wait(context);
	check(blockedWriteText.includes("只读模式"), "readonly:true 派工在工具层物理拦截 API 成员的 write 操作");
	check(app.changes.list().length === beforeChanges, "readonly:true 派工未创建新 worktree 或改动分支");

	// 5. app.fastDispatch：零总调度往返直通成员，单文件改动直接弹窗 confirmApply 并一键合并
	let confirmPrompts = 0;
	app.confirmApply = async (req) => {
		confirmPrompts++;
		return { approvedIds: req.items.map((item) => item.id) };
	};
	ds.setResponses([
		() => fauxAssistantMessage([fauxToolCall("write", { path: "app.ts", content: "export const version = 2;\nexport function greet(name: string) { return `hello ${name}`; }\n" }, { id: "fp-1" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("已将 version 升级到 2。")),
	]);
	const fast1 = await app.fastDispatch(app.root.id, "把 app.ts 的 version 改成 2", { member: "deepseek" });
	check(fast1.member === "deepseek" && !fast1.escalated && fast1.filesCount === 1, "fastDispatch 单文件改动不触发升级（filesCount=1）");
	check(confirmPrompts === 1 && fast1.applied === true, "fastDispatch 单文件改动直接弹出 confirmApply 并一键合并到主目录");
	check(readFileSync(join(repo, "app.ts"), "utf8").includes("version = 2"), "主目录 app.ts 已反映快路合并结果");

	// 6. app.fastDispatch：修改超过 2 个文件时自动升级（escalated=true），不自动弹窗合并，保留在隔离分支
	ds.setResponses([
		() => fauxAssistantMessage([
			fauxToolCall("write", { path: "f1.ts", content: "export const a = 1;\n" }, { id: "fp-e1" }),
			fauxToolCall("write", { path: "f2.ts", content: "export const b = 2;\n" }, { id: "fp-e2" }),
			fauxToolCall("write", { path: "f3.ts", content: "export const c = 3;\n" }, { id: "fp-e3" }),
		], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("新建了 3 个文件。")),
	]);
	const fast2 = await app.fastDispatch(app.root.id, "新增 f1/f2/f3 三个模块", { member: "deepseek" });
	check(fast2.filesCount === 3 && fast2.escalated === true, "fastDispatch 改动超过 2 个文件时自动升级（escalated=true）");
	check(confirmPrompts === 1 && fast2.applied === undefined, "自动升级后不跳过审查直接弹合并，改动安全保留在独立分支");
	check(fast2.result.text.includes("快路自动升级"), "返回文本包含明确的快路自动升级提示");

	console.log("\n自适应快慢路径测试全部通过 ✅");
} finally {
	await app.harness.close(context);
	delete process.env.DEEPSEEK_API_KEY;
}
