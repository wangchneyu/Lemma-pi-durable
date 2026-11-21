// API 成员（比如 DeepSeek）：不需要本机装 CLI。pi-agent 直接调模型 API，在 Pi Durable 里开一个子对话，
// 让它用内置的 read / write / edit / bash 工具在（隔离的）工作目录里干活。
// 子对话本身是持久的：进程崩溃后重启，Pi Durable 会接着跑；会话 ID 就是子对话的编号，续接 = 往同一个子对话再发一条。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AssistantEntry, configure, defineExtension, type EntryRecord, type Extension, type Harness } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ParsedResult, TokenUsage } from "./agents.ts";
import type { AgentConfig, AgentKind, ApiMemberConfig, AppConfig } from "./config.ts";
import type { DispatchIO } from "./dispatch.ts";
import type { JobHub } from "./jobs.ts";

/** API 成员在模型目录里的 provider 名 */
export const memberProvider = (kind: AgentKind) => `member-${kind}`;

/** 密钥：按顺序读环境变量（不打印） */
export function memberKey(api: ApiMemberConfig): { key?: string; source: string } {
	for (const name of api.apiKeyEnv) {
		const value = process.env[name];
		if (value) return { key: value, source: `环境变量 ${name}` };
	}
	return { source: `未找到密钥（设置环境变量 ${api.apiKeyEnv.join(" / ")}）` };
}

/** 这个成员可选的模型 ID（清单 + 默认） */
export function memberModelIds(agent: AgentConfig): string[] {
	const ids = agent.models.map((m) => m.id);
	if (agent.defaultModel && !ids.includes(agent.defaultModel)) ids.unshift(agent.defaultModel);
	return ids;
}

/** API 成员能不能用：启用、配了模型、有密钥 */
export function memberAvailability(agent: AgentConfig): { available: boolean; reason?: string } {
	if (!agent.enabled) return { available: false, reason: "配置中已禁用" };
	if (!agent.api) return { available: false, reason: "不是 API 成员" };
	if (!memberModelIds(agent).length) return { available: false, reason: "没有配置模型（填 models / defaultModel，模型名以服务商文档为准）" };
	if (!memberKey(agent.api).key) return { available: false, reason: memberKey(agent.api).source };
	return { available: true };
}

/** 把 API 成员的模型注册进 Harness 用的模型目录（和总调度共用一个目录，provider 名不同） */
export function registerApiMembers(models: MutableModels, config: AppConfig): void {
	for (const [kind, agent] of Object.entries(config.agents) as [AgentKind, AgentConfig][]) {
		const api = agent.api;
		if (!api || !agent.enabled) continue;
		const ids = memberModelIds(agent);
		if (!ids.length) continue;
		const protocol = api.type === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
		const list: Model<typeof protocol>[] = ids.map((id) => {
			const price = agent.models.find((m) => m.id === id)?.price;
			return {
				id,
				name: id,
				api: protocol,
				provider: memberProvider(kind),
				baseUrl: api.baseUrl,
				reasoning: false,
				input: ["text"],
				// 配了单价才能算出花费；没配时为 0，后台显示「未报告」
				cost: { input: price?.input ?? 0, output: price?.output ?? 0, cacheRead: price?.cacheRead ?? price?.input ?? 0, cacheWrite: price?.input ?? 0 },
				contextWindow: api.contextWindow ?? 128_000,
				maxTokens: api.maxTokens ?? 8192,
			};
		});
		models.setProvider(
			createProvider({
				id: memberProvider(kind),
				name: kind,
				baseUrl: api.baseUrl,
				auth: {
					apiKey: {
						name: `${kind} API key`,
						resolve: async () => {
							const { key } = memberKey(api);
							return key ? { auth: { apiKey: key }, source: "pi-agent config" } : undefined;
						},
					},
				},
				models: list,
				api: api.type === "anthropic-compatible" ? anthropicMessagesApi() : openAICompletionsApi(),
			}),
		);
	}
}

