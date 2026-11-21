// 入口（终端是主体，后台网页随终端一起启动）：
//   npm start                 交互模式 + 后台网页 http://127.0.0.1:8787
//   npm start -- "你的问题"    单次提问，答完退出（不开后台）
//   npm run demo              演示模式：假模型 + 模拟 CLI，不花钱（后台 8788）
//   --no-web                  不开后台网页
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { startAdmin, type AdminServer } from "./admin.ts";
import { Board, boardTasks, STATUS_LABEL, type BoardState } from "./board.ts";
import { applyChange, cleanChanges, dropChange, pendingChanges } from "./change-ops.ts";
import { initRules, scanConventions, syncRules } from "./conventions.ts";
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

/**
 * 提交一条输入。whenBusy：
 *   steer    总调度正忙时插进当前这一轮（在这一轮工具做完后、下一次思考前看到）；空闲时就是新的一轮
 *   followUp 正忙时排队，这一轮结束后作为新的一轮处理
 */
async function ask(text: string, whenBusy: "steer" | "followUp" = "followUp") {
	const submission = await root.submit({ type: "input", content: text, whenBusy }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		const { reason, detail } = settled as { reason?: string; detail?: string };
		console.log(c.red(`\n本轮没有完成：${reason ?? settled.status}${detail ? ` — ${detail}` : ""}`));
		if (reason === "model_error" || reason === "interrupted" || reason === "turn_limit") console.log(c.dim("（输入 /continue 可以在原来的上下文里续跑）"));
	}
	return settled;
}

async function liveState(): Promise<any> {
	return harness.snapshot(LiveDoc, root.id, context);
}

/** 上一轮出错 / 中断后，不重新输入，直接在原来的上下文里续跑 */
async function continueRun() {
	const live = await liveState();
	if (live?.run) return console.log(c.dim("总调度正在运行，不需要续跑。"));
	if (!live?.runFailure) return console.log(c.dim("上一轮已经正常结束，没有可以续跑的。"));
	if (live.runFailure.reason === "aborted" || live.runFailure.reason === "reset") {
		console.log(c.dim(`上一轮是被${live.runFailure.reason === "aborted" ? "中止" : "重置"}的，仍然尝试续跑。`));
	}
	console.log(c.yellow("续跑上一轮…"));
	const submission = await root.submit({ type: "continue" }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		const { reason, detail } = settled as { reason?: string; detail?: string };
		console.log(c.red(reason === "nothing_to_answer" ? "没有需要续跑的内容：上一轮停在已经回答完的地方。" : `续跑没有完成：${reason ?? settled.status}${detail ? ` — ${detail}` : ""}`));
	}
}

