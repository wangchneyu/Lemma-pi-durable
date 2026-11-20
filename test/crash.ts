// 崩溃恢复测试：Claude 执行到一半时强杀整个进程树，重新打开后应续接同一个 Claude 会话并完成任务。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { check, fakeCalls, fauxOrchestrator, lastAnswer, testConfig, toolResults } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-agent-crash-"));
const childScript = fileURLToPath(new URL("./crash-child.ts", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1) 子进程派活，假 Claude 要跑 30 秒
const child = spawn(process.execPath, ["--no-warnings", childScript, dir], {
	env: { ...process.env, FAKE_AGENT_DELAY_MS: "30000" },
	stdio: "inherit",
});
const config = testConfig(dir);
const deadline = Date.now() + 20_000;
while (fakeCalls(config).length === 0 && Date.now() < deadline) await sleep(100);
check(fakeCalls(config).length === 1, "Claude 已经开始执行");
await sleep(1500); // 让会话 ID 来得及写入存储

// 2) 模拟崩溃：杀掉整个进程树（总调度 + 正在跑的 Claude）
if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
else child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));
check(existsSync(join(dir, "submission.txt")), "子进程在崩溃前已提交任务");
const firstCall = fakeCalls(config)[0]!;
const sessionId = firstCall.args[firstCall.args.indexOf("--session-id") + 1];
console.log(`  已强杀进程，Claude 会话 ${sessionId} 被中断`);

// 3) 重新打开同一个存储，恢复执行
process.env.FAKE_AGENT_DELAY_MS = "200";
const context = BACKGROUND_CONTEXT;
const orch = fauxOrchestrator();
orch.faux.setResponses([(ctx) => fauxAssistantMessage(fauxText(`恢复后完成：${toolResults(ctx).at(-1)?.text.split("\n")[0]}`))]);
const { harness, root } = await openApp(config, orch, context);
harness.resume();
const submission = await harness.submission(Number(readFileSync(join(dir, "submission.txt"), "utf8")) as any, context);
check(submission !== undefined, "重启后找回了原来的提交");
const settled = await submission!.wait(context);
check(settled.status === "done", "原任务在重启后完成");

const calls = fakeCalls(config);
check(calls.length === 2, "Claude 只被重新调用了一次");
const resumed = calls[1]!;
check(resumed.args.includes("--resume") && resumed.args.includes(sessionId!), "重启后用 --resume 续接了被中断的同一个会话");
check(resumed.prompt.includes("中断") && resumed.prompt.includes("写一个很长的功能"), "续接提示里说明了中断并附上原任务");
const answer = await lastAnswer(root, context);
console.log(`  总调度回答：${answer}`);
check(answer.startsWith("恢复后完成：CLAUDE_OK"), "总调度拿到了恢复后的结果");

await harness.close(context);
console.log("\n崩溃恢复测试通过 ✅");
