// 演示模式：总调度用 faux 假模型（按固定剧本拆任务、派活、汇总），成员用模拟 CLI，
// 工作目录是一个独立的沙盒 git 仓库（data/demo-workspace），演示派工不会在你的真实仓库里建分支。
// 用来调试界面、给别人演示，不调用任何真实 API，也不花钱。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentConfig, AppConfig } from "./config.ts";
import type { OrchestratorModel } from "./models.ts";

const FAKE_AGENT = fileURLToPath(new URL("../scripts/fake-agent.mjs", import.meta.url));

/** 演示用的模型清单（名称、单价都是演示数据） */
const DEMO_MODELS: Record<"claude" | "codex" | "gemini", Pick<AgentConfig, "models" | "defaultModel">> = {
	claude: {
		defaultModel: "claude-sonnet-5-5",
		models: [
			{ id: "claude-haiku-5-5", tier: "economy", note: "简单、机械的活" },
			{ id: "claude-sonnet-5-5", tier: "standard", note: "日常默认" },
			{ id: "claude-opus-5-5", tier: "premium", note: "复杂设计、严格审查" },
		],
	},
	codex: {
		defaultModel: "codex-standard-demo",
		models: [
			{ id: "codex-economy-demo", tier: "economy", note: "小改动", price: { input: 0.3, output: 2.4 } },
			{ id: "codex-standard-demo", tier: "standard", note: "实现功能、跑测试", price: { input: 1.25, output: 10 } },
		],
	},
	gemini: {
		defaultModel: "gemini-3.5-flash-lite",
		models: [{ id: "gemini-3.5-flash-lite", tier: "economy", note: "通读、调研、第二意见", price: { input: 0.1, output: 0.4 } }],
	},
};

/** 沙盒仓库：第一次进演示模式时创建，里面放一个小项目 */
function ensureDemoWorkspace(dir: string): string {
	if (existsSync(join(dir, ".git"))) return dir;
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# 演示项目\n\npi-agent 演示模式的沙盒仓库。成员的改动都在独立的 worktree 里，用 /apply 合并到这里。\n");
	writeFileSync(join(dir, "src", "cart.ts"), "export function total(items: { price: number; qty: number }[]) {\n\treturn items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n");
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", windowsHide: true });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.name=pi-agent", "-c", "user.email=pi-agent@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "演示项目初始版本");
	return dir;
}

export function demoConfig(config: AppConfig): AppConfig {
	const dataDir = join(config.storage, "..");
	const workdir = ensureDemoWorkspace(join(dataDir, "demo-workspace"));
	const demo: AppConfig = { ...config, workdir, storage: join(dataDir, "demo.sqlite"), agents: { ...config.agents } };
	for (const kind of ["claude", "codex", "gemini"] as const) {
		demo.agents[kind] = { ...config.agents[kind], enabled: true, command: [process.execPath, FAKE_AGENT, kind], extraArgs: [], ...DEMO_MODELS[kind] };
	}
	demo.budget = { perRunUsd: 0.5 };
	process.env.FAKE_AGENT_DELAY_MS ??= "4000";
	process.env.FAKE_AGENT_JITTER ??= "1";
	// 只有工作目录是沙盒仓库时才让模拟 CLI 写文件
	if (workdir.startsWith(dataDir)) process.env.FAKE_AGENT_WRITE ??= "1";
	return demo;
}

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b: any) => b.text ?? "").join(""));

function lastUserText(messages: readonly any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return textOf(messages[i]);
	return "";
}

/** 从历史里找某个成员最近一次的 session_id（演示"继续"时续接） */
function lastSession(messages: readonly any[], agent: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "toolResult" || m.toolName !== `ask_${agent}`) continue;
		const id = textOf(m).match(/session_id: ([\w-]+)/)?.[1];
		if (id) return id;
	}
	return undefined;
}

