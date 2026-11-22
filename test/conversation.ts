// 验证真正发给模型的身份、规则和历史；模拟回答只作占位，不代表真实模型的对话质量。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openApp, type App } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { AgentSessions, RunBudget } from "../src/dispatch.ts";
import { Jobs } from "../src/jobs.ts";
import { SessionCatalog } from "../src/sessions.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig();
const catalog = new SessionCatalog(config);
const primaryConfig = catalog.config("default");
const secretName = "LEMMA_CONVERSATION_TEST_SECRET";
const previousSecret = process.env[secretName];
const privateKey = "test-only-value-not-for-model-context-71826";
process.env[secretName] = privateKey;
primaryConfig.orchestrator.apiKeyEnv = [secretName];
// 故意与实际配置的 faux agent 不一致，确保模型身份来自本次请求的 Agent。
primaryConfig.orchestrator.modelId =
	"stale-config-model-should-not-identify-request";
let models = fauxOrchestrator();
let app: App | undefined;
let other: App | undefined;
let request!: TranscriptContext;
let requestModel = "";
let probe = 0;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((block) => block?.type === "text")
				.map((block) => String(block.text ?? ""))
				.join("")
		: "";
}

/** Provider 对命名 section 的替换语义：较后的 system message 更新已有 section。 */
function instructions(input: TranscriptContext): string {
	const sections = new Map<string, string>();
	const content: string[] = [];
	for (const message of input.messages) {
		if (message.role !== "system") continue;
		content.push(textOf(message.content));
		for (const [key, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(key);
			else sections.set(key, value);
		}
	}
	return [...content, ...sections.values()].join("\n");
}

function history(input: TranscriptContext): string {
	return input.messages
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		)
		.map((message) => textOf(message.content))
		.join("\n");
}

function toolNames(input: TranscriptContext): Set<string> {
	return new Set(
		input.messages
			.filter((message) => message.role === "system")
			.flatMap((message) =>
				(message.toolsAdded ?? []).map((tool) => tool.name),
			),
	);
}

async function ask(
	text: string,
	reply = `测试占位回答 ${++probe}`,
): Promise<void> {
	models.faux.setResponses([
		(input, _options, _state, model) => {
			request = structuredClone(input);
			requestModel = `${model.provider}/${model.id}`;
			return fauxAssistantMessage(fauxText(reply));
		},
	]);
	const result = await (
		await app!.root.submit({ type: "input", content: text }, context)
	).wait(context);
	assert.equal(result.status, "done", JSON.stringify(result));
}

function assertIdentity(input: TranscriptContext): string {
	const system = instructions(input);
	assert.ok(
		system.includes("Lemma（中文名：引理）"),
		"真实模型请求应携带产品身份",
	);
	assert.ok(system.includes("Lemma 是产品名称，不是基础模型名称"));
	assert.ok(system.includes("当前请求的配置模型标识：faux/faux-orchestrator"));
	assert.equal(requestModel, "faux/faux-orchestrator");
	assert.ok(system.includes(config.workdir));
	assert.ok(system.includes("目录只表示操作位置，不表示已读取其中的项目内容"));
	assert.ok(
		!system.includes(primaryConfig.orchestrator.modelId),
		"不能拿过时配置当作本次请求模型",
	);
	assert.ok(
		!JSON.stringify(input).includes(privateKey),
		"身份说明不得泄露密钥值",
	);
	return system;
}

