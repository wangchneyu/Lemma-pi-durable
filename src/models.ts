// 总调度自己用的"大脑"模型。CLI agent 走各自的登录；总调度需要一个 API 模型来做拆解和汇总。
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { claudeSettingsEnv, type OrchestratorConfig } from "./config.ts";

export interface OrchestratorModel {
	models: MutableModels;
	ref: { provider: string; modelId: string };
	describe: string;
	/** 后台展示用：协议、地址、密钥来源（只说来源，不含密钥本身） */
	info?: { type: string; modelId: string; host?: string; keySource: string };
}

function resolveKey(config: OrchestratorConfig): string | undefined {
	for (const name of config.apiKeyEnv ?? []) {
		const value = process.env[name];
		if (value) return value;
	}
	if (config.apiKeyFromClaudeSettings) return claudeSettingsEnv().token;
	return undefined;
}

/** 密钥从哪里来（不返回密钥） */
function keySource(config: OrchestratorConfig): string {
	if (config.type === "builtin") return `${config.provider ?? "?"} 的标准环境变量`;
	for (const name of config.apiKeyEnv ?? []) if (process.env[name]) return `环境变量 ${name}`;
	if (config.apiKeyFromClaudeSettings && claudeSettingsEnv().token) return "~/.claude/settings.json（与 Claude CLI 共用）";
	return "未找到密钥";
}

export function createOrchestratorModel(config: OrchestratorConfig): OrchestratorModel {
	if (config.type === "builtin") {
		if (!config.provider) throw new Error("orchestrator.type=builtin 时必须填写 orchestrator.provider（例如 anthropic、openai、google）");
		const models = builtinModels();
		return {
			models,
			ref: { provider: config.provider, modelId: config.modelId },
			describe: `${config.provider}/${config.modelId}`,
			info: { type: config.type, modelId: config.modelId, keySource: keySource(config) },
		};
	}

	const id = "orchestrator";
	const api = config.type === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
	const baseUrl =
		config.baseUrl ??
		(config.type === "anthropic-compatible" ? (claudeSettingsEnv().baseUrl ?? "https://api.anthropic.com") : undefined);
	if (!baseUrl) throw new Error("orchestrator.type=openai-compatible 时必须填写 orchestrator.baseUrl");

	const model: Model<typeof api> = {
		id: config.modelId,
		name: config.modelId,
		api,
		provider: id,
		baseUrl,
		reasoning: false,
		input: ["text"],
		// 中转站模型没有内置定价：配了 orchestrator.price 才能算出总调度的花费
		cost: {
			input: config.price?.input ?? 0,
			output: config.price?.output ?? 0,
			cacheRead: config.price?.cacheRead ?? config.price?.input ?? 0,
			cacheWrite: config.price?.input ?? 0,
		},
		contextWindow: config.contextWindow ?? 200_000,
		maxTokens: config.maxTokens ?? 16_000,
	};
	const provider = createProvider({
		id,
		name: "Orchestrator",
		baseUrl,
		auth: {
			apiKey: {
				name: "Orchestrator API key",
				resolve: async () => {
					const key = resolveKey(config);
					return key ? { auth: { apiKey: key }, source: "Lemma config" } : undefined;
				},
			},
		},
		models: [...new Set([config.modelId, ...(config.modelIds ?? [])])].map((id) => ({ ...model, id, name: id })),
		api: config.type === "anthropic-compatible" ? anthropicMessagesApi() : openAICompletionsApi(),
	});
	const models = createModels();
	models.setProvider(provider);
	const host = new URL(baseUrl).host;
	return {
		models,
		ref: { provider: id, modelId: config.modelId },
		describe: `${config.type} ${host} / ${config.modelId}`,
		info: { type: config.type, modelId: config.modelId, host, keySource: keySource(config) },
	};
}
