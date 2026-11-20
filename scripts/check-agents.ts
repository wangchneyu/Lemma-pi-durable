// 诊断：用和正式运行完全相同的代码路径，给每个本机 CLI 发一句话，确认能调通。
//   npm run check            检查全部
//   npm run check -- claude  只检查某一个
import { ADAPTERS } from "../src/agents.ts";
import { cleanEnv, runCli } from "../src/cli-runner.ts";
import { loadConfig, type AgentKind } from "../src/config.ts";
import { detectAgents } from "../src/tools.ts";

const config = loadConfig(process.env.PI_AGENT_CONFIG ?? "pi-agent.config.json");
const only = process.argv.slice(2) as AgentKind[];
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
	console.log(`… ${agent.kind}: ${command.join(" ")}`);
	const result = await runCli({
		command: command[0]!,
		args: [...command.slice(1), ...adapter.buildArgs({ extraArgs: config.agents[agent.kind].extraArgs })],
		cwd: config.workdir,
		stdin: "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
		env: cleanEnv(config.stripEnv),
		timeoutMs: 180_000,
		onLine: (line, stream) => {
			if (verbose) console.log(`   [${stream}] ${line.slice(0, 300)}`);
			else {
				const p = adapter.progress(line);
				if (p.summary) console.log(`   ${p.summary}`);
			}
		},
	});
	const parsed = adapter.parse(result.stdout, result.stderr, result.exitCode);
	const ok = !parsed.isError && /PONG/i.test(parsed.text);
	if (!ok) failed++;
	console.log(
		`${ok ? "●" : "✗"} ${agent.kind}: ${parsed.text.trim().slice(0, 300)}` +
			`  (退出码 ${result.exitCode}，${Math.round(result.durationMs / 1000)}s${parsed.sessionId ? `，会话 ${parsed.sessionId}` : ""}${parsed.costUsd !== undefined ? `，$${parsed.costUsd.toFixed(4)}` : ""})`,
	);
	if (!ok && !verbose) console.log(`   stderr 末尾：${result.stderr.trim().split(/\r?\n/).slice(-5).join(" | ").slice(0, 600)}`);
}
process.exitCode = failed > 0 ? 1 : 0;
