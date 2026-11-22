import type { Context } from "@earendil-works/chord/context";
import type { Model, Models } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Tracks configuration changes only. The chosen model itself lives in Durable's pi.agent. */
export const ModelSelection = defineDoc<{ configuredDefault?: string }>({
	kind: "lemma.model-selection", version: 1, scope: "session", initial: () => ({}), checkpointWhen: () => false,
});

export function controllerModels(models: Models, provider: string): readonly Model<any>[] {
	return models.getModels(provider);
}

export async function selectControllerModel(harness: Harness, conversation: Conversation, models: Models, provider: string, selected: { provider: string; id: string }, context: Context): Promise<void> {
	if (selected.provider !== provider || !models.getModel(provider, selected.id)) throw new Error("模型不在当前总控配置的目录中。");
	await harness.commit(async (tx) => {
		const record = await tx.conversation(conversation.id);
		const live = await tx.doc(LiveDoc, conversation.id);
		if (record?.owner) throw new Error("成员子对话由原任务管理，不能在终端切换模型。");
		if (live.run) throw new Error("总控运行中，请等待本轮结束再切换模型。");
		await configure(tx, conversation.id, { model: { provider, modelId: selected.id } });
	}, context);
}

export async function restoreControllerModel(harness: Harness, root: Conversation, models: Models, configured: { provider: string; modelId: string }, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const preference = await tx.doc(ModelSelection);
		const agent = await tx.doc(AgentDoc, root.id);
		const signature = `${configured.provider}/${configured.modelId}`;
		const stored = agent.model;
		if (preference.configuredDefault !== signature || !stored || stored.provider !== configured.provider || !models.getModel(stored.provider, stored.modelId)) await configure(tx, root.id, { model: configured });
		preference.configuredDefault = signature;
	}, context);
}

export type NativeModelCatalog = Pick<ModelRuntime, "getAvailableSnapshot" | "getModel" | "getError" | "refresh">;

/** Adapter for the four public catalog methods consumed by the pinned upstream selector.
 * It delegates to the same pi-ai Models that Harness uses. No credentials, execution or second runtime. */
export async function nativeModelCatalog(models: Models, provider: string): Promise<NativeModelCatalog> {
	let snapshot = await models.getAvailable(provider);
	return {
		getAvailableSnapshot: () => snapshot,
		getModel: (owner, id) => owner === provider ? models.getModel(owner, id) : undefined,
		getError: () => undefined,
		async refresh(options) {
			const result = await models.refresh({ ...options, allowNetwork: false, providers: [provider] });
			if (!result.aborted) snapshot = await models.getAvailable(provider, { signal: options?.signal });
			return result;
		},
	};
}
