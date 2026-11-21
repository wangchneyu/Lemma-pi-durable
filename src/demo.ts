// 演示模式：总调度用 faux 假模型（按固定剧本拆任务、派活、汇总），成员用模拟 CLI，
// 工作目录是一个独立的沙盒 git 仓库（data/demo-workspace），演示派工不会在你的真实仓库里建分支。
// 用来调试界面、给别人演示，不调用任何真实 API，也不花钱。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { MutableModels } from "@earendil-works/pi-ai";
import { memberProvider } from "./api-member.ts";
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
	// DeepSeek 是 API 成员：演示里用脚本化的假模型（installDemoMember），它会真的调用 write / bash 工具
	demo.agents.deepseek = {
		...config.agents.deepseek,
		enabled: true,
		defaultModel: "deepseek-demo",
		models: [{ id: "deepseek-demo", tier: "economy", note: "演示用的假模型", price: { input: 0.3, output: 1.2 } }],
		api: { ...config.agents.deepseek.api!, apiKeyEnv: ["PI_AGENT_DEMO_KEY"] },
	};
	process.env.PI_AGENT_DEMO_KEY ??= "demo-placeholder";
	demo.budget = { perRunUsd: 0.5 };
	// 演示的角色和剧本对上：Claude 设计 / 审查，Codex 编码，Gemini 调研
	demo.roles = [
		{ name: "设计", agent: "claude", note: "方案、文档" },
		{ name: "编码", agent: "codex", note: "实现功能、跑测试" },
		{ name: "实现", agent: "deepseek", fallback: ["codex"], note: "按设计写代码（便宜）" },
		{ name: "审查", agent: "claude", model: "claude-opus-5-5", note: "严格审查、核对验收标准" },
		{ name: "调研", agent: "gemini", note: "通读、列风险" },
	];
	// 沙盒仓库里放一份示例目标：成员每次派工都会拿到它
	const goal = join(workdir, ".pi-agent", "GOAL.md");
	if (!existsSync(goal)) {
		mkdirSync(join(workdir, ".pi-agent"), { recursive: true });
		writeFileSync(
			goal,
			"# 演示项目目标\n\n做一个可靠的购物车模块：支持优惠券、分页的订单列表和完整的测试。\n\n## 验收标准\n\n- npm test 全部通过\n- 每个对外函数都有说明\n\n## 约束\n\n- 不引入新的依赖\n",
		);
	}
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

/**
 * 演示用的 DeepSeek：脚本化假模型，走和真实 API 成员一样的路径（Pi Durable 子对话 + read / write / bash 工具），
 * 会在它的 worktree 里真的写一个文件、跑一条白名单命令，然后汇报。打开 Harness 之后调用（替换掉真实的 provider）。
 */
export function installDemoMember(models: MutableModels): void {
	const faux = fauxProvider({ provider: memberProvider("deepseek"), models: [{ id: "deepseek-demo" }], tokensPerSecond: 80 });
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const delay = Number(process.env.FAKE_AGENT_DELAY_MS ?? 4000);
	let n = 0;
	const step = async (ctx: { messages: readonly any[] }) => {
		let messages = ctx.messages;
		while (messages.at(-1)?.role === "system") messages = messages.slice(0, -1);
		const last = messages.at(-1);
		await sleep(delay / 3);
		if (last?.role === "user") {
			const task = (textOf(last).split("【本次要做的事】").at(-1) ?? "").trim().slice(0, 40);
			const slug = `${Date.now().toString(36).slice(-4)}${n++}`;
			return fauxAssistantMessage(
				[
					fauxText("先看一下目录，再按设计写实现。"),
					fauxToolCall("bash", { command: "ls" }, { id: `ds-ls-${slug}` }),
					fauxToolCall("write", { path: `src/ds-${slug}.ts`, content: `// DeepSeek（演示）：${task}\nexport const done = true;\n` }, { id: `ds-w-${slug}` }),
				],
				{ stopReason: "toolUse" },
			);
		}
		const wrote = messages.filter((m: any) => m.role === "toolResult" && m.toolName === "write").length;
		return fauxAssistantMessage(fauxText(`DEEPSEEK_OK：按设计写好了实现（新建 ${wrote} 个文件），用 ls 确认了目录结构。演示环境没有 npm test，测试留给审查确认。`));
	};
	faux.setResponses(Array.from({ length: 2000 }, () => step));
	models.setProvider(faux.provider);
}

