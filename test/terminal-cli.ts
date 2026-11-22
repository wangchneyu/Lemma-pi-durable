import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalText } from "../src/terminal.ts";
import { check } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-agent-tui-"));
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({
	workdir: dir, storage: join(dir, "session.sqlite"),
	agents: Object.fromEntries(["claude", "codex", "gemini", "deepseek"].map((kind) => [kind, { enabled: false }])),
}));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function demo(tui: boolean, real = false): Promise<void> {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
		"--no-warnings", fileURLToPath(new URL(tui ? "./terminal-cli-child.ts" : "../src/main.ts", import.meta.url)),
		"--demo", "--tui", "--no-web",
		...(real ? ["--real"] : []),
	], {
		env: { ...process.env, PI_AGENT_CONFIG: configPath, PI_AGENT_DEMO: real ? "1" : "0", FAKE_AGENT_DELAY_MS: "250", TERM: "xterm-256color" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	let errors = "";
	let exited = false;
	let spawnError: Error | undefined;
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	child.on("error", (error) => { spawnError = error; });
	const closed = new Promise<number | null>((resolve) => child.on("close", (code) => { exited = true; resolve(code); }));
	async function until(label: string, condition: () => boolean, timeout = 20_000) {
		const deadline = Date.now() + timeout;
		while (!condition() && Date.now() < deadline && !exited && !spawnError) await sleep(50);
		assert.ok(condition(), `${label}：${spawnError?.message ?? errors}\n${terminalText(output).slice(-5000)}`);
	}
	// 无修饰 Enter 不受 Windows 测试期间真实键盘 Shift 状态影响。
	const send = (text: string) => child.stdin.write(tui ? `\x1b[200~${text}\x1b[201~\x1b[13u` : `${text}\n`);
	try {
		await until("终端启动", () => output.includes(tui ? "Enter" : "你"));
		if (tui && !real) {
			assert.ok(output.includes("\x1b[?1049h"));
			child.stdin.write("\x1b[?1;2c"); // 回复启动时的设备查询，防止查询缓存延迟输入。
			send("加一个导出按钮\n保留完整任务说明");
			await until("后台派工和验收完成", () => terminalText(output).includes("汇报"), 30_000);
			send("/tasks");
			await until("任务命令完成", () => terminalText(output).includes("完整分工表"));
			send("/changes");
			await until("改动命令完成", () => terminalText(output).includes("待合并"));
		}
		send("/exit");
		await until("进程正常退出", () => exited, 10_000);
		assert.equal(await closed, 0, errors);
		if (real) {
			const final = terminalText(output);
			assert.ok(final.includes("anthropic-compatible") && final.includes("session.sqlite"));
			assert.ok(!final.includes("演示模式") && !final.includes("demo-workspace"));
			check(true, "显式真实模式覆盖演示标志和遗留环境变量，使用真实配置与会话存储（不发送请求）");
		} else if (tui) {
			const final = terminalText(output);
			assert.ok(output.includes("\x1b[?1049l"));
			assert.ok(final.includes("保留完整任务说明") && final.includes("汇报") && final.includes("完整分工表"));
			check(true, "真实入口完成多行任务、后台并行派工、任务与改动命令，并正常恢复终端退出");
		} else {
			assert.ok(output.includes("当前不是交互终端") && !output.includes("\x1b[?1049h"));
			check(true, "管道输入自动回退普通模式，命令与正常退出保持兼容");
		}
	} finally {
		if (!exited) { child.kill(); await closed; }
	}
}

await demo(true);
await demo(false);
await demo(false, true);
