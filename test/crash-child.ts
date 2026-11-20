// crash.ts 启动的子进程：派一个慢任务给 Claude，然后等着被父进程强制杀掉。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openApp } from "../src/app.ts";
import { fauxOrchestrator, testConfig } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const config = testConfig(process.argv[2]);
const orch = fauxOrchestrator();
const { root } = await openApp(config, orch, context);
orch.faux.setResponses([
	fauxAssistantMessage([fauxToolCall("ask_claude", { task: "写一个很长的功能" }, { id: "slow" })], { stopReason: "toolUse" }),
]);
const submission = await root.submit({ type: "input", content: "开始长任务" }, context);
writeFileSync(join(config.workdir, "submission.txt"), String(submission.id));
await submission.wait(context); // 永远等不到：父进程会在 Claude 干活时杀掉我们