export function demoOrchestrator(): OrchestratorModel {
	const faux = fauxProvider({ provider: "demo", models: [{ id: "scripted-orchestrator" }], tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);
	let round = 0;
	const run = Date.now().toString(36); // 让每次启动的工具调用 ID 都不重复
	/**
	 * 一轮项目流程：plan（拆任务）→ work（按角色派工）→ review（剧本二：基于实现做审查）→ accept（验收）→ report。
	 * 每个剧本的任务：[标题前缀, 角色, 成员, 额外参数, 依赖]
	 */
	type Step = { title: string; role: string; agent: "claude" | "codex" | "gemini" | "deepseek"; args?: Record<string, unknown>; acceptance: string; deps?: string[] };
	const SCENES: { intro: string; steps: Step[]; sequential?: boolean; async?: boolean }[] = [
		{
			intro: "设计（Claude）、实现（DeepSeek）、调研（Gemini）互不依赖，放到后台并行；审查要等实现完成后再基于它的改动开工。",
			async: true,
			steps: [
				{ title: "设计方案", role: "设计", agent: "claude", acceptance: "方案写清楚接口和边界情况" },
				{ title: "实现并跑测试", role: "实现", agent: "deepseek", acceptance: "npm test 全部通过" },
				{ title: "调研并列出风险", role: "调研", agent: "gemini", acceptance: "列出至少 3 条风险" },
				{ title: "审查实现", role: "审查", agent: "claude", args: { model: "claude-opus-5-5" }, acceptance: "没有阻塞性问题", deps: ["+2"] },
			],
		},
		{
			intro: "拆成设计和编码两项，并行派给 Claude 和 Codex。",
			steps: [
				{ title: "设计方案", role: "设计", agent: "claude", acceptance: "方案写清楚接口和边界情况" },
				{ title: "实现并跑测试", role: "编码", agent: "codex", args: { model: "codex-standard-demo" }, acceptance: "npm test 全部通过" },
			],
		},
		{
			intro: "先由 Codex 实现，完成后再让 Claude 基于它的改动审查（T 依赖关系写进分工表）。",
			sequential: true,
			steps: [
				{ title: "实现并跑测试", role: "编码", agent: "codex", acceptance: "npm test 全部通过" },
				{ title: "审查实现", role: "审查", agent: "claude", args: { model: "claude-opus-5-5" }, acceptance: "没有阻塞性问题", deps: ["+1"] },
			],
		},
		{
			intro: "三项并行：Claude 用经济档写文档，Codex 实现，Gemini 调研风险。",
			steps: [
				{ title: "整理文档", role: "设计", agent: "claude", args: { model: "claude-haiku-5-5" }, acceptance: "README 说明用法" },
				{ title: "实现并跑测试（演示：模拟失败）", role: "编码", agent: "codex", acceptance: "npm test 全部通过" },
				{ title: "调研并列出风险", role: "调研", agent: "gemini", acceptance: "列出至少 3 条风险" },
			],
		},
	];
	let flow:
		| {
				scene: (typeof SCENES)[number];
				task: string;
				ids: string[];
				next: number;
				results: any[];
				phase: "plan" | "work" | "accept";
				/** 异步剧本：后台编号 → 第几项任务、是否结束、结果 */
				jobs?: Record<string, { step: number; done: boolean; ok?: boolean; change?: string; agent?: string; model?: string }>;
				reviewSent?: boolean;
		  }
		| undefined;

	/** 从后台结果（wait_jobs 的返回或自动发回的消息）里认出哪些后台派工结束了 */
	const finishedJobs = (text: string) =>
		[...text.matchAll(/【后台结果 (J\d+) · (完成|失败|已取消)】([^\n]*)[\s\S]*?(?=【后台结果 |$)/g)].map((m) => ({
			id: m[1]!,
			ok: m[2] === "完成",
			agent: m[3]!.split(" · ")[0],
			model: m[3]!.match(/模型 ([^ ·]+)/)?.[1],
			change: m[0].match(/\[改动 #(\w+)：\d+ 个文件/)?.[1],
		}));

	/** 异步剧本的一步：开后台派工 → 等结果 → 每结束一个就验收，编码完成后在后台派审查 → 全部结束后汇报 */
	const asyncStep = (results: any[], steer: string | undefined) => {
		const f = flow!;
		f.jobs ??= {};
		const texts = [...results.map((m) => textOf(m)), ...(steer?.startsWith("【后台结果") ? [steer] : [])];
		for (const t of results.filter((m) => String(m.toolName).startsWith("ask_")).map((m) => textOf(m))) {
			const id = t.match(/已在后台开工 (J\d+)/)?.[1];
			const task = t.match(/任务 (T\d+)/)?.[1];
			if (id) f.jobs[id] = { step: Math.max(0, f.ids.indexOf(task ?? "")), done: false };
		}
		const fresh = texts.flatMap(finishedJobs).filter((j) => f.jobs![j.id] && !f.jobs![j.id]!.done);
		const calls: any[] = [];
		const lines: string[] = [];
		for (const j of fresh) {
			const rec = f.jobs[j.id]!;
			Object.assign(rec, { done: true, ok: j.ok, change: j.change, agent: j.agent, model: j.model });
			const id = f.ids[rec.step]!;
			calls.push(
				fauxToolCall("update_task", j.ok ? { id, status: "done", note: "对照验收标准核对通过（演示）" } : { id, status: "blocked", note: "成员失败，需要看报错后重派" }, {
					id: `demo-u-${run}-${round}-${j.id}`,
				}),
			);
			lines.push(`${j.id}（${id}）${j.ok ? "完成" : "失败"}`);
			// 编码完成：基于它的改动，在后台派审查
			if (rec.step === 1 && j.ok && !f.reviewSent) {
				f.reviewSent = true;
				calls.push(dispatch(f.scene.steps[3]!, f.ids[3]!, { background: true, ...(j.change ? { based_on: j.change } : {}) }));
				lines.push(`基于改动 #${j.change ?? "?"} 在后台派审查 ${f.ids[3]}`);
			}
		}
		if (calls.length) return fauxAssistantMessage([fauxText(`${lines.join("；")}。`), ...calls], { stopReason: "toolUse" });
		const running = Object.entries(f.jobs).filter(([, j]) => !j.done).map(([id]) => id);
		if (running.length) {
			return fauxAssistantMessage([fauxText(`${running.join("、")} 还在后台进行，先等做完的那个。`), fauxToolCall("wait_jobs", { mode: "any" }, { id: `demo-w-${run}-${round}-${Object.keys(f.jobs).length}-${running.length}` })], {
				stopReason: "toolUse",
			});
		}
		const report = Object.entries(f.jobs).map(([jid, j]) => `- **${f.ids[j.step]}** ${j.agent ?? f.scene.steps[j.step]!.agent}${j.model ? `（${j.model}）` : ""}，后台 ${jid}：${j.ok ? "完成并通过验收" : "失败，标为受阻"}${j.change ? `　改动 \`#${j.change}\`` : ""}`);
		flow = undefined;
		return fauxAssistantMessage(
			fauxText(
				`## 汇报\n\n四项任务里三项一开始就在后台并行，审查等编码做完后基于它的改动开工；期间总调度没有干等。\n\n${report.join("\n")}\n\n改动都在独立分支里，确认后在终端 \`/apply all\`。并行情况见后台「协作拓扑」页。`,
			),
		);
	};

	const dispatch = (s: Step, id: string, extra: Record<string, unknown> = {}) =>
		fauxToolCall(`ask_${s.agent}`, { task: `${s.title}：${flow!.task}`, task_id: id, ...(s.args ?? {}), ...extra }, { id: `demo-${s.agent}-${run}-${round}-${id}` });

	const step = (ctx: { messages: readonly any[] }) => {
		// 系统提示的某一段变了（比如分工表更新）时，Pi Durable 会在对话里插入一条 system 消息；剧本判断时跳过它
		let messages = ctx.messages;
		while (messages.at(-1)?.role === "system") messages = messages.slice(0, -1);
		let last = messages.at(-1);
		// 插话（steer）：放在一轮工具结果之后的用户消息。不当成新任务，而是带进这一轮接下来的步骤
		let steer: string | undefined;
		if (last?.role === "user" && messages.at(-2)?.role === "toolResult") {
			steer = textOf(last);
			messages = messages.slice(0, -1);
			last = messages.at(-1);
		}
		const heard = steer && !steer.startsWith("【后台结果") ? `收到你的插话：「${steer}」，已按它调整。\n\n` : "";
		if (flow?.scene.async && flow.phase === "work" && (last?.role === "toolResult" || steer)) {
			const results: any[] = [];
			for (const m of messages.slice().reverse()) {
				if (m.role !== "toolResult") break;
				results.unshift(m);
			}
			return asyncStep(results, steer);
		}

		if (last?.role === "toolResult" && flow) {
			const results: any[] = [];
			for (const m of messages.slice().reverse()) {
				if (m.role !== "toolResult") break;
				results.unshift(m);
			}
			// 拆完任务 → 按角色派工（顺序剧本先派第一项）
			if (results.some((m) => m.toolName === "plan_tasks")) {
				flow.ids = [...textOf(results.find((m) => m.toolName === "plan_tasks")).matchAll(/T\d+(?= )/g)].map((m) => m[0]).slice(0, flow.scene.steps.length);
				flow.phase = "work";
				if (flow.scene.async) {
					const free = flow.scene.steps.map((st, i) => (st.deps ? -1 : i)).filter((i) => i >= 0);
					return fauxAssistantMessage(
						[fauxText(`${heard}分工表已更新。${free.map((i) => flow!.ids[i]).join("、")} 互不依赖，放到后台同时做。`), ...free.map((i) => dispatch(flow!.scene.steps[i]!, flow!.ids[i]!, { background: true }))],
						{ stopReason: "toolUse" },
					);
				}
				const batch = flow.scene.sequential ? [0] : flow.scene.steps.map((_, i) => i);
				flow.next = batch.length;
				return fauxAssistantMessage([fauxText(`${heard}分工表已更新，按角色派工。`), ...batch.map((i) => dispatch(flow!.scene.steps[i]!, flow!.ids[i]!))], { stopReason: "toolUse" });
			}
			if (results.some((m) => String(m.toolName).startsWith("ask_"))) {
				flow.results.push(...results);
				// 顺序剧本：上一项做完，基于它的改动派下一项
				if (flow.scene.sequential && flow.next < flow.scene.steps.length) {
					const change = textOf(results.at(-1)).match(/改动 #(\w+)/)?.[1];
					const i = flow.next++;
					return fauxAssistantMessage(
						[fauxText(`${heard}${flow.ids[i - 1]} 完成${change ? `（改动 #${change}）` : ""}，接着派 ${flow.ids[i]}。`), dispatch(flow.scene.steps[i]!, flow.ids[i]!, change ? { based_on: change } : {})],
						{ stopReason: "toolUse" },
					);
				}
				// 验收：成功的标完成，失败的标受阻
				flow.phase = "accept";
				const checks = flow.results.map((m, k) => {
					const id = textOf(m).match(/任务 (T\d+)/)?.[1] ?? flow!.ids[k]!;
					return m.isError
						? fauxToolCall("update_task", { id, status: "blocked", note: "成员失败，需要看报错后重派" }, { id: `demo-u-${run}-${round}-${k}` })
						: fauxToolCall("update_task", { id, status: "done", note: "对照验收标准核对通过（演示）" }, { id: `demo-u-${run}-${round}-${k}` });
				});
				return fauxAssistantMessage([fauxText(`${heard}对照验收标准核对结果。`), ...checks], { stopReason: "toolUse" });
			}
			// 验收完 → 汇报
			const lines = flow.results.map((m) => {
				const t = textOf(m);
				const change = t.match(/\[改动 #(\w+)：([^\]]*)\]/);
				const model = t.match(/模型: ([^ |\]]+)/)?.[1];
				const id = t.match(/任务 (T\d+)/)?.[1];
				return `- **${id ?? "?"}** ${String(m.toolName).replace("ask_", "")}${model ? `（${model}）` : ""}：${m.isError ? "失败，标为受阻" : "完成并通过验收"}${change ? `　改动 \`#${change[1]}\`：${change[2].split("，")[0]}` : ""}`;
			});
			const failed = flow.results.some((m) => m.isError);
			const changes = [...new Set(flow.results.map((m) => textOf(m).match(/改动 #(\w+)：\d+ 个文件/)?.[1]).filter(Boolean))];
			flow = undefined;
			return fauxAssistantMessage(
				fauxText(
					`## 汇报\n\n${heard}${lines.join("\n")}\n\n` +
						(changes.length ? `改动都在独立分支里，还没有进入主目录。确认没问题后在终端执行 \`/apply all\`，或逐个 \`/apply 编号\`。分工表见 \`/tasks\` 或后台「项目」页。\n\n` : "") +
						(failed ? "受阻的任务需要看报错后重派。" : "这一批任务都完成了。"),
				),
			);
		}

		if (lastUserText(ctx.messages).startsWith("【后台结果")) {
			return fauxAssistantMessage(fauxText("收到后台结果（演示）。这一批的其余任务已经停了，需要的话重新下达。"));
		}
		const task = lastUserText(ctx.messages).slice(0, 60) || "演示任务";
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
					[fauxText("在 Claude 上次的会话里继续（同一个上下文、同一个副本）。"), fauxToolCall("ask_claude", { task: `继续上次的工作：${task}`, session_id: sid }, { id: `demo-c-${run}-${round}` })],
					{ stopReason: "toolUse" },
				);
			}
		}
		// 新任务：先拆成任务写进分工表
		const scene = SCENES[(round - 1) % SCENES.length]!;
		flow = { scene, task, ids: [], next: 0, results: [], phase: "plan" };
		return fauxAssistantMessage(
			[
				fauxText(`先拆解任务。${scene.intro}`),
				fauxToolCall(
					"plan_tasks",
					{ tasks: scene.steps.map((s) => ({ title: `${s.title}：${task}`, role: s.role, owner: s.agent, acceptance: s.acceptance, ...(s.deps ? { deps: s.deps } : {}) })) },
					{ id: `demo-p-${run}-${round}` },
				),
			],
			{ stopReason: "toolUse" },
		);
	};
	// faux 的每个响应只用一次，排足够多的同一个剧本
	faux.setResponses(Array.from({ length: 2000 }, () => step));
	return {
		models,
		ref: { provider: "demo", modelId: "scripted-orchestrator" },
		describe: "演示模式（脚本化假模型，不花钱）",
		info: { type: "demo", modelId: "scripted-orchestrator", keySource: "不需要密钥" },
	};
}