/** 手动压缩：把较早的对话总结成摘要，总调度之后只看摘要 + 最近的内容（原始记录仍在存储里） */
async function compactNow(instructions: string | undefined) {
	console.log(c.yellow("正在压缩上下文…"));
	const taskId = await root.compact(instructions, context);
	const outcome = ((await harness.waitForTask(taskId, context)) as any).state?.outcome;
	if (outcome?.status === "completed") {
		// entryId：空闲时摘要已直接放入；submissionId：正忙，摘要在这一轮的下一个间隙放入；都没有：对话还短，不需要压缩
		const r = outcome.result ?? {};
		console.log(
			r.entryId !== undefined
				? c.green("已压缩：较早的对话换成了摘要（原始记录仍在存储里）。")
				: r.submissionId !== undefined
					? c.green("摘要已生成，会在这一轮的下一个间隙放入。")
					: c.dim("对话还不长，没有需要压缩的内容。"),
		);
	} else {
		console.log(c.red(`压缩没有完成：${outcome?.status ?? "未知"}${outcome?.error ? ` — ${outcome.error}` : ""}`));
	}
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
	const [head, ...rest] = line.split(/\s+/);
	const arg = rest.join(" ").trim();
	if (head === "/queue") {
		if (!arg) {
			console.log(c.red("用法：/queue <任务>（排到当前这一轮之后）"));
			return true;
		}
		const busy = (await liveState())?.run !== undefined;
		console.log(c.dim(busy ? "已排队：这一轮结束后处理。" : "总调度空闲，直接开始。"));
		void ask(arg, "followUp").catch((error) => console.log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`)));
		return true;
	}
	if (head === "/goal") {
		const goal = app.project.goal();
		if (!goal) console.log(c.dim(`还没有项目目标。可以自己写 ${app.project.goalPath}，或者把项目目标告诉总调度，让它起草（会标明待你确认）。`));
		else console.log(`${c.dim(app.project.goalPath)}\n${goal}`);
		return true;
	}
	if (head === "/tasks") {
		const board = (await harness.snapshot(Board, context)) as BoardState | undefined;
		const tasks = boardTasks(board);
		if (!tasks.length) {
			console.log(c.dim("还没有分工表。项目级、多步骤的任务，总调度会先拆成任务（plan_tasks）。"));
			return true;
		}
		const color: Record<string, (s: string) => string> = { done: c.green, doing: c.cyan, review: c.yellow, blocked: c.red, dropped: c.dim, todo: (s) => s };
		for (const t of tasks) {
			const tint = color[t.status] ?? ((s: string) => s);
			console.log(
				`  ${tint(`${t.id} ${STATUS_LABEL[t.status]}`.padEnd(8))} ${t.title}${c.dim(`${t.role ? ` ·${t.role}` : ""}${t.owner ? ` ·${t.owner}` : ""}${t.deps.length ? ` ·依赖 ${t.deps.join(",")}` : ""}${t.changes.length ? ` ·改动 ${t.changes.map((x) => `#${x}`).join(",")}` : ""}`)}`,
			);
		}
		console.log(c.dim(`  完整分工表：${app.project.assignPath}${admin ? `　后台：${admin.url}/#/project` : ""}`));
		return true;
	}
	if (head === "/rules") {
		if (arg === "init") {
			const r = initRules(config.workdir);
			console.log(r.ok ? c.green(r.message) : c.yellow(r.message));
			return true;
		}
		if (arg === "sync") {
			const r = syncRules(config.workdir);
			if (!r.ok) console.log(c.yellow(r.message));
			else {
				console.log(c.green(r.message));
				const word = { created: "新建", updated: "更新", unchanged: "未变" } as const;
				for (const x of r.results) console.log(`  ${x.action === "unchanged" ? c.dim(word[x.action]) : c.green(word[x.action])} ${x.file}`);
				console.log(c.dim("  记得把这些文件提交进 git（还没提交时，新派工的 worktree 也会带上它们）"));
			}
			return true;
		}
		const scan = scanConventions(config.workdir);
		const label = { claude: "Claude", codex: "Codex", gemini: "Gemini" } as const;
		for (const k of ["claude", "codex", "gemini"] as const) {
			const m = scan.members[k];
			const instr = m.instructions.map((f) => `${f.scope === "user" ? "~/" : ""}${f.rel}${f.size === 0 ? c.dim("(空)") : ""}${f.rules === "synced" ? c.green("✓规则") : f.rules ? c.yellow("✗规则") : ""}`);
			console.log(
				`  ${c.cyan(label[k].padEnd(7))} 说明：${instr.join("、") || c.red("无")}${c.dim(`  设置 ${m.settings.length} · 技能 ${m.skills} · 命令 ${m.commands} · 子 agent ${m.subagents}`)}`,
			);
		}
		for (const ch of scan.checks) {
			const mark = ch.level === "warn" ? c.yellow("!") : ch.level === "ok" ? c.green("✓") : c.dim("i");
			console.log(`  ${mark} ${ch.title}${ch.detail ? c.dim(`　${ch.detail}`) : ""}`);
		}
		console.log(c.dim(`  /rules init 生成共同规则模板、/rules sync 同步到各家说明文件${admin ? `；完整视图：${admin.url}/#/conventions` : ""}`));
		return true;
	}
	if (head === "/continue") {
		await continueRun();
		return true;
	}
	if (head === "/compact") {
		await compactNow(arg || undefined);
		return true;
	}
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
	console.log(c.dim("运行中：直接输入 = 插话（当前这一轮就能看到），/queue <任务> 排到下一轮；/continue 续跑中断的一轮，/compact 压缩上下文"));
	console.log(c.dim("项目：/goal 最终目标、/tasks 分工表、/rules 各成员的规范文件（/rules init、/rules sync）"));
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

	// 命令按输入顺序一个一个执行（一次粘贴多行时，/apply 之后的 /clean 要等 /apply 做完）；
	// /abort 和 /exit 不排队，随时生效。任务不排在这里：总调度自己有输入队列。
	let commands = Promise.resolve();
	const immediate = new Set(["/abort", "/exit", "/quit"]);
	repl.on("line", async (raw) => {
		const line = raw.trim();
		if (!line) return repl.prompt();
		if (line.startsWith("/")) {
			const run = async () => {
				try {
					if (!(await command(line))) console.log(c.red(`未知命令：${line}`));
				} catch (error) {
					console.log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
				}
				if (!closing) repl.prompt();
			};
			if (immediate.has(line)) await run();
			else commands = commands.then(run);
			return;
		}
		// 总调度正在干活：这句话插进当前这一轮（steer），它在这一轮工具做完后就能看到；
		// 想排到下一轮用 /queue。插话和原来那一轮一起结束，提示符由原来那一轮负责打印。
		if ((await liveState())?.run !== undefined) {
			console.log(c.dim("↪ 已插入当前这一轮，总调度在下一步就会看到（想排到这一轮之后，用 /queue <任务>）"));
			repl.prompt();
			try {
				await ask(line, "steer");
			} catch (error) {
				console.log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
			}
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
