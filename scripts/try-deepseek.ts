// 实测 DeepSeek 成员：在一个临时 git 仓库里，让它真的写代码、跑测试（总调度用假模型，只花 DeepSeek 的钱）。
//   DEEPSEEK_API_KEY=... node --no-warnings scripts/try-deepseek.ts [模型]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const context = BACKGROUND_CONTEXT;
const model = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), "pi-agent-ds-"));
const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", windowsHide: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ds-try", type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(join(dir, ".gitignore"), "*.sqlite*\nworktrees/\n");
git("init", "-q");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

const config = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
config.workdir = dir;
config.storage = join(dir, "session.sqlite");
for (const k of ["claude", "codex", "gemini"] as const) config.agents[k].enabled = false;

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-orchestrator" }] });
const models = createModels();
models.setProvider(faux.provider);
let result = "";
faux.setResponses([
	() =>
		fauxAssistantMessage(
			[
				fauxToolCall(
					"ask_deepseek",
					{
						task: "在 math.js 里实现并导出 add(a, b) 和 mul(a, b)；再写 math.test.js，用 node:test 和 node:assert 测这两个函数；最后运行 npm test 确认通过。",
						...(model ? { model } : {}),
					},
					{ id: "try1" },
				),
			],
			{ stopReason: "toolUse" },
		),
	(ctx: any) => {
		result = ctx.messages.filter((m: any) => m.role === "toolResult").at(-1)?.content?.map((b: any) => b.text ?? "").join("") ?? "";
		return fauxAssistantMessage(fauxText("ok"));
	},
]);
const app = await openApp(config, { models, ref: { provider: "faux", modelId: "faux-orchestrator" } }, context);
const started = Date.now();
await (await app.root.submit({ type: "input", content: "试一下 DeepSeek" }, context)).wait(context);
console.log(`\n—— DeepSeek 的结果（${Math.round((Date.now() - started) / 1000)}s）——\n${result}\n`);
const change = app.changes.list().find((c) => c.agent === "deepseek");
if (change) {
	for (const f of ["math.js", "math.test.js"]) console.log(`${f}: ${existsSync(join(change.path, f)) ? "已写入 worktree" : "没有"}`);
	if (existsSync(join(change.path, "math.js"))) console.log(`\nmath.js:\n${readFileSync(join(change.path, "math.js"), "utf8")}`);
	try {
		console.log(execFileSync("npm", ["test"], { cwd: change.path, encoding: "utf8", shell: true, windowsHide: true }).split("\n").filter((l) => /^(ℹ|#) (pass|fail) /.test(l)).join("  "));
	} catch (e: any) {
		console.log(`npm test 失败：${String(e.stdout ?? e.message).slice(-400)}`);
	}
}
await app.harness.close(context);
console.log(`\n临时仓库：${dir}`);
