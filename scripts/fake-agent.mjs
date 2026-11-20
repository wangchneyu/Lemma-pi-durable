// 模拟本机 AI CLI（测试和演示模式用）：node fake-agent.mjs <claude|codex|gemini> [CLI 参数...]
// 按各 CLI 的真实输出格式打印，执行过程分几步输出进度，并把每次调用追加到 FAKE_AGENT_LOG（JSONL）。
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [kind, ...args] = process.argv.slice(2);
const delay = Number(process.env.FAKE_AGENT_DELAY_MS ?? 200);
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

if (kind === "claude") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	out({ type: "system", subtype: "init", session_id: sid });
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
	out({
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: sid,
		total_cost_usd: 0.0123,
		result: `CLAUDE_OK: ${task}\n\n- 读了 3 个文件\n- 修改了 \`src/index.ts\``,
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
	out({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/feature.ts" }] } });
	out({ type: "item.completed", item: { type: "agent_message", text: `CODEX_OK: ${task}\n\n测试全部通过（12 passed）。` } });
	out({ type: "turn.completed" });
} else if (kind === "gemini") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	await sleep(delay);
	process.stdout.write(JSON.stringify({ session_id: sid, response: `GEMINI_OK: ${task}`, stats: {} }, null, 2));
} else {
	process.stderr.write(`unknown kind ${kind}\n`);
	process.exit(2);
}
