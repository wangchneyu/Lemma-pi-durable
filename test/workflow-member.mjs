import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [kind, ...args] = process.argv.slice(2);
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ kind, args, prompt, cwd: process.cwd(), at: Date.now() }) + "\n");
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_AGENT_DELAY_MS ?? 80)));
const flag = (name) => args[args.indexOf(name) + 1];
const resume = args.includes("--resume");
const id = resume ? flag("--resume") : args.includes("--session-id") ? flag("--session-id") : randomUUID();
const sourceId = prompt.match(/\"result_id\":\"(dispatch:[^\"]+)\"/)?.[1];
const currentTask = prompt.split("【本次要做的事】").at(-1)?.split("【显式交接资料")[0] ?? prompt;
if (process.env.FAKE_WORKFLOW_WRITE === "1" && existsSync(".git")) {
	if (!prompt.includes("独立复核任务") && currentTask.includes("CODE_SOURCE")) { mkdirSync("src", { recursive: true }); writeFileSync("src/accepted.txt", "ACCEPTED_SOURCE_CODE"); }
	if (!prompt.includes("独立复核任务") && currentTask.includes("CODE_SECOND")) { mkdirSync("src", { recursive: true }); writeFileSync("src/second.txt", "SECOND_ACCEPTED_SOURCE"); }
	if (!prompt.includes("独立复核任务") && currentTask.includes("CODE_MULTI")) { if (readFileSync("src/accepted.txt", "utf8") !== "ACCEPTED_SOURCE_CODE" || readFileSync("src/second.txt", "utf8") !== "SECOND_ACCEPTED_SOURCE") throw new Error("下游缺少联合代码"); writeFileSync("src/combined.txt", "COMBINED_VERIFIED_CODE"); }
	if (!prompt.includes("独立复核任务") && currentTask.includes("CODE_DOWNSTREAM")) { if (readFileSync("src/accepted.txt", "utf8") !== "ACCEPTED_SOURCE_CODE") throw new Error("下游没有读取到前置代码"); writeFileSync("src/downstream.txt", "DERIVED_FROM_ACCEPTED_SOURCE"); }
}
const payload = prompt.includes("独立复核任务") ? prompt.includes("INVALID_CHECKER") ? "无效的复核返回" : JSON.stringify({ verdict: prompt.includes("NEEDS_REWORK_FIRST_DELIVERY") || prompt.includes("ALWAYS_REWORK") ? "rework" : "accept", result_id: prompt.includes("STALE_CHECKER") ? "dispatch:old" : sourceId, evidence: prompt.includes("NEEDS_REWORK_FIRST_DELIVERY") || prompt.includes("ALWAYS_REWORK") ? "MISSING_SOURCE_EVIDENCE 补充来源后重新复核" : "已逐项核对来源、结果和验收标准" }) : currentTask.includes("REWORK_CASE") && !resume ? "NEEDS_REWORK_FIRST_DELIVERY" : currentTask.includes("ALWAYS_REWORK") ? "ALWAYS_REWORK" : `VERIFIED_DELIVERY:${kind}`;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (kind === "claude") out({ type: "result", subtype: "success", is_error: false, session_id: id, total_cost_usd: 0.001, result: payload });
else if (kind === "gemini") out({ session_id: id, response: payload });
else { out({ type: "thread.started", thread_id: id }); out({ type: "item.completed", item: { type: "agent_message", text: payload } }); out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } }); }
