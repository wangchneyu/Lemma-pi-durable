// 诊断：用和正式运行完全相同的代码路径，给每个本机 CLI 发一句话，确认能调通。
//   npm run check                    检查全部成员（用各自的默认模型）
//   npm run check -- claude          只检查某一个
//   npm run check -- --models        逐个检查配置清单里的每个模型（会多花一点钱）
import { ADAPTERS } from "../src/agents.ts";
import { cleanEnv, runCli } from "../src/cli-runner.ts";
import { loadConfig, type AgentKind } from "../src/config.ts";
import { detectAgents } from "../src/tools.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { memberProvider, registerApiMembers } from "../src/api-member.ts";

/** API 成员：用和正式运行同一个 provider 配置发一句话（不经过 Pi Durable） */
async function checkApiMember(kind: AgentKind, all: boolean): Promise<number> {
	const c = config.agents[kind];
	const models = createModels();
	registerApiMembers(models, config);
	const ids = all && c.models.length ? c.models.map((m) => m.id) : [c.defaultModel ?? c.models[0]!.id];
	let bad = 0;
	for (const id of ids) {
		const label = `${kind} / ${id}`;
		console.log(`… ${label}: ${c.api!.baseUrl}`);
		const started = Date.now();
		try {
			const model = models.getModel(memberProvider(kind), id);
			if (!model) throw new Error("模型没有注册");
			const reply = await models.completeSimple(model, { messages: [{ role: "user", content: "Reply with exactly the single word PONG and nothing else.", timestamp: Date.now() }] });
			const text = reply.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
			const ok = reply.stopReason !== "error" && /PONG/i.test(text);
			if (!ok) bad++;
			console.log(`${ok ? "●" : "✗"} ${label}: ${(text || reply.errorMessage || "").slice(0, 300)}  (${Math.round((Date.now() - started) / 1000)}s，${reply.usage?.input ?? 0}+${reply.usage?.output ?? 0} tokens)`);
		} catch (error) {
			bad++;
			console.log(`✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return bad;
}

const config = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const args = process.argv.slice(2);
const allModels = args.includes("--models");
const only = args.filter((a) => !a.startsWith("--")) as AgentKind[];
const verbose = process.env.VERBOSE === "1";
let failed = 0;

for (const agent of detectAgents(config)) {
	if (only.length > 0 && !only.includes(agent.kind)) continue;
	if (!agent.available) {
		console.log(`○ ${agent.kind}: ${agent.reason}`);
		continue;
	}
	const adapter = ADAPTERS[agent.kind];
	const command = agent.command!;
	const c = config.agents[agent.kind];
	if (c.api) {
		failed += await checkApiMember(agent.kind, allModels);
		continue;
	}
	const models = allModels && c.models.length ? c.models.map((m) => m.id) : [c.defaultModel];
	for (const model of models) {
		const label = `${agent.kind}${model ? ` / ${model}` : ""}`;
		console.log(`… ${label}: ${command.join(" ")}`);
		let reported: string | undefined;
		const result = await runCli({
			command: command[0]!,
			args: [...command.slice(1), ...adapter.buildArgs({ model, extraArgs: c.extraArgs })],
			cwd: config.workdir,
			stdin: "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
			env: cleanEnv(config.stripEnv),
			timeoutMs: 180_000,
			onLine: (line, stream) => {
				if (verbose) console.log(`   [${stream}] ${line.slice(0, 300)}`);
				const p = adapter.progress(line);
				if (p.model) reported = p.model;
				if (!verbose && p.summary) console.log(`   ${p.summary}`);
			},
		});
		const parsed = adapter.parse(result.stdout, result.stderr, result.exitCode);
		const ok = !parsed.isError && /PONG/i.test(parsed.text);
		if (!ok) failed++;
		const actual = parsed.model ?? reported;
		const usage = parsed.usage ? `，${parsed.usage.input}+${parsed.usage.output} tokens` : "";
		console.log(
			`${ok ? "●" : "✗"} ${label}: ${parsed.text.trim().slice(0, 300)}` +
				`  (退出码 ${result.exitCode}，${Math.round(result.durationMs / 1000)}s${actual ? `，实际模型 ${actual}` : ""}${parsed.costUsd !== undefined ? `，$${parsed.costUsd.toFixed(4)}` : ""}${usage})`,
		);
		if (!ok && !verbose) console.log(`   stderr 末尾：${result.stderr.trim().split(/\r?\n/).slice(-5).join(" | ").slice(0, 600)}`);
	}
}
process.exitCode = failed > 0 ? 1 : 0;
