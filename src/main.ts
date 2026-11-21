// 入口（终端是主体，后台网页随终端一起启动）：
//   npm start                 真实模型 + 新版终端 + 后台网页 http://127.0.0.1:8787
//   npm start -- "你的问题"    单次提问，答完退出（不开后台）
//   npm run demo              演示模式：假模型 + 模拟 CLI，不花钱（后台 8788）
//   npm run demo:tui          新版终端演示（Pi TUI，固定输入区与任务状态）
//   npm run tui               新版终端，真实模型；--plain 回到普通模式
//   --no-web                  不开后台网页
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { startAdmin, type AdminServer } from "./admin.ts";
import { Board, boardTasks, STATUS_LABEL, type BoardState } from "./board.ts";
import { applyChange, cleanChanges, dropChange, pendingChanges } from "./change-ops.ts";
import { initRules, scanConventions, syncRules } from "./conventions.ts";
import { openApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { clip, Jobs, type JobRecord, type JobsState } from "./jobs.ts";
import { demoConfig, demoOrchestrator, installDemoMember } from "./demo.ts";
import { createOrchestratorModel } from "./models.ts";
import { colors as c, follow, setOutputSink, writeLine as log } from "./printer.ts";
import { AgentSessions, RunBudget } from "./dispatch.ts";
import { Learning } from "./learning.ts";
import { AgentTerminal } from "./terminal.ts";
import { toViewLive } from "./view.ts";
import { SessionCatalog } from "./sessions.ts";
import { liveDigest, storedDigest } from "./digest.ts";

const context = BACKGROUND_CONTEXT;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
// 显式真实模式优先，避免之前启动演示遗留的环境变量继续选中假模型。
const demo = !flags.has("--real") && (flags.has("--demo") || process.env.PI_AGENT_DEMO === "1");
const configPath = resolve(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const baseConfig = loadConfig(configPath);
const sessionCatalog = new SessionCatalog(demo ? demoConfig(baseConfig) : baseConfig);
let sessionId = argv.find((a) => a.startsWith("--session="))?.slice(10) ?? sessionCatalog.selected();
if (sessionId !== "default" && !sessionCatalog.list().some((s) => s.id === sessionId)) sessionCatalog.create(sessionId);
let config = sessionCatalog.config(sessionId);
let orchestrator = demo ? demoOrchestrator() : createOrchestratorModel(config.orchestrator);
let app = await openApp(config, orchestrator, context).catch((error: Error) => {
	console.error(`启动失败：${error.message}`);
	process.exit(1);
});
let { harness, root, agents } = app;
sessionCatalog.select(sessionId);
type Runtime = { app: typeof app; config: typeof config; orchestrator: typeof orchestrator };
const sessions = new Map<string, Runtime>([[sessionId, { app, config, orchestrator }]]);
const drafts = new Map<string, string>();
if (demo) installDemoMember(orchestrator.models);
let stopFollowing = async () => {};
let terminalUI: AgentTerminal | undefined;
let stopTerminalStatus = () => {};
// 后台派工的实时输出：带上编号打印，提示符跟着重画
function attachJobOutput(id: string, target: typeof app) { target.jobs.on("output", (job: string, line: string) => {
	if (id !== sessionId || closing) return;
	// 先擦掉当前的提示符行再打印；终端空闲时再把提示符（和已经输入的内容）画回来
	clearPromptLine();
	log(c.dim(`  [${id === sessionId ? job : `${id}/${job}`}] ${line}`));
	if (replIdle()) rl?.prompt(true);
}); }
attachJobOutput(sessionId, app);

let rl: Interface | undefined;
/** 先光标回行首再清整行：草稿在行尾时，先 clearLine 只会清掉光标右侧的空内容，所以要回行首再清 */
function clearPromptLine() {
	if (rl && process.stdout.isTTY) {
		cursorTo(process.stdout, 0);
		clearLine(process.stdout, 0);
	}
}
/** 终端在等你输入（没有在等总调度回答） */
let replIdle = () => false;
let admin: AdminServer | undefined;
let webPort: number | undefined;
let closing = false;
let switchingSession = false;

async function conversationList() {
	return Promise.all(sessionCatalog.list().map(async (info) => {
		const runtime = sessions.get(info.id);
		const live = runtime ? await runtime.app.harness.snapshot(LiveDoc, runtime.app.root.id, context) : undefined;
		const jobs = runtime ? await runtime.app.harness.snapshot(Jobs, context) : undefined;
		const digest = runtime ? await liveDigest(runtime.app.harness, runtime.app.root, info.storage) : await storedDigest(info.id, info.storage);
		return { id: info.id, title: info.title, named: info.title !== info.id, digest, createdAt: info.createdAt, workdir: info.workdir,
			current: info.id === sessionId, opened: !!runtime, controllerId: runtime ? String(runtime.app.root.id) : null,
			busy: live?.run !== undefined, runningJobs: Object.values(jobs?.jobs ?? {}).filter((j) => j.status === "running").length };
	}));
}

async function startWeb() {
	if (!config.web.enabled || flags.has("--no-web")) return;
	const port = webPort ?? Number(process.env.PI_AGENT_PORT ?? (demo ? config.web.port + 1 : config.web.port));
	admin = await startAdmin({
		app, config, configPath, orchestrator, demo, port, context,
		session: { id: sessionId, title: sessionCatalog.get(sessionId).title, controllerId: String(root.id) },
		conversations: {
			list: conversationList,
			busy: () => switchingSession || closing,
			async create(title) {
				const label = title.trim() || `新对话 ${new Date().toLocaleString("zh-CN")}`;
				if (label.length > 120) throw new Error("对话标题不能超过 120 个字符");
				const info = sessionCatalog.create(`c-${randomUUID().slice(0, 12)}`, config.workdir);
				sessionCatalog.rename(info.id, label);
				return { id: info.id };
			},
			select: (id) => sessionCommand(`/session use ${id}`),
			async rename(id, title) {
				sessionCatalog.rename(id, title);
				if (id === sessionId && admin) log(`网页已重命名当前对话：${title}`);
			},
		},
		notify: (line) => { clearPromptLine(); log(c.yellow(`\n[${line}]`)); rl?.prompt(true); },
	}).catch((error: Error) => { log(c.red(`后台网页没能启动：${error.message}（终端照常可用）`)); return undefined; });
	if (admin) webPort = Number(new URL(admin.url).port);
}

async function sessionCommand(line: string) {
	const [, action = "list", suppliedId = "", ...rest] = line.split(/\s+/);
	const id = action === "new" && !suppliedId ? `s-${Date.now().toString(36)}` : suppliedId;
	if (action === "list" || !action) {
		for (const info of sessionCatalog.list()) {
			const runtime = sessions.get(info.id);
			const live = runtime ? await runtime.app.harness.snapshot(LiveDoc, runtime.app.root.id, context) : undefined;
			const doc = runtime ? await runtime.app.harness.snapshot(Jobs, context) : undefined;
			const jobs = Object.values(doc?.jobs ?? {}).filter((j) => j.status === "running").length;
			log(`${info.id === sessionId ? "●" : "○"} ${info.id} · ${info.title} · 总控对话 ${runtime ? String(runtime.app.root.id) : "打开后显示"} · ${live?.run ? "运行中" : runtime ? "已打开" : "未打开"} · 后台 ${jobs} · ${info.workdir}`);
		}
		log("/session new <编号> [项目路径] · /session use <编号> · /session rename <编号> <标题>；切换不会中止其他会话。");
		return;
	}
	if (action === "rename") { sessionCatalog.rename(id, rest.join(" ")); log(`已重命名 ${id}。`); return; }
	if (action !== "new" && action !== "use") throw new Error("用法：/sessions 或 /session new|use|rename <编号>");
	if (switchingSession) throw new Error("正在切换会话，请稍后。");
	switchingSession = true;
	try {
		if (action === "new") sessionCatalog.create(id, rest.join(" ").replace(/^"|"$/g, "") || config.workdir);
		if (id === sessionId) return;
		let runtime = sessions.get(id);
		if (!runtime) {
			const nextConfig = sessionCatalog.config(id);
			const nextModel = demo ? demoOrchestrator() : createOrchestratorModel(nextConfig.orchestrator);
			const nextApp = await openApp(nextConfig, nextModel, context);
			if (demo) installDemoMember(nextModel.models);
			runtime = { app: nextApp, config: nextConfig, orchestrator: nextModel };
			sessions.set(id, runtime);
			attachJobOutput(id, nextApp);
		}
		const wasTui = !!terminalUI;
		if (terminalUI) drafts.set(sessionId, terminalUI.editor.getExpandedText());
		stopTerminalStatus();
		await stopFollowing();
		terminalUI?.stop();
		terminalUI = undefined;
		setOutputSink(undefined);
		await admin?.close();
		admin = undefined;
		sessionId = id;
		sessionCatalog.select(id);
		({ app, config, orchestrator } = runtime);
		({ harness, root, agents } = app);
		await startWeb();
		if (closing) { await (admin as AdminServer | undefined)?.close(); return; }
		if (wasTui) await startTui();
		else { stopFollowing = await follow(root, context, { replay: true }); printBanner(); }
		if (closing) return;
		harness.resume();
		log(`已切换到 ${sessionId}。其他已打开会话继续运行；网页显示当前会话。`);
	} finally { switchingSession = false; }
}

function printBanner() {
	log(c.green(`pi-agent · 本机多 agent 协作（Pi Durable）${demo ? c.yellow("  [演示模式]") : ""}`));
	log(c.dim(`总调度模型：${orchestrator.describe}`));
	log(c.cyan(`会话：${sessionId} · ${sessionCatalog.get(sessionId).title}（/sessions 管理与切换）`));
	log(c.cyan(`当前输入 → 总控对话 ${root.id}；成员各用独立 session_id（/conversation 查看隔离边界）`));
	log(c.dim(`工作目录：${config.workdir}`));
	log(c.dim(`会话存储：${config.storage}`));
	if (admin) log(`${c.dim("后台网页：")}${c.cyan(admin.url)}`);
	for (const a of agents) {
		log(`  ${a.available ? c.green("●") : c.red("○")} ${a.kind}${a.available ? "" : c.dim(` — ${a.reason}`)}`);
	}
}

async function shutdown(code = 0): Promise<void> {
	if (closing) return;
	closing = true;
	process.exitCode = code;
	// 即使切换会话时某个资源已关闭或关闭失败，也必须最终退出并释放其余运行时。
	setTimeout(() => process.exit(code), 4000).unref();
	for (const runtime of sessions.values()) runtime.app.jobs.closing = true;
	stopTerminalStatus();
	terminalUI?.stop();
	setOutputSink(undefined);
	// readline 可能正在同步分发同一批粘贴进来的多行，推迟到分发完再关
	setImmediate(() => rl?.close());
	await admin?.close().catch(() => {});
	await stopFollowing().catch(() => {});
	// 关闭时被打断的后台派工不收尾，下次启动续接它的会话接着做
	await Promise.allSettled([...sessions.values()].map((runtime) => runtime.app.harness.close(context)));
	// 不直接 process.exit()：Windows 上句柄未关完就退出会触发 libuv 断言。
	// 让事件循环自然结束；万一有残留句柄，2 秒后兜底退出。
	setTimeout(() => process.exit(code), 2000).unref();
}

/**
 * 提交一条输入。whenBusy：
 *   steer    总调度正忙时插进当前这一轮（在这一轮工具做完后、下一次思考前看到）；空闲时就是新的一轮
 *   followUp 正忙时排队，这一轮结束后作为新的一轮处理
 */
/** 模型服务商因内容政策拦截整段请求（换个说法或续跑都没用，只能重置上下文） */
const CONTEXT_BLOCKED = /violate .*(terms|usage polic)|blocked as it seems|content (policy|filter)|safety (system|filter)|内容(安全|审核|政策)/i;

async function ask(text: string, whenBusy: "steer" | "followUp" = "followUp") {
	const target = root;
	const id = sessionId;
	const submission = await target.submit({ type: "input", content: text, whenBusy }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		const { reason, detail } = settled as { reason?: string; detail?: string };
		log(c.red(`\n[${id}] 本轮没有完成：${reason ?? settled.status}${detail ? ` — ${detail}` : ""}`));
		if (reason === "model_error" && CONTEXT_BLOCKED.test(detail ?? "")) {
			// 服务商的内容检查拦下的是整段上下文：之后每次请求都会带上它，续跑和重发都没用
			log(c.yellow("（这是模型服务商的内容检查拦截，不是 pi-agent 的故障。被拦的那条消息还在上下文里，之后每次请求都会被拦。输入 /new 重置上下文就能恢复；对话记录仍保存在存储里。）"));
		} else if (reason === "model_error" || reason === "interrupted" || reason === "turn_limit") log(c.dim("（输入 /continue 可以在原来的上下文里续跑）"));
	}
	return settled;
}

async function liveState(): Promise<any> {
	return harness.snapshot(LiveDoc, root.id, context);
}

/** 上一轮出错 / 中断后，不重新输入，直接在原来的上下文里续跑 */
async function continueRun() {
	const live = await liveState();
	if (live?.run) return log(c.dim("总调度正在运行，不需要续跑。"));
	if (!live?.runFailure) return log(c.dim("上一轮已经正常结束，没有可以续跑的。"));
	if (live.runFailure.reason === "aborted" || live.runFailure.reason === "reset") {
		log(c.dim(`上一轮是被${live.runFailure.reason === "aborted" ? "中止" : "重置"}的，仍然尝试续跑。`));
	}
	log(c.yellow("续跑上一轮…"));
	const submission = await root.submit({ type: "continue" }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		const { reason, detail } = settled as { reason?: string; detail?: string };
		log(c.red(reason === "nothing_to_answer" ? "没有需要续跑的内容：上一轮停在已经回答完的地方。" : `续跑没有完成：${reason ?? settled.status}${detail ? ` — ${detail}` : ""}`));
	}
}

/** 手动压缩：把较早的对话总结成摘要，总调度之后只看摘要 + 最近的内容（原始记录仍在存储里） */
async function compactNow(instructions: string | undefined) {
	log(c.yellow("正在压缩上下文…"));
	const taskId = await root.compact(instructions, context);
	const outcome = ((await harness.waitForTask(taskId, context)) as any).state?.outcome;
	if (outcome?.status === "completed") {
		// entryId：空闲时摘要已直接放入；submissionId：正忙，摘要在这一轮的下一个间隙放入；都没有：对话还短，不需要压缩
		const r = outcome.result ?? {};
		log(
			r.entryId !== undefined
				? c.green("已压缩：较早的对话换成了摘要（原始记录仍在存储里）。")
				: r.submissionId !== undefined
					? c.green("摘要已生成，会在这一轮的下一个间隙放入。")
					: c.dim("对话还不长，没有需要压缩的内容。"),
		);
	} else {
		log(c.red(`压缩没有完成：${outcome?.status ?? "未知"}${outcome?.error ? ` — ${outcome.error}` : ""}`));
	}
}

const JOB_STATUS: Record<JobRecord["status"], string> = { running: "进行中", done: "完成", failed: "失败", cancelled: "已取消" };

async function jobList(): Promise<JobRecord[]> {
	const doc = (await harness.snapshot(Jobs, context)) as JobsState | undefined;
	return Object.values(doc?.jobs ?? {}).sort((a, b) => b.startedAt - a.startedAt);
}

function jobLine(j: JobRecord): string {
	const color = j.status === "running" ? c.cyan : j.status === "done" ? c.green : j.status === "failed" ? c.red : c.dim;
	const seconds = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
	return `  ${color(`${j.id} ${JOB_STATUS[j.status]}`.padEnd(9))} ${j.agent}${j.model ? c.dim(`/${j.model}`) : ""}${j.taskId ? ` · ${j.taskId}` : ""}  ${c.dim(`${seconds}s${j.costUsd !== undefined ? ` · $${j.costUsd.toFixed(3)}` : ""}${j.changeId ? ` · 改动 #${j.changeId}` : ""}`)}  ${c.dim(clip(j.task, 50))}`;
}

async function jobsCommand(arg: string) {
	const [sub, target = ""] = arg.split(/\s+/, 2);
	const jobs = await jobList();
	if (sub === "cancel") {
		const ids = target === "all" ? jobs.filter((j) => j.status === "running").map((j) => j.id) : [target];
		if (!ids[0]) return log(c.dim(target === "all" ? "没有进行中的后台派工。" : "用法：/jobs cancel <编号|all>"));
		for (const id of ids) {
			const r = await app.jobs.cancel(id, "user", context);
			log(r === "cancelled" ? c.yellow(`已取消 ${id}（总调度会收到通知）`) : r === "not_running" ? c.dim(`${id} 已经结束了`) : c.red(`没有后台派工 ${id}`));
		}
		return;
	}
	if (sub) {
		const j = jobs.find((x) => x.id.toLowerCase() === sub.toLowerCase());
		if (!j) return log(c.red(`没有后台派工 ${sub}`));
		log(jobLine(j));
		log(c.dim(`  任务：${j.task}`));
		if (j.sessionId) log(c.dim(`  会话：${j.sessionId}`));
		const lines = app.jobs.recent(j.id).slice(-12);
		if (lines.length) log([c.dim("  最近输出："), ...lines.map((l) => c.dim(`    ${l}`))].join("\n"));
		if (j.result) log(`  结果：${clip(j.result, 600)}`);
		return;
	}
	if (!jobs.length) return log(c.dim("还没有后台派工。总调度派耗时长、互不依赖的任务时会放到后台（background: true）。"));
	const running = jobs.filter((j) => j.status === "running");
	for (const j of [...running, ...jobs.filter((j) => j.status !== "running").slice(0, 10)]) log(jobLine(j));
	log(c.dim(`  /jobs <编号> 看详情和实时输出，/jobs cancel <编号|all> 取消${admin ? `；拓扑：${admin.url}/#/topology` : ""}`));
}

/** 单次提问模式：等后台派工和它们触发的后续处理都结束 */
async function untilSettled() {
	for (;;) {
		const running = (await jobList()).some((j) => j.status === "running");
		const busy = (await liveState())?.run !== undefined;
		if (!running && !busy) return;
		await new Promise((r) => setTimeout(r, 500));
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
		log(c.dim(all ? "还没有隔离派工的改动。" : "没有待合并的改动（/changes all 查看全部）。"));
		return;
	}
	for (const ch of list) {
		const color = ch.status === "pending" ? c.yellow : ch.status === "conflict" ? c.red : ch.status === "applied" ? c.green : c.dim;
		log(
			`  ${color(`#${ch.id}`)} ${color(STATUS_TEXT[ch.status] ?? ch.status)}  ${ch.agent}${ch.model ? c.dim(`/${ch.model}`) : ""}  ${ch.files.length} 个文件 ${c.green(`+${ch.add}`)} ${c.red(`−${ch.del}`)}  ${c.dim(ch.task.replace(/\s+/g, " ").slice(0, 50))}`,
		);
	}
	log(c.dim("  /diff <编号> 看改了哪些文件，/apply <编号> 合并到主目录，/drop <编号> 丢弃，/clean 清理已合并的 worktree"));
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
				log(c.red(`找不到改动 ${arg || "（请给出编号）"}`));
				return true;
			}
			log(`#${ch.id}  ${ch.branch}  ${STATUS_TEXT[ch.status] ?? ch.status}${ch.basedOn ? c.dim(`  基于 #${ch.basedOn}`) : ""}`);
			for (const f of ch.files) log(`  ${c.green(`+${f.add}`.padStart(6))} ${c.red(`−${f.del}`.padEnd(6))} ${f.path}`);
			if (admin) log(c.dim(`  完整差异：${admin.url}/#/changes/${ch.id}`));
			return true;
		}
		case "/apply":
		case "/drop": {
			if (!arg) {
				log(c.red(`用法：${cmd} <编号>（或 ${cmd} all 处理全部待合并的改动）`));
				return true;
			}
			const ids = arg === "all" ? pendingChanges(app.changes).map((ch) => ch.id) : [arg];
			if (!ids.length) log(c.dim("没有待合并的改动。"));
			for (const id of ids) {
				const r = cmd === "/apply" ? await applyChange(app.changes, id) : await dropChange(app.changes, id);
				log(r.ok ? c.green(r.message) : c.red(r.message));
			}
			return true;
		}
		case "/clean": {
			const r = await cleanChanges(app.changes);
			log(c.green(r.message));
			return true;
		}
		default:
			return false;
	}
}

async function command(line: string): Promise<boolean> {
	if (/^\/sessions?(?:\s|$)/.test(line)) { await sessionCommand(line); return true; }
	if (line === "/conversation" || line === "/id") {
		log(`会话编号：${sessionId}（可读名称，不是模型对话 ID）`);
		log(`总控 conversation_id：${root.id}（Pi Durable ID，仅在本会话存储内唯一）`);
		log(`会话存储：${config.storage}`);
		log("当前输入发送给总控；成员分别持有自己的上下文，仅接收派工说明、项目背景与显式交接内容。总控只收到派工结果，不自动复制成员完整聊天记录。");
		log("重启默认恢复上次选中的会话；--session=编号 可指定恢复。Ctrl+N / /session new 新建独立聊天；/new 只重置当前总控上下文，保留任务与成员登记。");
		return true;
	}
	if (line === "/members") {
		const records = (await harness.snapshot(AgentSessions, context))?.sessions ?? {};
		log(`所属会话：${sessionId} · 总控 conversation_id=${root.id}；成员 ID 只可在所属会话续接。`);
		for (const [id, record] of Object.entries(records)) log(`${record.agent} · session_id=${id} · 总控=${record.controllerId ?? String(root.id)} · ${record.model ?? "默认模型"} · ${record.rounds ?? 0} 轮 · ${record.lastTask ?? ""}`);
		if (!Object.keys(records).length) log("当前会话还没有成员上下文；任务派工后会显示在这里。");
		return true;
	}
	if (line === "/learn" || line === "/repair") {
		const learning = await harness.snapshot(Learning, context);
		log(`自动验收与修复：${config.autonomy.enabled ? "开启" : "关闭"} · 最多 ${config.autonomy.maxRepairAttempts} 次 · 检查 ${config.autonomy.checks.map((c) => c.name).join("、") || "未配置"}`);
		for (const event of learning?.events.slice(-8) ?? []) log(`${event.agent} 修复 ${event.attempt} · ${event.status} · ${event.task}`);
		for (const lesson of learning?.lessons.slice(-5) ?? []) log(`已验证记录：${lesson.task} · ${lesson.checks.join("、")} · ${lesson.repairs} 次修复 · 改动 ${lesson.changeId ?? "未知"}${lesson.resolution ? `\n  ${lesson.resolution.slice(0, 200)}` : ""}`);
		return true;
	}
	if (await changeCommand(line)) return true;
	const [head, ...rest] = line.split(/\s+/);
	const arg = rest.join(" ").trim();
	if (head === "/queue") {
		if (!arg) {
			log(c.red("用法：/queue <任务>（排到当前这一轮之后）"));
			return true;
		}
		log(c.dim("已提交：当前会话忙时排到下一轮，空闲时直接开始。"));
		void ask(arg, "followUp").catch((error) => log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`)));
		return true;
	}
	if (head === "/goal") {
		const goal = app.project.goal();
		if (!goal) log(c.dim(`还没有项目目标。可以自己写 ${app.project.goalPath}，或者把项目目标告诉总调度，让它起草（会标明待你确认）。`));
		else log(`${c.dim(app.project.goalPath)}\n${goal}`);
		return true;
	}
	if (head === "/tasks") {
		const board = (await harness.snapshot(Board, context)) as BoardState | undefined;
		const tasks = boardTasks(board);
		if (!tasks.length) {
			log(c.dim("还没有分工表。项目级、多步骤的任务，总调度会先拆成任务（plan_tasks）。"));
			return true;
		}
		const color: Record<string, (s: string) => string> = { done: c.green, doing: c.cyan, review: c.yellow, blocked: c.red, dropped: c.dim, todo: (s) => s };
		for (const t of tasks) {
			const tint = color[t.status] ?? ((s: string) => s);
			log(
				`  ${tint(`${t.id} ${STATUS_LABEL[t.status]}`.padEnd(8))} ${t.title}${c.dim(`${t.role ? ` ·${t.role}` : ""}${t.owner ? ` ·${t.owner}` : ""}${t.deps.length ? ` ·依赖 ${t.deps.join(",")}` : ""}${t.changes.length ? ` ·改动 ${t.changes.map((x) => `#${x}`).join(",")}` : ""}`)}`,
			);
		}
		log(c.dim(`  完整分工表：${app.project.assignPath}${admin ? `　后台：${admin.url}/#/project` : ""}`));
		return true;
	}
	if (head === "/rules") {
		if (arg === "init") {
			const r = initRules(config.workdir);
			log(r.ok ? c.green(r.message) : c.yellow(r.message));
			return true;
		}
		if (arg === "sync") {
			const r = syncRules(config.workdir);
			if (!r.ok) log(c.yellow(r.message));
			else {
				log(c.green(r.message));
				const word = { created: "新建", updated: "更新", unchanged: "未变" } as const;
				for (const x of r.results) log(`  ${x.action === "unchanged" ? c.dim(word[x.action]) : c.green(word[x.action])} ${x.file}`);
				log(c.dim("  记得把这些文件提交进 git（还没提交时，新派工的 worktree 也会带上它们）"));
			}
			return true;
		}
		const scan = scanConventions(config.workdir);
		const label = { claude: "Claude", codex: "Codex", gemini: "Gemini" } as const;
		for (const k of ["claude", "codex", "gemini"] as const) {
			const m = scan.members[k];
			const instr = m.instructions.map((f) => `${f.scope === "user" ? "~/" : ""}${f.rel}${f.size === 0 ? c.dim("(空)") : ""}${f.rules === "synced" ? c.green("✓规则") : f.rules ? c.yellow("✗规则") : ""}`);
			log(
				`  ${c.cyan(label[k].padEnd(7))} 说明：${instr.join("、") || c.red("无")}${c.dim(`  设置 ${m.settings.length} · 技能 ${m.skills} · 命令 ${m.commands} · 子 agent ${m.subagents}`)}`,
			);
		}
		for (const ch of scan.checks) {
			const mark = ch.level === "warn" ? c.yellow("!") : ch.level === "ok" ? c.green("✓") : c.dim("i");
			log(`  ${mark} ${ch.title}${ch.detail ? c.dim(`　${ch.detail}`) : ""}`);
		}
		log(c.dim(`  /rules init 生成共同规则模板、/rules sync 同步到各家说明文件${admin ? `；完整视图：${admin.url}/#/conventions` : ""}`));
		return true;
	}
	if (head === "/jobs") {
		await jobsCommand(arg);
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
			log(admin ? `后台网页：${c.cyan(admin.url)}` : c.dim("后台网页没有开启（--no-web 或配置 web.enabled=false）"));
			return true;
		case "/usage": {
			const usage = (await harness.usage(context)) as any;
			for (const [name, u] of Object.entries<any>(usage.models ?? {})) {
				log(`  ${name}: 输入 ${u.input ?? 0} / 输出 ${u.output ?? 0} tokens`);
			}
			return true;
		}
		case "/abort":
		case "/abort all": {
			await root.abort(context);
			log(c.yellow("已中止。"));
			const running = (await jobList()).filter((j) => j.status === "running");
			if (line === "/abort all") {
				for (const j of running) await app.jobs.cancel(j.id, "user", context);
				if (running.length) log(c.yellow(`后台派工 ${running.map((j) => j.id).join("、")} 也已取消。`));
			} else if (running.length) {
				log(c.dim(`后台还有 ${running.length} 个派工在跑（${running.map((j) => j.id).join("、")}），做完后结果会发回总调度。/abort all 连它们一起停。`));
			}
			return true;
		}
		case "/new":
			await root.reset(undefined, context);
			log(c.yellow("已开始新的上下文（历史仍保存在存储里）。"));
			return true;
		default:
			return false;
	}
}

function startRepl() {
	printBanner();
	log(c.dim("\n输入任务开始协作。/sessions 管理隔离会话；/agents /web /usage /abort /new /exit；运行中 Ctrl+C 中止本轮。"));
	log(c.dim("运行中：直接输入 = 插话（当前这一轮就能看到），/queue <任务> 排到下一轮；/continue 续跑中断的一轮，/compact 压缩上下文"));
	log(c.dim("项目：/goal 最终目标、/tasks 分工表、/rules 各成员的规范文件（/rules init、/rules sync）"));
	log(c.dim("后台：/jobs 后台派工（/jobs <编号>、/jobs cancel <编号|all>），/abort all 连后台派工一起停"));
	log(c.dim("改动：/changes 待合并的改动、/diff <编号>、/apply <编号>、/drop <编号>、/clean\n"));
	if (pendingChanges(app.changes).length) {
		log(c.yellow(`有 ${pendingChanges(app.changes).length} 个改动等你确认合并：`));
		printChanges(false);
		log();
	}
	const repl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${c.cyan("你 ›")} ` });
	rl = repl;
	let busy = 0;
	replIdle = () => busy === 0 && !closing;

	repl.on("SIGINT", async () => {
		if (busy === 0) return shutdown(0);
		log(c.yellow("\n正在中止本轮…"));
		await root.abort(context);
		repl.prompt();
	});

	// 命令按输入顺序一个一个执行（一次粘贴多行时，/apply 之后的 /clean 要等 /apply 做完）；
	// /abort 和 /exit 不排队，随时生效。任务不排在这里：总调度自己有输入队列。
	let commands = Promise.resolve();
	const immediate = new Set(["/abort", "/abort all", "/exit", "/quit"]);
	repl.on("line", async (raw) => {
		const line = raw.trim();
		if (!line) return repl.prompt();
		if (line.startsWith("/")) {
			const run = async () => {
				try {
					if (!(await command(line))) log(c.red(`未知命令：${line}`));
				} catch (error) {
					log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
				}
				if (!closing) repl.prompt();
			};
			if (immediate.has(line)) await run();
			else commands = commands.then(run);
			return;
		}
		// 总调度正在干活：这句话插进当前这一轮（steer），它在这一轮工具做完后就能看到；
		// 想排到下一轮用 /queue。插话和原来那一轮一起结束，提示符由原来那一轮负责打印。
		// 先同步占位，避免多行粘贴时两个 line 事件同时通过下面的“是否正在运行”检查。
		busy++;
		let running = false;
		try {
			running = (await liveState())?.run !== undefined;
		} finally {
			busy--;
		}
		if (running) {
			log(c.dim("↪ 已插入当前这一轮，总调度在下一步就会看到（想排到这一轮之后，用 /queue <任务>）"));
			repl.prompt();
			try {
				await ask(line, "steer");
			} catch (error) {
				log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
			}
			return;
		}
		busy++;
		try {
			await ask(line);
		} catch (error) {
			log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`));
		} finally {
			busy--;
			if (!closing) {
				log();
				repl.prompt();
			}
		}
	});

	repl.on("close", () => void shutdown(0));
	repl.prompt();
}

/** 新界面使用同一份命令和提交逻辑，只替换终端输入与呈现。 */
async function startTui() {
	const activeId = sessionId;
	const activeApp = app;
	let commands = Promise.resolve();
	let stopping = false;
	const immediate = new Set(["/abort", "/abort all", "/exit", "/quit"]);
	const report = (error: unknown) => { if (!closing && sessionId === activeId) log(c.red(`出错：${error instanceof Error ? error.message : String(error)}`)); };
	async function interrupt() {
		if (stopping || closing) return;
		if ((await liveState())?.run !== undefined) {
			log(c.yellow("正在中止本轮…（后台任务继续；/abort all 全部中止）"));
			await root.abort(context);
		} else {
			stopping = true;
			await shutdown(0);
		}
	}
	const ui = new AgentTerminal({
		workdir: config.workdir, model: orchestrator.describe, demo, web: admin?.url, session: sessionId, conversationId: String(root.id),
		onSubmit(text) {
			if (closing || sessionId !== activeId) return;
			if (text.startsWith("/")) {
				const run = async () => {
					if (closing || sessionId !== activeId) return;
					try { if (!(await command(text))) log(c.red(`未知命令：${text}`)); }
					catch (error) { report(error); }
					finally { refreshStatus(); }
				};
				if (immediate.has(text)) void run();
				else commands = commands.then(run);
			} else {
				// Durable 原子地决定是新一轮还是插话，避免先读状态再提交的竞态。
				void ask(text, "steer").catch(report);
			}
		},
		onInterrupt: () => { void interrupt().catch(report); },
		onExit: () => { void shutdown(0).catch(report); },
		onSessionNext: () => {
			const ids = sessionCatalog.list().map((s) => s.id);
			const next = ids[(ids.indexOf(sessionId) + 1) % ids.length]!;
			void sessionCommand(`/session use ${next}`).catch(report);
		},
		onSessionNew: () => { void sessionCommand("/session new").catch(report); },
	});
	terminalUI = ui;
	ui.editor.setText(drafts.get(sessionId) ?? "");
	setOutputSink((text) => ui.write(text));
	let latestLive: any;
	let refreshing = false;
	let refreshAgain = false;
	async function refresh() {
		if (closing || sessionId !== activeId) return;
		if (refreshing) { refreshAgain = true; return; }
		refreshing = true;
		try {
			do {
				refreshAgain = false;
				const [jobs, budget] = await Promise.all([jobList(), activeApp.harness.snapshot(RunBudget, context)]);
				if (closing || sessionId !== activeId) return;
				ui.setStatus({
					busy: latestLive?.run !== undefined,
					jobs: jobs.filter((j) => j.status === "running").map((j) => `${j.id} ${j.agent}`),
					spent: budget?.spent ?? 0, budget: config.budget.perRunUsd,
					pending: pendingChanges(app.changes).length,
				});
			} while (refreshAgain && !closing);
		} catch (error) { if (!closing) report(error); }
		finally { refreshing = false; }
	}
	const refreshStatus = () => { void refresh(); };
	activeApp.jobs.on("change", refreshStatus);
	stopTerminalStatus = () => activeApp.jobs.off("change", refreshStatus);
	try {
		ui.start();
		printBanner();
		log("输入任务开始协作。运行中发送文字会插话；/queue 排到下一轮。/tasks 看分工，/changes 看改动。");
		if (pendingChanges(app.changes).length) printChanges(false);
		stopFollowing = await follow(root, context, {
			replay: true,
			onLive(live) {
				latestLive = live;
				ui.setPartial(toViewLive(live).partial);
				refreshStatus();
			},
		});
		if (closing) { await stopFollowing(); ui.stop(); return; }
		await refresh();
	} catch (error) {
		stopTerminalStatus();
		ui.stop();
		setOutputSink(undefined);
		terminalUI = undefined;
		if (closing) return;
		throw error;
	}
}

const oneShot = argv
	.filter((a) => !a.startsWith("--"))
	.join(" ")
	.trim();
if (oneShot) {
	stopFollowing = await follow(root, context);
	harness.resume(); // 上次进程中断时没跑完的任务，从断点继续
	printBanner();
	log(`\n${c.cyan("你 ›")} ${oneShot}`);
	const settled = await ask(oneShot);
	await untilSettled();
	await shutdown(settled.status === "done" ? 0 : 1);
} else {
	await startWeb();
	const useTui = flags.has("--tui") && !flags.has("--plain") && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb";
	if (useTui) {
		await startTui().catch(async (error) => {
			log(c.yellow(`新版终端启动失败，回到普通模式：${error instanceof Error ? error.message : String(error)}`));
			stopFollowing = await follow(root, context);
			startRepl();
		});
	} else {
		if (flags.has("--tui") && !flags.has("--plain")) log(c.dim("当前不是交互终端，使用普通文本模式。"));
		stopFollowing = await follow(root, context);
		startRepl();
	}
	harness.resume();
}
