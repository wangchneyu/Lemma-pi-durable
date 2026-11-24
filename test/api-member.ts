// API 成员（DeepSeek）：用 faux 模型代替真实 API，检查它在 Pi Durable 子对话里真的用 read / write / edit / bash 干活：
// 在隔离的 worktree 里写文件、bash 白名单、总调度拿不到读写工具、续接同一个会话、后台派工、花费统计。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { bashRefusal, memberProvider } from "../src/api-member.ts";
import { check, fauxOrchestrator, testConfig, toolResults } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
/** 这次请求提供给模型的工具（pi-ai 把工具声明放在 system 消息的 toolsAdded 里） */
const toolNames = (ctx: any): string[] =>
	ctx.messages.filter((m: any) => m.role === "system").flatMap((m: any) => (m.toolsAdded ?? []).map((t: any) => t.name));
const config = testConfig();
const repo = config.workdir;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.sqlite*\ncalls.jsonl\nworktrees/\n");
git("init", "-q");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

// ---- 白名单（纯函数） ----
const api = config.agents.deepseek.api!;
check(bashRefusal("npm test", api) === undefined && bashRefusal("git diff --stat", api) === undefined, "白名单里的命令放行");
check(!!bashRefusal("rm -rf src", api), "白名单外的命令被拒绝");
check(!!bashRefusal("npm test && rm -rf src", api) && !!bashRefusal("cat a > b", api) && !!bashRefusal("ls $(whoami)", api), "串接、重定向、命令替换被拒绝");
check(!!bashRefusal("npm testing", api), "只按整个词匹配命令开头");

// ---- 没有密钥 / 没有模型时不可用 ----
delete process.env.DEEPSEEK_API_KEY;
{
	const { detectAgents } = await import("../src/tools.ts");
	const ds = detectAgents(config).find((a) => a.kind === "deepseek")!;
	check(!ds.available && /模型/.test(ds.reason ?? ""), "没配模型时 DeepSeek 不可用，并说明原因");
	config.agents.deepseek.models = [{ id: "faux-ds", tier: "economy", note: "测试", price: { input: 1, output: 2 } }];
	config.agents.deepseek.defaultModel = "faux-ds";
	const again = detectAgents(config).find((a) => a.kind === "deepseek")!;
	check(!again.available && /DEEPSEEK_API_KEY/.test(again.reason ?? ""), "没有密钥时不可用，并说明要设哪个环境变量");
}
process.env.DEEPSEEK_API_KEY = "test-placeholder-not-a-real-key";

const orch = fauxOrchestrator();
const { harness, root, changes, agents } = await openApp(config, orch, context);
check(agents.find((a) => a.kind === "deepseek")?.available === true, "配了模型和密钥后 DeepSeek 可用");
// 用 faux 模型替换真实的 DeepSeek provider（同一个 provider 名），不发任何网络请求
const ds = fauxProvider({ provider: memberProvider("deepseek"), models: [{ id: "faux-ds" }] });
orch.models.setProvider(ds.provider);

