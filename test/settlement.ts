import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openApp } from "../src/app.ts";
import { Board } from "../src/board.ts";
import { AgentSessions, RunBudget } from "../src/dispatch.ts";
import { Results } from "../src/results.ts";
import { check, fakeCalls, fauxOrchestrator, testConfig } from "./helpers.ts";

const script = fileURLToPath(new URL("./settlement-crash-child.ts", import.meta.url));
for (const phase of ["after-execution", "inside-transaction", "after-transaction", "repair-after-transaction", "repair-managed-receipt"]) {
	const repair = phase.startsWith("repair-");
	const directory = mkdtempSync(join(tmpdir(), "lemma-settlement-"));
	const config = testConfig(directory);
	const start = (mode: string) => {
		const child = spawn(process.execPath, ["--no-warnings", script, directory, phase, mode], { env: { ...process.env, FAKE_AGENT_DELAY_MS: "20" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
		return { child, closed: new Promise<number | null>((done) => child.once("exit", done)), output: () => output };
	};
	const first = start("crash");
	try {
		const deadline = Date.now() + 15000;
		while (!existsSync(join(directory, "crash-ready")) && Date.now() < deadline && first.child.exitCode === null) await new Promise((done) => setTimeout(done, 30));
		assert(existsSync(join(directory, "crash-ready")), first.output());
		if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(first.child.pid), "/T", "/F"], { stdio: "ignore" }); else first.child.kill("SIGKILL");
		await first.closed;
		const inspect = await openApp(config, fauxOrchestrator(), BACKGROUND_CONTEXT, { readOnly: true });
		try {
			const task = (await inspect.harness.snapshot(Board, BACKGROUND_CONTEXT))!.tasks.T1!;
			const report = (await inspect.harness.snapshot(Results, inspect.root.id, "dispatch:atomic-task", BACKGROUND_CONTEXT))?.result;
			if (phase === "after-transaction" || repair) { assert.equal(task.status, "review"); assert.equal(task.latestResult, repair ? "dispatch:atomic-task:repair:1" : report!.id); }
			else { assert.equal(task.status, "doing"); assert(!task.latestResult); assert(!report); assert.equal((await inspect.harness.snapshot(RunBudget, BACKGROUND_CONTEXT))?.spent ?? 0, 0); }
		} finally { await inspect.harness.close(BACKGROUND_CONTEXT); }
		for (let replay = 0; replay < 2; replay++) { const next = start("resume"); assert.equal(await next.closed, 0, next.output()); }
		const restored = await openApp(config, fauxOrchestrator(), BACKGROUND_CONTEXT);
		try {
			const task = (await restored.harness.snapshot(Board, BACKGROUND_CONTEXT))!.tasks.T1!;
			const report = (await restored.harness.snapshot(Results, restored.root.id, task.latestResult!, BACKGROUND_CONTEXT))!.result!;
			assert.equal(task.status, "review"); assert(!task.activeDispatch); assert(report.text.includes("CLAUDE_OK"));
			assert.equal(Object.values((await restored.harness.snapshot(AgentSessions, BACKGROUND_CONTEXT))!.sessions)[0]!.rounds, repair ? 2 : 1);
			assert.equal((await restored.harness.snapshot(RunBudget, BACKGROUND_CONTEXT))!.spent, repair ? 0.0246 : 0.0123);
			assert.equal(fakeCalls(config).length, repair ? 2 : 1);
		} finally { await restored.harness.close(BACKGROUND_CONTEXT); }
		check(true, `派工收尾强杀 ${phase}：事务完整，恢复不重复执行、计费或累计轮次`);
	} finally { if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill(); }
}
