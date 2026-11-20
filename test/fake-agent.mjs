// 模拟本机 AI CLI，用于测试：node fake-agent.mjs <claude|codex|gemini> [CLI 参数...]
// 按各 CLI 的真实输出格式打印，并把每次调用追加到 FAKE_AGENT_LOG（JSONL）。
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [kind, ...args] = process.argv.slice(2);
const delay = Number(process.env.FAKE_AGENT_DELAY_MS ?? 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

if (process.env.FAKE_AGENT_LOG) {
	appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ kind, args, prompt, pid: process.pid, cwd: process.cwd() })}\n`);
}

if (kind === "claude") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	out({ type: "system", subtype: "init", session_id: sid });
	out({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } });
	await sleep(delay);
	out({ type: "result", subtype: "success", is_error: false, session_id: sid, total_cost_usd: 0.0123, result: `CLAUDE_OK: ${prompt.trim().slice(0, 60)}` });
} else if (kind === "codex") {
	const resumeIdx = args.indexOf("resume");
	const tid = resumeIdx >= 0 ? args[args.length - 2] : randomUUID();
	out({ type: "thread.started", thread_id: tid });
	out({ type: "item.started", item: { type: "command_execution", command: "npm test" } });
	await sleep(delay);
	out({ type: "item.completed", item: { type: "agent_message", text: `CODEX_OK: ${prompt.trim().slice(0, 60)}` } });
	out({ type: "turn.completed" });
} else if (kind === "gemini") {
	const sid = flag("--resume") ?? flag("--session-id") ?? randomUUID();
	await sleep(delay);
	process.stdout.write(JSON.stringify({ session_id: sid, response: `GEMINI_OK: ${prompt.trim().slice(0, 60)}`, stats: {} }, null, 2));
} else {
	process.stderr.write(`unknown kind ${kind}\n`);
	process.exit(2);
}
