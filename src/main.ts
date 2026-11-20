// 入口：
//   npm start                 交互模式（会话持久化在 data/session.sqlite，重启后接着跑）
//   npm start -- "你的问题"    单次提问，答完退出
import { createInterface, type Interface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createOrchestratorModel } from "./models.ts";
import { colors as c, follow } from "./printer.ts";

const context = BACKGROUND_CONTEXT;
const config = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const orchestrator = createOrchestratorModel(config.orchestrator);
const { harness, root, agents } = await openApp(config, orchestrator, context).catch((error: Error) => {
	console.error(`启动失败：${error.message}`);
	process.exit(1);
});
const stopFollowing = await follow(root, context);
harness.resume(); // 上次进程中断时没跑完的任务，从断点继续

let rl: Interface | undefined;
let closing = false;

function printBanner() {
	console.log(c.green("pi-agent · 本机多 agent 协作（Pi Durable）"));
	console.log(c.dim(`总调度模型：${orchestrator.describe}`));
	console.log(c.dim(`工作目录：${config.workdir}`));
	console.log(c.dim(`会话存储：${config.storage}`));
	for (const a of agents) {
		console.log(`  ${a.available ? c.green("●") : c.red("○")} ${a.kind}${a.available ? "" : c.dim(` — ${a.reason}`)}`);
	}
}

async function shutdown(code = 0): Promise<void> {
	if (closing) return;
	closing = true;
	process.exitCode = code;
	// readline 可能正在同步分发同一批粘贴进来的多行，推迟到分发完再关
	setImmediate(() => rl?.close());
	await stopFollowing();
	await harness.close(context);
	// 不直接 process.exit()：Windows 上句柄未关完就退出会触发 libuv 断言。
	// 让事件循环自然结束；万一有残留句柄，2 秒后兜底退出。
	setTimeout(() => process.exit(code), 2000).unref();
}

async function ask(text: string) {
	const submission = await root.submit({ type: "input", content: text }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		const { reason, detail } = settled as { reason?: string; detail?: string };
		console.log(c.red(`\n本轮没有完成：${reason ?? settled.status}${detail ? ` — ${detail}` : ""}`));
	}
	return settled;
}

async function command(line: string): Promise<boolean> {
	switch (line) {
		case "/exit":
		case "/quit":
			await shutdown(0);
			return true;
		case "/agents":
			printBanner();
			return true;
		case "/usage": {
			const usage = (await harness.usage(context)) as any;
			for (const [name, u] of Object.entries<any>(usage.models ?? {})) {
				console.log(`  ${name}: 输入 ${u.input ?? 0} / 输出 ${u.output ?? 0} tokens`);
			}
			return true;
		}
		case "/abort":
			await root.abort(context);
			console.log(c.yellow("已中止。"));
			return true;
		case "/new":
			await root.reset(undefined, context);
			console.log(c.yellow("已开始新的上下文（历史仍保存在存储里）。"));
			return true;
		default:
			return false;
	}
}

function startRepl() {
	printBanner();
	console.log(c.dim("\n输入任务开始协作。命令：/agents /usage /abort /new /exit；运行中按 Ctrl+C 中止本轮。\n"));
	const repl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${c.cyan("你 ›")} ` });
	rl = repl;
	let busy = 0;

	repl.on("SIGINT", async () => {
		if (busy === 0) return shutdown(0);
		console.log(c.yellow("\n正在中止本轮…"));
		await root.abort(context);
		repl.prompt();
	});

	repl.on("line", async (raw) => {
		const line = raw.trim();
		if (!line) return repl.prompt();
		if (line.startsWith("/")) {
			if (!(await command(line))) console.log(c.red(`未知命令：${line}`));
			if (!closing) repl.prompt();
			return;
		}
		busy++;
		try {
			await ask(line);
		} catch (error) {
			console.log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
		} finally {
			busy--;
			if (!closing) {
				console.log();
				repl.prompt();
			}
		}
	});

	repl.on("close", () => void shutdown(0));
	repl.prompt();
}

const oneShot = process.argv.slice(2).join(" ").trim();
if (oneShot) {
	printBanner();
	console.log(`\n${c.cyan("你 ›")} ${oneShot}`);
	const settled = await ask(oneShot);
	await shutdown(settled.status === "done" ? 0 : 1);
} else {
	startRepl();
}
