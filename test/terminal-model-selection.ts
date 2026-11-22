// Real entrypoint + native selector + Durable SQLite; no model requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalText } from "../src/terminal.ts";
import { check } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "lemma-native-model-"));
const config = join(directory, "config.json");
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
writeFileSync(config, JSON.stringify({ workdir: directory, storage: join(directory, "session.sqlite"),
	orchestrator: { type: "openai-compatible", modelId: "model-first", modelIds: ["model-second"], baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: ["LEMMA_TEST_KEY"], apiKeyFromClaudeSettings: false },
	agents: Object.fromEntries(["claude", "codex", "gemini", "deepseek"].map((kind) => [kind, { enabled: false }])),
}));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(first: boolean) {
	const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./terminal-cli-child.ts", import.meta.url)), "--real", "--tui"], {
		env: { ...process.env, PI_AGENT_CONFIG: config, PI_AGENT_PORT: String(port), LEMMA_TEST_KEY: "unused-local-test", TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "", errors = "", exited = false;
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	const closed = new Promise<number | null>((resolve) => child.on("close", (code) => { exited = true; resolve(code); }));
	const json = async (path = "/api/state"): Promise<any> => { const response = await fetch(`http://127.0.0.1:${port}${path}`); assert.equal(response.status, 200); return response.json(); };
	async function until(label: string, test: () => boolean | Promise<boolean>) {
		const deadline = Date.now() + 20_000;
		while (!exited && Date.now() < deadline) { try { if (await test()) return; } catch {} await sleep(40); }
		if (await test()) return;
		throw new Error(`${label}: ${errors}\n${terminalText(output).slice(-3500)}`);
	}
	const send = (text: string) => child.stdin.write(`\x1b[200~${text}\x1b[201~\x1b[13u`);
	try {
		await until("真实终端启动", async () => (await json()).orchestrator.modelId === (first ? "model-first" : "model-second"));
		child.stdin.write("\x1b[?1;2c");
		if (first) {
			const initial = await json();
			child.stdin.write("模型选择时保留草稿");
			const marker = output.length;
			child.stdin.write("\x0c");
			await until("官方模型选择器打开", () => terminalText(output.slice(marker)).includes("model-second"));
			child.stdin.write("model-second");
			child.stdin.write("\x1b[13u");
			await until("选择写入 Durable 与网页", async () => (await json()).orchestrator.modelId === "model-second");
			assert.equal((await json("/api/topology")).orchestrator.model, "model-second");
			assert.equal((await json("/api/history")).items.length, 0);
			assert.equal((await json()).startedAt, initial.startedAt);
			assert.ok(terminalText(output.slice(marker)).includes("模型选择时保留草稿"));
			child.stdin.write("\x15");
			send("/session new isolated");
			await until("新会话模型独立", async () => { const state = await json(); return state.conversation.id === "isolated" && state.orchestrator.modelId === "model-first"; });
			send("/session use default");
			await until("切回恢复原模型", async () => { const state = await json(); return state.conversation.id === "default" && state.orchestrator.modelId === "model-second"; });
			const treeMarker = output.length;
			child.stdin.write("\x1bc");
			await until("原生关系树打开", () => terminalText(output.slice(treeMarker)).includes("Session Tree"));
			child.stdin.write("\x1b");
			await sleep(80);
			assert.equal(output.split("\x1b[?1049h").length - 1, 1);
			check(true, "真实 Ctrl+L 使用原生选择器切换模型，网页同步、草稿保留、会话隔离且终端不重建");
		} else check(true, "真实入口重启后恢复 Durable 模型选择，未向不可达模型服务发送聊天");
		send("/exit");
		await until("退出", () => exited);
		assert.equal(await closed, 0, errors);
	} finally { if (!exited) { child.kill(); await closed; } }
}
await run(true);
await run(false);