// ---- 1. 同步派工：子对话里写文件、bash 被白名单拦下、汇报 ----
let orchTools: string[] = [];
let memberTools: string[] = [];
let refused = "";
let firstPrompt = "";
let dsResult = "";
ds.setResponses([
	(ctx: any) => {
		memberTools = toolNames(ctx);
		firstPrompt = ctx.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join(""))).join("\n");
		return fauxAssistantMessage(
			[fauxText("先写文件。"), fauxToolCall("write", { path: "hello.ts", content: "export const hello = 'ds';\n" }, { id: "w1" }), fauxToolCall("bash", { command: "rm -rf app.ts" }, { id: "b1" })],
			{ stopReason: "toolUse" },
		);
	},
	(ctx: any) => {
		refused = toolResults(ctx).find((r) => r.name === "bash")?.text ?? "";
		return fauxAssistantMessage([fauxToolCall("edit", { path: "app.ts", edits: [{ oldText: "a = 1", newText: "a = 42" }] }, { id: "e1" })], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage(fauxText("DS_OK：新建 hello.ts，把 a 改成 42。rm 命令被拒绝了，没有执行。")),
]);
orch.faux.setResponses([
	(ctx: any) => {
		orchTools = toolNames(ctx);
		return fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "新建 hello.ts，把 a 改成 42" }, { id: "d1" })], { stopReason: "toolUse" });
	},
	(ctx: any) => {
		dsResult = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage(fauxText("好"));
	},
]);
await (await root.submit({ type: "input", content: "让 DeepSeek 改代码" }, context)).wait(context);
check(orchTools.includes("ask_deepseek") && !orchTools.includes("write") && !orchTools.includes("bash"), "总调度有 ask_deepseek，但没有读写工具");
check(["read", "write", "edit", "bash", "list_files", "search_code", "git_diff", "outline_file", "find_symbol"].every((t) => memberTools.includes(t)) && !memberTools.includes("ask_deepseek"), "DeepSeek 编码子对话具备读写、bash 及 ACI 代码感知工具（list_files / search_code / git_diff / outline_file / find_symbol）");
check(firstPrompt.includes("新建 hello.ts"), "任务交给了 DeepSeek 子对话");
check(refused.includes("不在允许清单"), "白名单外的 bash 命令在子对话里被拒绝");
check(dsResult.includes("DS_OK") && /\[改动 #\w+：2 个文件/.test(dsResult), `结果带回 DeepSeek 的回答和隔离改动（${dsResult.match(/\[改动[^\]]*\]/)?.[0]}）`);
const sid = dsResult.match(/session_id: ([\w-]+)/)?.[1];
check(!!sid, "结果带回 session_id（子对话编号）");
check(/花费: \$0\.\d+/.test(dsResult), "按配置的单价算出花费");
const change = changes.list().find((c) => c.agent === "deepseek")!;
check(existsSync(join(change.path, "hello.ts")) && readFileSync(join(change.path, "app.ts"), "utf8").includes("a = 42"), "文件写在 worktree 里");
check(readFileSync(join(repo, "app.ts"), "utf8").includes("a = 1;") && !existsSync(join(repo, "hello.ts")), "主目录没有被改");

// ---- 2. 续接同一个会话：子对话里能看到上一轮 ----
let sawHistory = false;
ds.setResponses([
	(ctx: any) => {
		sawHistory = JSON.stringify(ctx.messages).includes("新建 hello.ts") && JSON.stringify(ctx.messages).includes("再加一个导出");
		return fauxAssistantMessage(fauxText("DS_OK2"));
	},
]);
let second = "";
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "再加一个导出", session_id: sid! }, { id: "d2" })], { stopReason: "toolUse" }),
	(ctx: any) => {
		second = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage(fauxText("好"));
	},
]);
await (await root.submit({ type: "input", content: "继续" }, context)).wait(context);
check(sawHistory && second.includes("DS_OK2") && second.includes(`session_id: ${sid}`), "续接回到同一个子对话（看得到上一轮）");

// ---- 2b. 读写只限工作目录：越界的 write / read 被拦下，文件没有写到外面 ----
const outside = join(repo, "..", `pi-agent-escape-${Date.now().toString(36)}.txt`);
let blocked: { name: string; text: string; isError: boolean }[] = [];
ds.setResponses([
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: outside, content: "x" }, { id: "x1" }),
				fauxToolCall("write", { path: "../escape-rel.txt", content: "x" }, { id: "x2" }),
				fauxToolCall("read", { path: "/mnt/d/tmp/whatever.txt" }, { id: "x3" }),
				fauxToolCall("bash", { command: "cat ../../secret.txt" }, { id: "x4" }),
				fauxToolCall("write", { path: "inside.txt", content: "ok" }, { id: "x5" }),
			],
			{ stopReason: "toolUse" },
		),
	(ctx: any) => {
		blocked = toolResults(ctx).slice(-5);
		return fauxAssistantMessage(fauxText("DS_ESCAPE_DONE"));
	},
]);
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "试试写到外面" }, { id: "d9" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("好")),
]);
await (await root.submit({ type: "input", content: "越界测试" }, context)).wait(context);
check(blocked.slice(0, 3).every((r) => r.isError && r.text.includes("工作目录之外")), "写到工作目录外（绝对路径、..、Unix 路径）和读外面的文件都被拦下");
check(blocked[3]?.isError && blocked[3].text.includes("不能用绝对路径、~ 或 .."), "bash 参数里的 .. 也被拦下");
check(!blocked[4]?.isError, "工作目录里的写入正常");
check(!existsSync(outside) && !existsSync(join(repo, "..", "escape-rel.txt")), "工作目录外没有出现文件");
const escapeChange = changes.list().find((c) => c.agent === "deepseek" && c.task === "试试写到外面");
check(!!escapeChange && existsSync(join(escapeChange.path, "inside.txt")), "工作目录里的文件写进了它的 worktree");

// ---- 3. 后台派工 ----
ds.setResponses([() => fauxAssistantMessage(fauxText("DS_BG_OK"))]);
let waited = "";
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "后台写测试", background: true }, { id: "d3" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage([fauxToolCall("wait_jobs", { mode: "all" }, { id: "w9" })], { stopReason: "toolUse" }),
	(ctx: any) => {
		waited = toolResults(ctx).at(-1)!.text;
		return fauxAssistantMessage(fauxText("好"));
	},
]);
await (await root.submit({ type: "input", content: "后台" }, context)).wait(context);
check(/【后台结果 J\d+ · 完成】deepseek/.test(waited) && waited.includes("DS_BG_OK"), "DeepSeek 也能放到后台，wait_jobs 收到结果");