const SHELL_OPERATORS = /[;&|`<>\r\n]|\$\(/;

/** bash 白名单：只放行以允许的命令开头、而且没有串接 / 重定向的命令。返回拒绝原因，放行返回 undefined */
export function bashRefusal(command: string, api: ApiMemberConfig): string | undefined {
	if (api.bash === "all") return undefined;
	if (api.bash === "off") return "这个成员没有开放 bash。";
	const c = command.trim();
	if (SHELL_OPERATORS.test(c)) return "不允许用 ; && || | ` $() > < 串接命令或重定向，一次只运行一条命令。";
	if (api.bashAllow.some((p) => c === p || c.startsWith(`${p} `))) return undefined;
	return `命令不在允许清单里。允许以这些开头的命令：${api.bashAllow.join("、")}。需要别的操作请用 read / write / edit 完成，或在汇报里说明。`;
}

/** API 成员的工具：读、写、改文件，加上按白名单放行的 bash */
export function createMemberTools(kind: AgentKind, api: ApiMemberConfig): Extension {
	const tools: any[] = [createReadTool(), createWriteTool(), createEditTool()];
	if (api.bash !== "off") {
		tools.push(
			createBashTool({
				prepare: (execution) => {
					const refusal = bashRefusal(execution.command, api);
					if (refusal) throw new Error(refusal);
				},
			}),
		);
	}
	return defineExtension({ name: `pi-agent-member-${kind}`, tools });
}

/** 给 API 成员的工作说明（相当于 CLI 自带的系统提示）；项目的共同规则也带上 */
export function memberInstructions(kind: AgentKind, api: ApiMemberConfig, workdir: string, label: string): string {
	const rulesFile = join(workdir, ".pi-agent", "RULES.md");
	const rules = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8").trim().slice(0, 6000) : "";
	return [
		`你是 pi-agent 团队里的成员 ${label}（${kind}），由总调度派活。你在当前工作目录里完成交给你的任务。`,
		"- 用 read 读文件，用 edit 精确修改，用 write 新建或整体重写文件。路径相对当前工作目录。",
		api.bash === "off"
			? "- 你没有 bash，不能运行命令。"
			: api.bash === "all"
				? "- 可以用 bash 运行命令（测试、构建、查看）。"
				: `- 可以用 bash 运行这些命令（一次一条，不能串接或重定向）：${api.bashAllow.join("、")}。别的命令会被拒绝。`,
		"- 只做任务范围内的改动，不要顺手重构无关代码，不要提交 git（pi-agent 会替你提交到独立分支）。",
		"- 做完后用中文简要汇报：做了什么、改了哪些文件、测试结果、还有什么没做或有风险。",
		...(rules ? ["", "项目的共同规则（.pi-agent/RULES.md）：", rules] : []),
	].join("\n");
}

export type ExecOutcome = {
	aborted: boolean;
	timedOut: boolean;
	durationMs: number;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	parsed?: ParsedResult;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text ?? ""))
		.join("");
}

function short(value: unknown, max = 100): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const one = (text ?? "").replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 子对话里新出现的条目 → 和 CLI 一样格式的进度行（🔧 工具、💬 说明、❌ 出错） */
function progressLines(entry: EntryRecord): string[] {
	const m = entry.model?.[0] as any;
	if (!m) return [];
	if (entry.kind === "pi.assistant") {
		const out: string[] = [];
		for (const b of m.content ?? []) {
			if (b.type === "text" && b.text?.trim()) out.push(`💬 ${short(b.text, 120)}`);
			if (b.type === "toolCall") {
				const a = b.arguments ?? {};
				out.push(`🔧 ${b.name} ${short(a.path ?? a.command ?? a, 100)}`);
			}
		}
		if (m.stopReason === "error" && m.errorMessage) out.push(`❌ 模型出错：${short(m.errorMessage, 200)}`);
		return out;
	}
	if (entry.kind === "pi.tool-result" && m.isError) return [`❌ ${m.toolName}：${short(textOf(m.content), 160)}`];
	return [];
}

