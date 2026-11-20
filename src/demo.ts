// 演示模式：总调度用 faux 假模型（按固定剧本拆任务、派活、汇总），成员用模拟 CLI。
// 用来调试界面、给别人演示，不调用任何真实 API，也不花钱。
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AppConfig } from "./config.ts";
import type { OrchestratorModel } from "./models.ts";

const FAKE_AGENT = fileURLToPath(new URL("../scripts/fake-agent.mjs", import.meta.url));

export function demoConfig(config: AppConfig): AppConfig {
	const dataDir = join(config.storage, "..");
	const demo: AppConfig = { ...config, storage: join(dataDir, "demo.sqlite"), agents: { ...config.agents } };
	for (const kind of ["claude", "codex", "gemini"] as const) {
		demo.agents[kind] = { ...config.agents[kind], enabled: true, command: [process.execPath, FAKE_AGENT, kind], extraArgs: [] };
	}
	process.env.FAKE_AGENT_DELAY_MS ??= "4000";
	return demo;
}

function lastUserText(messages: readonly any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("");
	}
	return "";
}

export function demoOrchestrator(): OrchestratorModel {
	const faux = fauxProvider({ provider: "demo", models: [{ id: "scripted-orchestrator" }], tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);
	let round = 0;
	const step = (ctx: { messages: readonly any[] }) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") {
			const results = ctx.messages.slice().reverse();
			const lines: string[] = [];
			for (const m of results) {
				if (m.role !== "toolResult") break;
				const text = (m.content ?? []).map((b: any) => b.text ?? "").join("").split("\n")[0];
				lines.unshift(`- **${String(m.toolName).replace("ask_", "")}**：${text}`);
			}
			return fauxAssistantMessage(
				fauxText(`## 汇报\n\n两位成员都完成了：\n\n${lines.join("\n")}\n\n下一步可以让 \`gemini\` 交叉审查这次改动。`),
			);
		}
		const task = lastUserText(ctx.messages).slice(0, 80) || "演示任务";
		round++;
		return fauxAssistantMessage(
			[
				fauxText("我把这个任务拆成两部分，并行交给 Claude 和 Codex。"),
				fauxToolCall("ask_claude", { task: `阅读代码并设计方案：${task}` }, { id: `demo-c-${round}` }),
				fauxToolCall("ask_codex", { task: `实现并跑测试：${task}` }, { id: `demo-x-${round}` }),
			],
			{ stopReason: "toolUse" },
		);
	};
	// faux 的每个响应只用一次，排足够多的同一个剧本
	faux.setResponses(Array.from({ length: 500 }, () => step));
	return { models, ref: { provider: "demo", modelId: "scripted-orchestrator" }, describe: "演示模式（脚本化假模型，不花钱）" };
}
