import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { openApp } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { checkBudget, runDispatch, type DispatchIO } from "../src/dispatch.ts";
import { Results } from "../src/results.ts";
import { managedDispatch } from "../src/repair.ts";
import { fauxOrchestrator, testConfig } from "./helpers.ts";

const [directory, phase, mode] = process.argv.slice(2);
const config = testConfig(directory); config.isolation.enabled = false;
const repair = phase!.startsWith("repair-");
if (repair) {
	config.isolation.enabled = true; process.env.FAKE_AGENT_WRITE = "1";
	if (!existsSync(join(directory!, ".git"))) {
		writeFileSync(join(directory!, "app.txt"), "original\n"); writeFileSync(join(directory!, ".gitignore"), "*.sqlite*\ncalls.jsonl\nworktrees/\n.pi-agent/\ncrash-ready\n");
		for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", directory!, ...args], { windowsHide: true });
	}
	config.autonomy = { enabled: true, maxRepairAttempts: 2, resultMaxChars: 1500, checks: [{ name: "second dispatch passes", command: "node", args: ["-e", `if(require('fs').readFileSync(${JSON.stringify(join(directory!, "calls.jsonl"))},'utf8').trim().split(String.fromCharCode(10)).length<2)process.exit(1)`] }] };
}
const app = await openApp(config, fauxOrchestrator(), BACKGROUND_CONTEXT);
const Memo = defineDoc<{ values: Record<string, any> }>({ kind: "test.settlement-memo", version: 1, scope: "session", initial: () => ({ values: {} }), checkpointWhen: () => false });
const halt = async () => { writeFileSync(join(directory!, "crash-ready"), phase!); await new Promise<void>(() => {}); };
let armed = mode === "crash";
await app.harness.commit(async (tx) => { const board = await tx.doc(Board); if (!board.tasks.T1) { const now = Date.now(); board.tasks.T1 = { id: "T1", title: "atomic settlement", status: "todo", deps: [], notes: [], dispatches: [], changes: [], createdAt: now, updatedAt: now }; board.order = ["T1"]; board.nextId = 2; } }, BACKGROUND_CONTEXT);
const io: DispatchIO = {
	callId: "atomic-call", taskId: "atomic-task", conversationId: app.root.id, signal: new AbortController().signal, now: () => Date.now(), output: () => {}, details: async () => {},
	commit: async (change) => {
		let settlement = false;
		const result = await app.harness.commit(async (tx) => {
			const before = !!(await tx.doc(Results, app.root.id, "dispatch:atomic-task", null)).result?.dispatch;
			const beforeRepair = !!(await tx.doc(Results, app.root.id, "dispatch:atomic-task:repair:1", null)).result?.dispatch;
			const value = await change(tx);
			settlement = !before && !!(await tx.doc(Results, app.root.id, "dispatch:atomic-task", null)).result?.dispatch;
			if (repair) settlement = !beforeRepair && !!(await tx.doc(Results, app.root.id, "dispatch:atomic-task:repair:1", null)).result?.dispatch;
			if (armed && settlement && phase === "inside-transaction") { armed = false; await halt(); }
			return value;
		}, BACKGROUND_CONTEXT);
		if (armed && settlement && ["after-transaction", "repair-after-transaction"].includes(phase!)) { armed = false; await halt(); }
		return result;
	},
	memo: async (name, candidate) => {
		const value = await app.harness.commit(async (tx) => { const values = (await tx.doc(Memo)).values; if (!Object.hasOwn(values, name) && candidate !== undefined) values[name] = candidate; return values[name] === undefined ? undefined : JSON.parse(JSON.stringify(values[name])); }, BACKGROUND_CONTEXT);
		if (armed && name === "execution-outcome" && candidate !== undefined && phase === "after-execution") { armed = false; await halt(); }
		if (armed && name === "managed-result" && candidate !== undefined && phase === "repair-managed-receipt") { armed = false; await halt(); }
		return value;
	},
};
if (repair) await checkBudget(io, config);
const result = await (repair ? managedDispatch : runDispatch)("claude", config.agents.claude!.command!, { config, changes: app.changes, project: app.project, hub: app.jobs }, { task: "atomic task", task_id: "T1" }, io);
if (result.isError) throw new Error(result.text);
if (repair && !result.text.includes("自动修复 1/2")) throw new Error("repair receipt lost");
await app.harness.close(BACKGROUND_CONTEXT);
