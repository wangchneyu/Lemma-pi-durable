// 打开 Pi Durable Harness：SQLite 持久化 + 本机 agent 工具 + 总调度模型。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppConfig } from "./config.ts";
import { createLocalAgentsExtension, type AgentAvailability } from "./tools.ts";

export interface App {
	harness: Harness;
	root: Conversation;
	agents: AgentAvailability[];
}

export async function openApp(
	config: AppConfig,
	orchestrator: { models: MutableModels; ref: { provider: string; modelId: string } },
	context: Context,
	options: { memory?: boolean; readOnly?: boolean } = {},
): Promise<App> {
	const { extension, agents } = createLocalAgentsExtension(config);
	const registry = createRegistry();
	registry.install(extension);

	if (!options.memory) mkdirSync(dirname(config.storage), { recursive: true });
	const storage = options.memory ? new MemoryStorage() : await openNodeSqliteStorage(config.storage);

	const harness = await Harness.open(
		storage,
		{
			models: orchestrator.models,
			registry,
			readOnly: options.readOnly,
			identity: { attribution: null },
			settings: {
				toolExecution: "parallel", // 同一轮里派给多个 agent 的任务并行执行
				retry: { maxRetries: 3 },
				afterFailedRun: "continue",
			},
			onReport: (report) => {
				const message = report.error instanceof Error ? report.error.message : String(report.error ?? "");
				console.error(`\n[pi-durable] ${report.kind}${message ? `: ${message}` : ""}`);
			},
		},
		context,
	);

	const root = await harness.root(context, {
		agent: { model: orchestrator.ref, maxTurns: config.orchestrator.maxTurns ?? 40, cwd: config.workdir },
	});
	if (!options.readOnly) {
		// 配置文件改了模型时，让已存在的会话跟着更新
		await root.configure({ model: orchestrator.ref, maxTurns: config.orchestrator.maxTurns ?? 40, cwd: config.workdir }, context);
	}
	return { harness, root, agents };
}
