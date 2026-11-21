// 模拟本机 AI CLI（测试和演示模式用）：node fake-agent.mjs <claude|codex|gemini> [CLI 参数...]
// 按各 CLI 的真实输出格式打印，执行过程分几步输出进度，并把每次调用追加到 FAKE_AGENT_LOG（JSONL）。
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
const base = Number(process.env.FAKE_AGENT_DELAY_MS ?? 200);
// 演示模式下让每次耗时有些差别（测试里不抖动，时序可预期）
const delay = process.env.FAKE_AGENT_JITTER === "1" ? base * (0.55 + Math.random() * 0.9) : base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const task = prompt.trim().slice(0, 60);

const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

if (process.env.FAKE_AGENT_LOG) {
	appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ kind, args, prompt, pid: process.pid, cwd: process.cwd() })}\n`);
}

// 把总延迟分给几个步骤，让界面能看到进度滚动
const steps = (n) => sleep(delay / n);
const model = flag("--model") ?? flag("-m");
const slug = Date.now().toString(36).slice(-5);

/**
 * 在 cwd 里真的写文件，让工作区隔离有改动可看。只在 git 仓库里写（演示沙盒、测试仓库），
 * 不在任意目录留下垃圾；FAKE_AGENT_WRITE=0 时不写。
 */
function writeFiles(files) {
	if (process.env.FAKE_AGENT_WRITE === "0" || !existsSync(join(process.cwd(), ".git"))) return [];
	for (const [rel, content] of Object.entries(files)) {
		const file = join(process.cwd(), rel);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, content);
	}
	return Object.keys(files);
}

if (kind === "claude") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	const used = model ?? "claude-sonnet-5-5";
	out({ type: "system", subtype: "init", session_id: sid, model: used });
	const tools = [
		{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } },
		{ type: "tool_use", name: "Read", input: { file_path: "README.md" } },
		{ type: "text", text: "我先通读一下相关代码，再给出修改方案。" },
		{ type: "tool_use", name: "Edit", input: { file_path: "src/index.ts" } },
	];
	for (const block of tools) {
		await steps(tools.length);
		out({ type: "assistant", session_id: sid, message: { content: [block] } });
	}
	const written = writeFiles({ [`docs/notes-${slug}.md`]: `# 设计笔记\n\n任务：${task}\n\n- 方案要点一\n- 方案要点二\n- 风险与回滚\n` });
	// 不同档位的模型花费不同（演示数据）
	const cost = /haiku/.test(used) ? 0.0041 : /opus/.test(used) ? 0.0612 : 0.0123;
	out({
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: sid,
		total_cost_usd: cost,
		usage: { input_tokens: 5200, output_tokens: 640, cache_read_input_tokens: 18000 },
		result: `CLAUDE_OK: ${task}\n\n- 读了 3 个文件\n${written.length ? written.map((f) => `- 写了 \`${f}\``).join("\n") : "- 没有修改文件"}`,
	});
} else if (kind === "codex") {
	const resumeIdx = args.indexOf("resume");
	const tid = resumeIdx >= 0 ? args[args.length - 2] : randomUUID();
	out({ type: "thread.started", thread_id: tid });
	const commands = ["rg --files", "npm test", "git diff --stat"];
	for (const command of commands) {
		await steps(commands.length + 1);
		out({ type: "item.started", item: { type: "command_execution", command } });
	}
	await steps(commands.length + 1);
	if (prompt.includes("模拟失败")) {
		// 演示失败路径：和真实 Codex 一样以 turn.failed 结束
		out({ type: "turn.failed", error: { message: "npm test 失败：3 failed, 9 passed（演示）" } });
		process.exitCode = 1;
	} else {
		const written = writeFiles({
			[`src/features/feature-${slug}.ts`]: `// ${task}\nexport function feature${slug}(input: string): string {\n\treturn input.trim();\n}\n`,
			[`test/feature-${slug}.test.ts`]: `import { feature${slug} } from "../src/features/feature-${slug}";\n\nconsole.assert(feature${slug}(" a ") === "a");\n`,
		});
		out({ type: "item.completed", item: { type: "file_change", changes: (written.length ? written : ["src/feature.ts"]).map((path) => ({ path })) } });
		out({ type: "item.completed", item: { type: "agent_message", text: `CODEX_OK: ${task}\n\n测试全部通过（12 passed）。` } });
		out({ type: "turn.completed", usage: { input_tokens: 24000, cached_input_tokens: 16000, output_tokens: 1800 } });
	}
} else if (kind === "gemini") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	await sleep(delay);
	const used = model ?? "gemini-3.5-flash-lite";
	process.stdout.write(
		JSON.stringify(
			{ session_id: sid, response: `GEMINI_OK: ${task}\n\n通读了相关文件，列出 3 条风险（只读，没有改动）。`, stats: { models: { [used]: { tokens: { prompt: 42000, candidates: 900, cached: 0 } } } } },
			null,
			2,
		),
	);
} else {
	process.stderr.write(`unknown kind ${kind}\n`);
	process.exit(2);
}
