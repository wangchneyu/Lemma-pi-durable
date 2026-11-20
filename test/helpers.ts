// 测试共用：模拟 CLI 的配置 + faux 总调度模型（不调用真实 API、不花钱）。
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type Conversation } from "@earendil-works/pi-durable";
import { loadConfig, type AppConfig } from "../src/config.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

export function testConfig(dir = mkdtempSync(join(tmpdir(), "pi-agent-test-"))): AppConfig {
	const config = loadConfig(join(dir, "missing.json"));
	config.workdir = dir;
	config.storage = join(dir, "session.sqlite");
	for (const kind of ["claude", "codex", "gemini"] as const) {
		config.agents[kind].command = [process.execPath, FAKE_AGENT, kind];
		config.agents[kind].extraArgs = [];
	}
	process.env.FAKE_AGENT_LOG = join(dir, "calls.jsonl");
	return config;
}

export function fakeCalls(config: AppConfig): Array<{ kind: string; args: string[]; prompt: string; cwd: string }> {
	const file = join(config.workdir, "calls.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

export function fauxOrchestrator() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-orchestrator" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, ref: { provider: "faux", modelId: "faux-orchestrator" } };
}

export function check(condition: unknown, message: string): void {
	if (!condition) {
		console.error(`✗ ${message}`);
		process.exitCode = 1;
		throw new Error(message);
	}
	console.log(`✓ ${message}`);
}

/** 对话中最后一条总调度回答的文字 */
export async function lastAnswer(root: Conversation, context: Context): Promise<string> {
	const page = await root.entries({}, 500, undefined, context);
	const answers = page.items.filter((e) => AssistantEntry.is(e)).sort((a, b) => Number(b.id) - Number(a.id)); // 最新在前
	const message = answers[0]?.model?.[0] as any;
	return (message?.content ?? [])
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("");
}

/** 从模型请求上下文里取出所有工具结果文本 */
export function toolResults(context: { messages: readonly any[] }): Array<{ name: string; text: string; isError: boolean }> {
	return context.messages
		.filter((m) => m.role === "toolResult")
		.map((m) => ({
			name: m.toolName,
			isError: !!m.isError,
			text: (m.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join(""),
		}));
}