// ---- 4. 只读代码感知工具（list_files / search_code / git_diff / outline_file / find_symbol）及越界拦截 ----
let inspectResults: { name: string; text: string; isError: boolean }[] = [];
ds.setResponses([
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall("list_files", {}, { id: "c1" }),
				fauxToolCall("search_code", { query: "a = 42" }, { id: "c2" }),
				fauxToolCall("git_diff", {}, { id: "c3" }),
				fauxToolCall("search_code", { query: "secret", path: "../" }, { id: "c4" }),
				fauxToolCall("outline_file", { path: "hello.ts" }, { id: "c5" }),
				fauxToolCall("find_symbol", { symbol: "hello" }, { id: "c6" }),
			],
			{ stopReason: "toolUse" },
		),
	(ctx: any) => {
		inspectResults = toolResults(ctx).slice(-6);
		return fauxAssistantMessage(fauxText("DS_CODE_TOOLS_OK"));
	},
]);
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "查看当前代码结构与改动差异", session_id: sid! }, { id: "d4" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("好")),
]);
await (await root.submit({ type: "input", content: "代码感知测试" }, context)).wait(context);
check(!inspectResults[0]?.isError && inspectResults[0]!.text.includes("app.ts") && inspectResults[0]!.text.includes("hello.ts"), "list_files 返回 worktree 文件列表");
check(!inspectResults[1]?.isError && inspectResults[1]!.text.includes("app.ts:1:") && inspectResults[1]!.text.includes("a = 42"), "search_code 返回匹配文件与行号");
check(!inspectResults[2]?.isError && inspectResults[2]!.text.includes("-export const a = 1;") && inspectResults[2]!.text.includes("+export const a = 42;"), "git_diff 返回相对于基线的真实补丁");
check(!!inspectResults[3]?.isError && inspectResults[3]!.text.includes("工作目录之外"), "代码检索工具同样拦截越界路径");
check(!inspectResults[4]?.isError && inspectResults[4]!.text.includes("hello.ts") && inspectResults[4]!.text.includes("L1: export const hello"), "outline_file 返回代码结构大纲与行号");
check(!inspectResults[5]?.isError && inspectResults[5]!.text.includes("【定义处") && inspectResults[5]!.text.includes("hello.ts:1:"), "find_symbol 定位符号定义与引用");

// ---- 5. 编辑后即时语法诊断（write/edit 写入错误 TS/JSON 语法时立即反馈，无需等到收尾检查） ----
let syntaxDiagMsg = "";
let jsonDiagMsg = "";
ds.setResponses([
	() => fauxAssistantMessage([
		fauxToolCall("write", { path: "broken.ts", content: "export const bad: number = ;\n" }, { id: "syn1" }),
		fauxToolCall("write", { path: "bad.json", content: "{ invalid json" }, { id: "syn2" }),
	], { stopReason: "toolUse" }),
	(ctx: any) => {
		const res = toolResults(ctx).slice(-2);
		syntaxDiagMsg = res[0]?.text ?? "";
		jsonDiagMsg = res[1]?.text ?? "";
		return fauxAssistantMessage([
			fauxToolCall("write", { path: "broken.ts", content: "export const bad: number = 1;\n" }, { id: "syn3" }),
			fauxToolCall("write", { path: "bad.json", content: "{\"ok\":true}\n" }, { id: "syn4" }),
		], { stopReason: "toolUse" });
	},
	() => fauxAssistantMessage(fauxText("SYNTAX_FIXED")),
]);
orch.faux.setResponses([
	() => fauxAssistantMessage([fauxToolCall("ask_deepseek", { task: "测试编辑后即时语法诊断", session_id: sid! }, { id: "d5" })], { stopReason: "toolUse" }),
	() => fauxAssistantMessage(fauxText("好")),
]);
await (await root.submit({ type: "input", content: "即时语法诊断测试" }, context)).wait(context);
check(syntaxDiagMsg.includes("即时语法诊断") && syntaxDiagMsg.includes("broken.ts"), "write 写入 TS 语法错误时立即返回即时语法诊断");
check(jsonDiagMsg.includes("即时语法诊断") && jsonDiagMsg.includes("JSON 语法错误"), "write 写入无效 JSON 时立即返回 JSON 诊断");

await harness.close(context);
console.log("\nAPI 成员测试通过 ✅");
