// 打开 Pi Durable Harness：SQLite 持久化 + 本机 agent 工具 + 总调度模型。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerApiMembers } from "./api-member.ts";
import { ProjectFiles } from "./board.ts";
import { ChangeStore } from "./changes.ts";
import { JobHub } from "./jobs.ts";
import { writeLine } from "./printer.ts";
import type { AppConfig } from "./config.ts";
import { createLocalAgentsExtension, type AgentAvailability } from "./tools.ts";

export interface App {
	harness: Harness;
	root: Conversation;
	agents: AgentAvailability[];
	/** 隔离派工的改动记录（worktree、分支、是否已合并） */
	changes: ChangeStore;
	/** 项目目标（GOAL.md）和分工表文件（ASSIGN.md） */
	project: ProjectFiles;
	/** 后台派工的运行时状态：取消、实时输出 */
	jobs: JobHub;
}

/**
 * Pi Durable 要求一个存储同一时间只有一个进程写入（没有跨进程锁）。
 * 同一个存储只能开一个终端进程，这里用 pid 锁文件防止两边同时打开。
 */
function acquireLock(storagePath: string): () => void {
	const lock = `${storagePath}.lock`;
	if (existsSync(lock)) {
		const pid = Number(readFileSync(lock, "utf8"));
		let alive = false;
		if (pid > 0 && pid !== process.pid) {
			try {
				process.kill(pid, 0);
				alive = true;
			} catch (error) {
				alive = (error as NodeJS.ErrnoException).code === "EPERM";
			}
		}
		if (alive) {
			throw new Error(`会话存储 ${storagePath} 正被进程 ${pid} 使用（同一个存储只能开一个 pi-agent 终端）。`);
		}
	}
	writeFileSync(lock, String(process.pid));
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
		} catch {
			/* 已删除 */
		}
	};
	process.once("exit", release);
	return release;
}

export async function openApp(
	config: AppConfig,
	orchestrator: { models: MutableModels; ref: { provider: string; modelId: string } },
	context: Context,
	options: { memory?: boolean; readOnly?: boolean } = {},
): Promise<App> {
	if (!options.memory) mkdirSync(dirname(config.storage), { recursive: true });
	const changes = new ChangeStore(`${config.storage}.changes.json`);
	const project = new ProjectFiles(config.workdir, config.projectStateDir);
	const jobs = new JobHub();
	const { extension, agents, memberExtensions } = createLocalAgentsExtension(config, changes, project, jobs);
	const registry = createRegistry();
	registry.install(extension);
	for (const ext of memberExtensions) registry.install(ext);
	// API 成员（如 DeepSeek）的模型和总调度放在同一个模型目录里
	registerApiMembers(orchestrator.models, config);

	const releaseLock = options.memory || options.readOnly ? () => {} : acquireLock(config.storage);
	const storage = options.memory ? new MemoryStorage() : await openNodeSqliteStorage(config.storage);

	const harness = await Harness.open(
		storage,
		{
			models: orchestrator.models,
			registry,
			// API 成员的读写工具通过执行环境访问文件和命令（工作目录 = 子对话的 cwd，即它的 worktree）
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workdir }),
			readOnly: options.readOnly,
			identity: { attribution: null },
			settings: {
				toolExecution: "parallel", // 同一轮里派给多个 agent 的任务并行执行
				// 默认只选派工扩展：API 成员的读写工具不给总调度（它只派活，不自己改代码）
				extensions: [extension],
				retry: { maxRetries: 3 },
				afterFailedRun: "continue",
			},
			onReport: (report) => {
				const message = report.error instanceof Error ? report.error.message : String(report.error ?? "");
				writeLine(`\n[pi-durable] ${report.kind}${message ? `: ${message}` : ""}`);
			},
		},
		context,
	);
	void harness.closed.then(releaseLock, releaseLock);

	const root = await harness.root(context, {
		agent: { model: orchestrator.ref, maxTurns: config.orchestrator.maxTurns ?? 40, cwd: config.workdir },
	});
	if (!options.readOnly) {
		// 配置文件改了模型时，让已存在的会话跟着更新
		await root.configure({ model: orchestrator.ref, maxTurns: config.orchestrator.maxTurns ?? 40, cwd: config.workdir }, context);
	}
	jobs.harness = harness;
	return { harness, root, agents, changes, project, jobs };
}