export function demoOrchestrator(): OrchestratorModel {
	const faux = fauxProvider({ provider: "demo", models: [{ id: "scripted-orchestrator" }], tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);
	let round = 0;
	const run = Date.now().toString(36); // 让每次启动的工具调用 ID 都不重复
	let reviewPending: string | undefined; // 剧本二：Codex 实现完后，下一步让 Claude 基于它的改动审查

	const step = (ctx: { messages: readonly any[] }) => {
		let messages = ctx.messages;
		let last = messages.at(-1);
		const id = (k: string) => ({ id: `demo-${k}-${run}-${round}` });
		// 插话（steer）：放在一轮工具结果之后的用户消息。不当成新任务，而是带进这一轮接下来的步骤
		let steer: string | undefined;
		if (last?.role === "user" && messages.at(-2)?.role === "toolResult") {
			steer = textOf(last);
			messages = messages.slice(0, -1);
			last = messages.at(-1);
		}
		const heard = steer ? `收到你的插话：「${steer}」，已按它调整。\n\n` : "";
		if (last?.role === "toolResult") {
			const results: any[] = [];
			for (const m of messages.slice().reverse()) {
				if (m.role !== "toolResult") break;
				results.unshift(m);
			}
			// 剧本二的第二步：基于 Codex 的改动让 Claude 审查（串行）
			if (reviewPending && results.some((m) => m.toolName === "ask_codex")) {
				const change = textOf(results.find((m) => m.toolName === "ask_codex")).match(/改动 #(\w+)/)?.[1];
				const task = reviewPending;
				reviewPending = undefined;
				if (change) {
					return fauxAssistantMessage(
						[
							fauxText(`${heard}Codex 完成了实现（改动 #${change}）。接着让 Claude 用强力模型基于这个改动做审查。`),
							fauxToolCall(
								"ask_claude",
								{ task: `审查改动 #${change} 并补充文档：${task}${steer ? `（用户补充：${steer}）` : ""}`, model: "claude-opus-5-5", based_on: change },
								id("r"),
							),
						],
						{ stopReason: "toolUse" },
					);
				}
			}
			const lines = results.map((m) => {
				const t = textOf(m);
				const change = t.match(/\[改动 #(\w+)：([^\]]*)\]/);
				const model = t.match(/模型: ([^ |\]]+)/)?.[1];
				return `- **${String(m.toolName).replace("ask_", "")}**${model ? `（${model}）` : ""}：${t.split("\n")[0]}${change ? `　改动 \`#${change[1]}\`：${change[2].split("，")[0]}` : ""}`;
			});
			const failed = results.some((m) => m.isError);
			const changes = [...new Set(results.map((m) => textOf(m).match(/改动 #(\w+)：\d+ 个文件/)?.[1]).filter(Boolean))];
			return fauxAssistantMessage(
				fauxText(
					`## 汇报\n\n${heard}${failed ? "有成员没有完成：" : "成员都完成了："}\n\n${lines.join("\n")}\n\n` +
						(changes.length ? `改动都在独立分支里，还没有进入主目录。确认没问题后在终端执行 \`/apply ${changes.join(" ")}\`（逐个），或 \`/apply all\`。\n\n` : "") +
						(failed ? "失败的部分需要再派一次，或者先看看报错。" : "下一步可以让另一位成员交叉审查。"),
				),
			);
		}

		const task = lastUserText(ctx.messages).slice(0, 80) || "演示任务";
		// 提问：不派工，直接回答
		if (/[?？]$|什么|多少|怎么样/.test(task)) {
			return fauxAssistantMessage(
				fauxText(
					"这个问题不需要派工，我直接回答：\n\n" +
						Object.entries(DEMO_MODELS)
							.map(([k, v]) => `- **${k}**：默认 \`${v.defaultModel}\`，可选 ${v.models.map((m) => `\`${m.id}\`（${m.tier}）`).join("、")}`)
							.join("\n") +
						"\n\n派工时我会按任务难度选：简单的用经济档，复杂设计和严格审查才用强力档。",
				),
			);
		}
		round++;
		// 继续：续接 Claude 上一次的会话
		if (/继续|接着/.test(task)) {
			const sid = lastSession(ctx.messages, "claude");
			if (sid) {
				return fauxAssistantMessage(
					[fauxText("在 Claude 上次的会话里继续（同一个上下文、同一个副本）。"), fauxToolCall("ask_claude", { task: `继续上次的工作：${task}`, session_id: sid }, id("c"))],
					{ stopReason: "toolUse" },
				);
			}
		}
		// 轮换几种剧本，让后台每种状态都有东西可看
		const scene = (round - 1) % 3;
		if (scene === 1) {
			reviewPending = task;
			return fauxAssistantMessage(
				[fauxText("先让 Codex 实现，完成后再让 Claude 基于它的改动审查。"), fauxToolCall("ask_codex", { task: `实现并跑测试：${task}` }, id("x"))],
				{ stopReason: "toolUse" },
			);
		}
		if (scene === 2) {
			return fauxAssistantMessage(
				[
					fauxText("三位成员并行：Claude 用经济档写文档，Codex 实现，Gemini 审查。"),
					fauxToolCall("ask_claude", { task: `整理文档：${task}`, model: "claude-haiku-5-5" }, id("c")),
					fauxToolCall("ask_codex", { task: `实现并跑测试（演示：模拟失败）：${task}` }, id("x")),
					fauxToolCall("ask_gemini", { task: `通读并列出风险：${task}` }, id("g")),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(
			[
				fauxText("我把这个任务拆成两部分，并行交给 Claude 和 Codex。"),
				fauxToolCall("ask_claude", { task: `阅读代码并设计方案：${task}` }, id("c")),
				fauxToolCall("ask_codex", { task: `实现并跑测试：${task}`, model: "codex-standard-demo" }, id("x")),
			],
			{ stopReason: "toolUse" },
		);
	};
	// faux 的每个响应只用一次，排足够多的同一个剧本
	faux.setResponses(Array.from({ length: 500 }, () => step));
	return {
		models,
		ref: { provider: "demo", modelId: "scripted-orchestrator" },
		describe: "演示模式（脚本化假模型，不花钱）",
		info: { type: "demo", modelId: "scripted-orchestrator", keySource: "不需要密钥" },
	};
}