export async function runApiMember(o: {
	harness: Harness;
	hub: JobHub;
	kind: AgentKind;
	api: ApiMemberConfig;
	tools: Extension;
	model: string;
	cwd: string;
	prompt: string;
	resumeId?: string;
	instructions: string;
	io: DispatchIO;
	timeoutMs: number;
	onSession: (id: string) => void;
}): Promise<ExecOutcome> {
	const { harness, io } = o;
	const started = Date.now();
	const ctx = BACKGROUND_CONTEXT;
	const ref = { provider: memberProvider(o.kind), modelId: o.model };
	const fail = (text: string): ExecOutcome => ({ aborted: false, timedOut: false, durationMs: Date.now() - started, exitCode: 1, stdout: "", stderr: "", parsed: { text, isError: true } });

	// ---- 子对话：续接用原来的；新会话由这次派工的任务拥有（重放时按拥有者找回同一个） ----
	let conversationId: string;
	try {
		conversationId = await io.commit(async (tx) => {
			if (o.resumeId) {
				const record = await tx.conversation(o.resumeId as any);
				if (!record) throw new Error(`找不到会话 ${o.resumeId}`);
				await configure(tx, record.id, { model: ref, cwd: o.cwd, instructions: o.instructions });
				return String(record.id);
			}
			const existing = (await tx.scanConversations({ ownerTaskId: io.taskId as any }, 1)).items[0];
			if (existing) return String(existing.id);
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: io.taskId as any } });
			await configure(tx, created.id, { model: ref, extensions: [o.tools], instructions: o.instructions, cwd: o.cwd, maxTurns: o.api.maxTurns ?? 40 });
			return String(created.id);
		});
	} catch (error) {
		return fail(`没能建立 ${o.kind} 的会话：${error instanceof Error ? error.message : String(error)}`);
	}
	o.onSession(conversationId);
	const conversation = await harness.conversation(conversationId as any, ctx);
	if (!conversation) return fail(`找不到会话 ${conversationId}`);

	// ---- 进度：把子对话里的新条目转成进度行 ----
	const watch = await conversation.watch(ctx);
	const seen = new Set(watch.value.entries.map((e) => e.id));
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		for (const entry of call.value.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			for (const line of progressLines(entry)) io.output(`${line}\n`);
		}
	});

	// ---- 中止和超时：停掉子对话（进程关闭时不停，重启后子对话会接着跑） ----
	let aborted = false;
	let timedOut = false;
	const stop = () => void conversation.abort(BACKGROUND_CONTEXT).catch(() => {});
	const onAbort = () => {
		aborted = true;
		if (!o.hub.closing) stop();
	};
	if (io.signal.aborted) onAbort();
	else io.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, o.timeoutMs);
	timer.unref?.();

	try {
		const submission = await conversation.submit({ type: "input", content: o.prompt, requestId: `pi-agent:dispatch:${io.taskId}`, whenBusy: "followUp" }, ctx);
		const settled = (await submission.wait(ctx)) as any;
		const durationMs = Date.now() - started;
		if (aborted || timedOut) return { aborted, timedOut, durationMs, exitCode: null, stdout: "", stderr: "" };

		// 这次提交之后的条目：最终回答、用量、花费
		const entries: EntryRecord[] = [];
		let cursor: any;
		do {
			const page = await conversation.entries({ order: "ascending", minEntryId: settled.entry } as any, 500, cursor, ctx);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0 };
		let cost = 0;
		let answer = "";
		for (const e of entries) {
			if (!AssistantEntry.is(e)) continue;
			const m = e.model?.[0] as any;
			usage.input += m?.usage?.input ?? 0;
			usage.output += m?.usage?.output ?? 0;
			usage.cacheRead! += m?.usage?.cacheRead ?? 0;
			cost += m?.usage?.cost?.total ?? 0;
			const t = textOf(m?.content).trim();
			if (t) answer = t;
		}
		const done = settled.status === "done";
		const reason = settled.reason ? `（${settled.reason}${settled.detail ? `：${settled.detail}` : ""}）` : "";
		return {
			aborted: false,
			timedOut: false,
			durationMs,
			exitCode: done ? 0 : 1,
			stdout: "",
			stderr: "",
			parsed: {
				text: done ? answer || "（没有文字输出）" : `${o.kind} 没有完成${reason}${answer ? `\n\n最后的输出：\n${answer}` : ""}`,
				sessionId: conversationId,
				isError: !done,
				costUsd: cost > 0 ? cost : undefined,
				model: o.model,
				usage,
			},
		};
	} catch (error) {
		if (aborted || io.signal.aborted) return { aborted: true, timedOut, durationMs: Date.now() - started, exitCode: null, stdout: "", stderr: "" };
		return fail(`${o.kind} 执行出错：${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
		io.signal.removeEventListener("abort", onAbort);
		await watch.stop().catch(() => {});
	}
}
