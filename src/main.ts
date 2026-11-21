// 入口（终端是主体，后台网页随终端一起启动）：
//   npm start                 交互模式 + 后台网页 http://127.0.0.1:8787
//   npm start -- "你的问题"    单次提问，答完退出（不开后台）
//   npm run demo              演示模式：假模型 + 模拟 CLI，不花钱（后台 8788）
//   --no-web                  不开后台网页
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startAdmin, type AdminServer } from "./admin.ts";
import { applyChange, cleanChanges, dropChange, pendingChanges } from "./change-ops.ts";
import { openApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { demoConfig, demoOrchestrator } from "./demo.ts";
import { createOrchestratorModel } from "./models.ts";
import { colors as c, follow } from "./printer.ts";

const context = BACKGROUND_CONTEXT;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const demo = flags.has("--demo") || process.env.PI_AGENT_DEMO === "1";
const configPath = resolve(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const baseConfig = loadConfig(configPath);
const config = demo ? demoConfig(baseConfig) : baseConfig;
const orchestrator = demo ? demoOrchestrator() : createOrchestratorModel(config.orchestrator);
const app = await openApp(config, orchestrator, context).catch((error: Error) => {
	console.error(`启动失败：${error.message}`);
	process.exit(1);
});
const { harness, root, agents } = app;
const stopFollowing = await follow(root, context);
harness.resume(); // 上次进程中断时没跑完的任务，从断点继续

let rl: Interface | undefined;
let admin: AdminServer | undefined;
let closing = false;

function printBanner() {
	console.log(c.green(`pi-agent · 本机多 agent 协作（Pi Durable）${demo ? c.yellow("  [演示模式]") : ""}`));
	console.log(c.dim(`总调度模型：${orchestrator.describe}`));
	console.log(c.dim(`工作目录：${config.workdir}`));
	console.log(c.dim(`会话存储：${config.storage}`));
	if (admin) console.log(`${c.dim("后台网页：")}${c.cyan(admin.url)}`);
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
	await admin?.close().catch(() => {});
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

const STATUS_TEXT: Record<string, string> = {
	running: "进行中",
	pending: "待合并",
	empty: "无改动",
	applied: "已合并",
	dropped: "已丢弃",
	conflict: "有冲突",
};

function printChanges(all: boolean) {
	const list = app.changes.list().filter((c) => all || c.status === "pending" || c.status === "conflict" || c.status === "running");
	if (!list.length) {
		console.log(c.dim(all ? "还没有隔离派工的改动。" : "没有待合并的改动（/changes all 查看全部）。"));
		return;
	}
	for (const ch of list) {
		const color = ch.status === "pending" ? c.yellow : ch.status === "conflict" ? c.red : ch.status === "applied" ? c.green : c.dim;
		console.log(
			`  ${color(`#${ch.id}`)} ${color(STATUS_TEXT[ch.status] ?? ch.status)}  ${ch.agent}${ch.model ? c.dim(`/${ch.model}`) : ""}  ${ch.files.length} 个文件 ${c.green(`+${ch.add}`)} ${c.red(`−${ch.del}`)}  ${c.dim(ch.task.replace(/\s+/g, " ").slice(0, 50))}`,
		);
	}
	console.log(c.dim("  /diff <编号> 看改了哪些文件，/apply <编号> 合并到主目录，/drop <编号> 丢弃，/clean 清理已合并的 worktree"));
}

async function changeCommand(line: string): Promise<boolean> {
	const [cmd, arg = ""] = line.split(/\s+/, 2);
	switch (cmd) {
		case "/changes":
			printChanges(arg === "all");
			return true;
		case "/diff": {
			const ch = app.changes.get(arg);
			if (!ch) {
				console.log(c.red(`找不到改动 ${arg || "（请给出编号）"}`));
				return true;
			}
			console.log(`#${ch.id}  ${ch.branch}  ${STATUS_TEXT[ch.status] ?? ch.status}${ch.basedOn ? c.dim(`  基于 #${ch.basedOn}`) : ""}`);
			for (const f of ch.files) console.log(`  ${c.green(`+${f.add}`.padStart(6))} ${c.red(`−${f.del}`.padEnd(6))} ${f.path}`);
			if (admin) console.log(c.dim(`  完整差异：${admin.url}/#/changes/${ch.id}`));
			return true;
		}
		case "/apply":
		case "/drop": {
			if (!arg) {
				console.log(c.red(`用法：${cmd} <编号>（或 ${cmd} all 处理全部待合并的改动）`));
				return true;
			}
			const ids = arg === "all" ? pendingChanges(app.changes).map((ch) => ch.id) : [arg];
			if (!ids.length) console.log(c.dim("没有待合并的改动。"));
			for (const id of ids) {
				const r = cmd === "/apply" ? await applyChange(app.changes, id) : await dropChange(app.changes, id);
				console.log(r.ok ? c.green(r.message) : c.red(r.message));
			}
			return true;
		}
		case "/clean": {
			const r = await cleanChanges(app.changes);
			console.log(c.green(r.message));
			return true;
		}
		default:
			return false;
	}
}

async function command(line: string): Promise<boolean> {
	if (await changeCommand(line)) return true;
	switch (line) {
		case "/exit":
		case "/quit":
			await shutdown(0);
			return true;
		case "/agents":
			printBanner();
			return true;
		case "/web":
			console.log(admin ? `后台网页：${c.cyan(admin.url)}` : c.dim("后台网页没有开启（--no-web 或配置 web.enabled=false）"));
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
	console.log(c.dim("\n输入任务开始协作。命令：/agents /web /usage /abort /new /exit；运行中按 Ctrl+C 中止本轮。"));
	console.log(c.dim("改动：/changes 待合并的改动、/diff <编号>、/apply <编号>、/drop <编号>、/clean\n"));
	if (pendingChanges(app.changes).length) {
		console.log(c.yellow(`有 ${pendingChanges(app.changes).length} 个改动等你确认合并：`));
		printChanges(false);
		console.log();
	}
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

const oneShot = argv
	.filter((a) => !a.startsWith("--"))
	.join(" ")
	.trim();
if (oneShot) {
	printBanner();
	console.log(`\n${c.cyan("你 ›")} ${oneShot}`);
	const settled = await ask(oneShot);
	await shutdown(settled.status === "done" ? 0 : 1);
} else {
	if (config.web.enabled && !flags.has("--no-web")) {
		const port = Number(process.env.PI_AGENT_PORT ?? (demo ? config.web.port + 1 : config.web.port));
		admin = await startAdmin({
			app,
			config,
			configPath,
			orchestrator,
			demo,
			port,
			context,
			notify: (line) => {
				console.log(c.yellow(`\n[${line}]`));
				rl?.prompt(true);
			},
		}).catch((error: Error) => {
			console.log(c.red(`后台网页没能启动：${error.message}（终端照常可用）`));
			return undefined;
		});
	}
	startRepl();
}