try {
	app = await openApp(primaryConfig, models, context);
	await ask("你好", "GREETING_REPLY_MARKER");
	const system = assertIdentity(request);
	assert.ok(system.includes("当前角色：你是用户正在对话的 Lemma 总调度"));
	assert.ok(system.includes("没有执行请求时，不建目标、不建分工表、不派成员"));
	assert.ok(system.includes("普通聊天不用任务编号"));
	assert.ok(system.includes("项目目标：尚未设置"));
	assert.ok(system.includes("普通对话无需创建分工表"));
	check(
		true,
		"真实模型请求携带 Lemma 身份、当前模型和目录，普通聊天规则不要求建项目且不泄露密钥",
	);

	await ask("我想用 lemma 做项目", "USE_LEMMA_REPLY_MARKER");
	assert.ok(assertIdentity(request).includes("用户说 Lemma、lemma、引理"));
	assert.ok(instructions(request).includes("不要无故把它重新解释为 Llama"));
	assert.ok(instructions(request).includes("只需简短询问要实现什么"));
	assert.ok(
		history(request).includes("你好") &&
			history(request).includes("GREETING_REPLY_MARKER"),
	);
	await ask("lemma不是你自己吗", "CORRECTION_REPLY_MARKER");
	const correction = history(request);
	assert.ok(
		correction.includes("我想用 lemma 做项目") &&
			correction.includes("USE_LEMMA_REPLY_MARKER"),
	);
	assert.ok(instructions(request).includes("按当前系统给出的 Lemma 身份纠正"));
	assert.ok(
		instructions(request).includes("不要求用户重置、重发或重新解释名称"),
	);
	await ask("那继续聊第二个方案");
	assert.ok(history(request).includes("CORRECTION_REPLY_MARKER"));
	assert.ok(instructions(request).includes("‘这个’‘继续’‘第二个方案’"));
	check(
		true,
		"产品名称、纠正和连续追问保留真实用户与助手历史，规则明确承接已有语境",
	);

	assert.ok(
		!existsSync(app.project.goalPath) && !existsSync(app.project.assignPath),
	);
	assert.deepEqual(
		(await app.harness.snapshot(Board, context))?.tasks ?? {},
		{},
	);
	assert.deepEqual((await app.harness.snapshot(Jobs, context))?.jobs ?? {}, {});
	assert.deepEqual(
		(await app.harness.snapshot(AgentSessions, context))?.sessions ?? {},
		{},
	);
	assert.equal(
		(await app.harness.snapshot(RunBudget, context))?.dispatches ?? 0,
		0,
	);
	assert.deepEqual(fakeCalls(config), []);
	assert.equal(
		(await app.root.entries({}, 500, undefined, context)).items.filter(
			(entry) => entry.kind === "pi.tool-result",
		).length,
		0,
	);
	assert.ok(
		toolNames(request).has("plan_tasks") && toolNames(request).has("set_goal"),
	);
	check(
		true,
		"无工具的普通对话不产生目标、任务、派工或成员调用，执行工具仍按原方式注册",
	);

	await ask(
		"历史错误自我介绍测试",
		"LEGACY_WRONG_IDENTITY: 我没有被告知自己叫 Lemma。",
	);
	await app.harness.close(context);
	app = undefined;
	models = fauxOrchestrator();
	app = await openApp(primaryConfig, models, context);
	await ask("你现在确定叫什么吗");
	assert.ok(history(request).includes("LEGACY_WRONG_IDENTITY"));
	assert.ok(assertIdentity(request).includes("如果历史里的助手曾误认产品名字"));
	check(
		true,
		"重新打开原数据库保留旧记录，同时在真实请求中注入权威身份以纠正历史误认",
	);

	catalog.create("independent");
	const otherModels = fauxOrchestrator();
	other = await openApp(catalog.config("independent"), otherModels, context);
	let otherRequest!: TranscriptContext;
	otherModels.faux.setResponses([
		(input) => {
			otherRequest = structuredClone(input);
			return fauxAssistantMessage(fauxText("INDEPENDENT_REPLY_MARKER"));
		},
	]);
	assert.equal(
		(
			await (
				await other.root.submit(
					{ type: "input", content: "独立会话你好" },
					context,
				)
			).wait(context)
		).status,
		"done",
	);
	assert.ok(instructions(otherRequest).includes("Lemma（中文名：引理）"));
	assert.ok(
		!history(otherRequest).includes("LEGACY_WRONG_IDENTITY") &&
			!history(otherRequest).includes("我想用 lemma 做项目"),
	);
	assert.ok(!history(request).includes("独立会话你好"));
	check(true, "新独立会话拥有产品身份，但不继承另一会话的私有聊天");

	const storedBeforeReset = (
		await app.root.entries({}, 1000, undefined, context)
	).items;
	await app.root.reset(undefined, context);
	await ask("重置后你是谁");
	assertIdentity(request);
	assert.ok(
		!history(request).includes("LEGACY_WRONG_IDENTITY") &&
			!history(request).includes("GREETING_REPLY_MARKER"),
	);
	const storedAfterReset = (
		await app.root.entries({}, 1000, undefined, context)
	).items;
	assert.ok(
		storedBeforeReset.every((entry) =>
			storedAfterReset.some((after) => after.id === entry.id),
		),
		"重置不能删除原始条目",
	);
	check(
		true,
		"上下文重置后仍有 Lemma 身份，模型不再收到旧聊天，而原始历史完整保留",
	);

	let authorizedTools: Set<string> | undefined;
	models.faux.setResponses([
		(input) => {
			authorizedTools = toolNames(input);
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"plan_tasks",
						{
							tasks: [
								{
									title: "已授权的明确工作",
									acceptance: "保留原聊天并生成任务",
								},
							],
						},
						{ id: "authorized-conversation-plan" },
					),
				],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			[
				fauxToolCall(
					"set_goal",
					{ content: "# 已授权目标\n\n只在明确授权后创建。" },
					{ id: "authorized-conversation-goal" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("AUTHORIZED_WORK_REPLY")),
	]);
	assert.equal(
		(
			await (
				await app.root.submit(
					{ type: "input", content: "现在请创建这个项目目标并规划一项工作" },
					context,
				)
			).wait(context)
		).status,
		"done",
	);
	assert.ok(
		authorizedTools?.has("plan_tasks") && authorizedTools.has("set_goal"),
	);
	assert.equal(
		(await app.harness.snapshot(Board, context))?.tasks.T1?.title,
		"已授权的明确工作",
	);
	assert.ok(readFileSync(app.project.goalPath, "utf8").includes("已授权目标"));
	assert.ok(
		readFileSync(app.project.assignPath, "utf8").includes("已授权的明确工作"),
	);
	check(
		true,
		"对话优化保留明确授权任务的目标和分工工具，真实调用仍能持久化执行",
	);

	const child = await app.harness.createConversation(
		{ ownership: { kind: "ownerless" } },
		context,
	);
	await child.configure(
		{
			model: models.ref,
			cwd: config.workdir,
			instructions:
				"你是子调度「对话审查」；子目标：检查提示；范围：只读，不派工。",
		},
		context,
	);
	let childRequest!: TranscriptContext;
	models.faux.setResponses([
		(input) => {
			childRequest = structuredClone(input);
			return fauxAssistantMessage(fauxText("CHILD_SCOPE_REPLY"));
		},
	]);
	assert.equal(
		(
			await (
				await child.submit(
					{ type: "input", content: "检查本子目标范围" },
					context,
				)
			).wait(context)
		).status,
		"done",
	);
	const childSystem = instructions(childRequest);
	assert.ok(childSystem.includes("Lemma（中文名：引理）"));
	assert.ok(childSystem.includes("当前角色：你是 Lemma 内的子对话"));
	assert.ok(!childSystem.includes("当前角色：你是用户正在对话的 Lemma 总调度"));
	assert.ok(
		childSystem.includes("子调度「对话审查」") &&
			childSystem.includes("范围：只读，不派工"),
	);
	check(true, "共享产品身份不会覆盖子对话自己的角色、子目标和范围");
} finally {
	await Promise.allSettled([
		app?.harness.close(context),
		other?.harness.close(context),
	]);
	if (previousSecret === undefined) delete process.env[secretName];
	else process.env[secretName] = previousSecret;
}
