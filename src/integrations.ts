import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineTask, defineTool, type ConversationId, type Tx, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { memberToolNames } from "./api-member.ts";
import { Board } from "./board.ts";
import type { ChangeRecord } from "./changes.ts";
import { autonomyChecksForRoot, sameConfigRepoRoot } from "./config.ts";
import type { DispatchArgs, DispatchDeps } from "./dispatch.ts";
import { addWorktree, linkIgnoredDirs, numstat } from "./git.ts";
import { cleanEnv, runCli } from "./cli-runner.ts";
import { findConflictMarkers, integrationGit, integrationStale, mergeIntegrationSource, workspaceTree } from "./integration-git.ts";
import { Jobs, type JobRecord } from "./jobs.ts";
import { Learning, relevantLessons } from "./learning.ts";

export const Integrations = defineDoc<{ records: Record<string, ChangeRecord>; byKey: Record<string, string> }>({ kind: "lemma.integrations", version: 1, scope: "session", initial: () => ({ records: {}, byKey: {} }), checkpointWhen: () => false });
type Checkpoint = { phase: "prepare" | "merge" | "repair" | "test"; index: number };
type IntegrationInput = { id: string };
type IntegrationResult = { id: string; passed: boolean };
export interface IntegrationHooks {
	available?: Set<string>;
	enqueue?: (tx: Tx, controller: ConversationId, key: string, member: string, args: DispatchArgs, model?: string) => Promise<JobRecord>;
	ensureWorkflow?: (tx: Tx, controller: ConversationId) => Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const ended = (change: ChangeRecord) => !["preparing", "merging", "repairing", "testing"].includes(change.integration!.status);

export function integrationSummary(change: ChangeRecord) {
	const repair = change.integration?.repair
		? { fromId: change.integration.repair.fromId, member: change.integration.repair.member, ...(change.integration.repair.model ? { model: change.integration.repair.model } : {}), ...(change.integration.repair.jobId ? { jobId: change.integration.repair.jobId } : {}), ...(change.integration.repair.changeId ? { changeId: change.integration.repair.changeId } : {}), ...(change.integration.repair.note ? { note: change.integration.repair.note } : {}) }
		: undefined;
	return {
		id: change.id,
		status: change.integration?.status,
		changeStatus: change.status,
		head: change.head,
		sources: change.integration?.sources,
		...(change.integration?.replacesId ? { replacesId: change.integration.replacesId } : {}),
		...(change.integration?.supersededBy ? { supersededBy: change.integration.supersededBy } : {}),
		...(repair ? { repair } : {}),
		checks: change.integration?.reports,
		conflicts: change.integration?.conflicts ?? [],
		message: change.message ?? null,
		path: change.path,
		next: change.status === "applied"
			? "已应用到主目录，等待人工检查提交。"
			: change.status === "dropped"
				? "集成副本已丢弃，历史检查记录保留。"
				: change.integration?.supersededBy
					? `已被新集成 #${change.integration.supersededBy} 替代，请查看最新集成记录。`
					: change.integration?.status === "passed"
						? `/diff ${change.id} 查看；/apply ${change.id} 由用户确认应用；主目录或来源变化后可用 /integrate rerun ${change.id} 重验`
						: ["conflict", "failed"].includes(change.integration?.status ?? "")
							? `/integrate repair ${change.id} <成员ID> [修复说明] 在独立副本修复并重跑全量检查，或修复来源后 /integrate rerun ${change.id}`
							: `正在运行（${change.integration?.status ?? change.status}），可用 /integrate cancel ${change.id} 取消`,
	};
}

export function createIntegrations(deps: DispatchDeps, hooks: IntegrationHooks = {}) {
	const { config, changes, hub } = deps;
	const publish = (record: ChangeRecord) => { try { changes.upsert(clone(record)); } catch { hub.output(`integration:${record.id}`, "集成状态已持久保存，改动索引暂时无法更新，重启后恢复。"); } };
	type Handler = (running: RunningTask<IntegrationInput, Checkpoint, IntegrationResult>, runtime: TaskRuntime<IntegrationInput, Checkpoint, IntegrationResult, object>, context: Context) => Promise<void>;
	const phaseHandler = (phase: Checkpoint["phase"]): Handler => async (running, runtime, context) => {
		await runPhase(phase, running, runtime, context);
	};
	const task = defineTask<IntegrationInput, Checkpoint, IntegrationResult>({
		name: "lemma.integration", version: 1, initial: () => ({ phase: "prepare", index: 0 }),
		phases: { prepare: phaseHandler("prepare"), merge: phaseHandler("merge"), repair: phaseHandler("repair"), test: phaseHandler("test") },
		abort: async (running, runtime, context) => {
			let record: ChangeRecord | undefined;
			await runtime.commit(async (tx) => {
				const item = (await tx.doc(Integrations)).records[running.input.id];
				if (item?.integration) { item.integration.status = "cancelled"; item.status = "pending"; item.message = "集成已取消，测试和来源证据保留，未修改主目录。"; record = clone(item); }
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
			if (record) publish(record);
		},
	});

	async function runPhase(phase: Checkpoint["phase"], running: RunningTask<IntegrationInput, Checkpoint, IntegrationResult>, runtime: TaskRuntime<IntegrationInput, Checkpoint, IntegrationResult, object>, context: Context): Promise<void> {
		const saved = (await runtime.snapshot(Integrations, context))?.records[running.input.id] as ChangeRecord | undefined;
		if (!saved?.integration) throw new Error("集成记录不存在。");
		let record = clone(saved);
		const checkpoint = running.state.checkpoint as Checkpoint;
		const finish = async (status: "passed" | "failed" | "conflict" | "cancelled", message: string) => {
			record = { ...record, status: status === "conflict" ? "conflict" : "pending", message, updatedAt: runtime.now(), integration: { ...record.integration!, status } };
			const controller = Number(record.integration!.controllerId) as unknown as ConversationId;
			await runtime.commit(async (tx: Tx) => {
				(await tx.doc(Integrations)).records[record.id] = clone(record);
				if (hooks.ensureWorkflow) await hooks.ensureWorkflow(tx, controller);
				return { status: "terminal", outcome: { status: "completed", result: { id: record.id, passed: status === "passed" } } };
			}, context);
			publish(record);
		};
		const advance = async (next: Checkpoint) => {
			await runtime.commit(async (tx: Tx) => { (await tx.doc(Integrations)).records[record.id] = clone(record); return { status: "running", checkpoint: next }; }, context);
			publish(record);
		};
		try {
			if (ended(record)) { await finish(record.integration!.status as "passed" | "failed" | "conflict" | "cancelled", record.message ?? "集成已收尾"); return; }
			if (phase === "prepare") {
				const baseline = await runtime.memo<{ head: string; tree: string }>("baseline", context) ?? await runtime.memo("baseline", await workspaceTree(record.root), context);
				record.base = baseline.head; record.head = baseline.head; record.integration!.baselineTree = baseline.tree;
				const stale = await integrationStale(changes, record); if (stale) { await finish("failed", stale); return; }
				if (!existsSync(record.path)) await addWorktree(record.root, record.path, record.branch, record.base);
				if (resolve(await integrationGit(record.path, ["rev-parse", "--show-toplevel"])).toLowerCase() !== resolve(record.path).toLowerCase()) throw new Error("集成工作区不匹配。");
				record.integration!.status = "merging"; await advance({ phase: "merge", index: 0 }); return;
			}
			const stale = await integrationStale(changes, record); if (stale) { await finish("failed", stale); return; }
			const board = await runtime.snapshot(Board, context);
			if (record.integration!.sources.some((source) => Object.values(board?.tasks ?? {}).some((item) => item.changes.includes(source.id) && (item.status !== "done" || item.activeDispatch)))) { await finish("failed", "来源任务验收状态已变化，联合检查结果不能继续使用。"); return; }
			if (phase === "merge") {
				const source = record.integration!.sources[checkpoint.index];
				const repairing = !!record.integration!.repair;
				if (source) {
					const merged = await mergeIntegrationSource(record, source, checkpoint.index, repairing);
					if (merged.error) { record.integration!.conflicts = merged.conflicts; await finish("conflict", `来源 #${source.id} 无法联合合并：${merged.error}`); return; }
					if (merged.conflicts.length) record.integration!.conflicts = [...new Set([...(record.integration!.conflicts ?? []), ...merged.conflicts])];
					record.head = merged.head; await advance({ phase: "merge", index: checkpoint.index + 1 }); return;
				}
				record.files = await numstat(record.root, record.base, record.head); record.add = record.files.reduce((sum, file) => sum + file.add, 0); record.del = record.files.reduce((sum, file) => sum + file.del, 0);
				record.linked = await linkIgnoredDirs(record.root, record.path, record.subdir, config.isolation.linkDirs);
				if (repairing) {
					record.integration!.status = "repairing";
					await advance({ phase: "repair", index: 0 });
					return;
				}
				record.integration!.status = "testing"; await advance({ phase: "test", index: 0 }); return;
			}
			if (phase === "repair") {
				const rep = record.integration!.repair;
				if (!rep || !hooks.enqueue) { await finish("failed", "集成修复运行时尚未就绪。"); return; }
				const controller = Number(record.integration!.controllerId) as unknown as ConversationId;
				if (!rep.jobId) {
					const sourceBrief = record.integration!.sources.map((s) => {
						const src = changes.get(s.id);
						return `- 来源 #${s.id}（${s.base.slice(0, 12)}..${s.head.slice(0, 12)}）：${src?.task.replace(/\s+/g, " ").slice(0, 200) ?? s.id}`;
					}).join("\n");
					const conflictBrief = record.integration!.conflicts?.length
						? `\n当前合并冲突文件（已写入标准 <<<<<<< / ======= / >>>>>>> 标记）：\n${record.integration!.conflicts.map((f) => `  - ${f}`).join("\n")}\n请阅读冲突文件及各来源改动意图，保留所有来源的正确功能并彻底清除冲突标记。`
						: "";
					const failBrief = rep.previousFailure ? `\n前次集成失败证据：\n${rep.previousFailure.slice(-3000)}` : "";
					const checkBrief = record.integration!.checks.map((c) => `${c.name}: ${c.command} ${c.args.join(" ")}`).join("；");
					const lessons = (await runtime.snapshot(Learning, context))?.lessons ?? [];
					const sourceFiles = [...new Set([...(record.integration!.conflicts ?? []), ...record.integration!.sources.flatMap((s) => changes.get(s.id)?.files.map((f) => f.path) ?? [])])];
					const relevant = relevantLessons(lessons, `${record.task}\n${failBrief}`, sourceFiles);
					const prompt = [
						`联合集成修复 #${record.id}（源自失败集成 #${rep.fromId}）。`,
						"你在独立修复工作副本中工作，原始来源分支与主目录均不会受影响。",
						"来源分支：",
						sourceBrief,
						conflictBrief,
						failBrief,
						relevant ? `\n相关历史修复经验（仅参考，以当前代码和检查为准）：\n${relevant}` : "",
						rep.note ? `\n补充修复要求：${rep.note}` : "",
						`\n联合验收将自动重跑全量检查（${checkBrief}）。请最小化修改解决冲突或跨模块接口/类型/测试不兼容问题，禁止删除正常功能或弱化测试标准。`,
					].filter(Boolean).join("\n");
					await runtime.commit(async (tx: Tx) => {
						const current = (await tx.doc(Integrations)).records[record.id];
						if (!current?.integration?.repair || current.integration.repair.jobId) { record = clone(current ?? record); return; }
						// Publish current record before enqueueing so based_on sees repairing status & head.
						publish(record);
						const job = await hooks.enqueue!(tx, controller, rep.callId, rep.member, { task: prompt, based_on: record.id, ...(rep.model ? { model: rep.model } : {}) }, rep.model);
						(await tx.doc(Jobs)).jobs[job.id]!.workflow = true;
						record.integration!.repair!.jobId = job.id;
						(await tx.doc(Integrations)).records[record.id] = clone(record);
					}, context);
					publish(record);
					await runtime.sleepUntil(runtime.now() + 250, { phase: "repair", index: 0 }, context);
					return;
				}
				const job = (await runtime.snapshot(Jobs, context))?.jobs[rep.jobId];
				if (!job || job.status === "running") { await runtime.sleepUntil(runtime.now() + 250, { phase: "repair", index: 0 }, context); return; }
				if (job.status === "cancelled") { await finish("cancelled", "集成修复派工已取消，保留现场。"); return; }
				if (job.status !== "done" || !job.changeId) { await finish("failed", `集成修复派工 #${job.id} 未能完成修复（status=${job.status}, change=${job.changeId ?? "none"}）：${job.result ?? ""}`); return; }
				const fix = changes.get(job.changeId);
				if (!fix || fix.status === "dropped" || fix.message) { await finish("failed", "修复代码副本缺失或提交异常，未进入联合检查。"); return; }
				const markers = await findConflictMarkers(record.root, record.base, fix.head);
				if (markers.length) { record.integration!.conflicts = markers; await finish("conflict", `修复后文件中仍残留合并冲突标记：${markers.join("、")}`); return; }
				const actualRoot = await integrationGit(record.path, ["rev-parse", "--show-toplevel"]);
				if (resolve(actualRoot).toLowerCase() !== resolve(record.path).toLowerCase() || resolve(record.path).toLowerCase() === resolve(record.root).toLowerCase()) throw new Error("集成工作区路径验证失败。");
				await integrationGit(record.path, ["reset", "--hard", fix.head]);
				record.head = fix.head;
				record.integration!.repair!.changeId = fix.id;
				record.integration!.conflicts = [];
				record.integration!.reports = [];
				record.files = await numstat(record.root, record.base, record.head);
				record.add = record.files.reduce((sum, file) => sum + file.add, 0);
				record.del = record.files.reduce((sum, file) => sum + file.del, 0);
				record.linked = await linkIgnoredDirs(record.root, record.path, record.subdir, config.isolation.linkDirs);
				record.integration!.status = "testing";
				await advance({ phase: "test", index: 0 });
				return;
			}
			if (await integrationGit(record.path, ["rev-parse", "HEAD"]) !== record.head || await integrationGit(record.path, ["status", "--porcelain"])) { await finish("failed", "联合检查前工作区已变化，请修复来源后重建集成，保留现场。"); return; }
			const check = record.integration!.checks[checkpoint.index];
			if (check) {
				// A crash after an external check started has an unknown outcome; never silently repeat it.
				if (await runtime.memo(`check-started:${checkpoint.index}`, context)) { await finish("failed", `联合检查 ${check.name} 中途被打断，未自动重复运行；可用 /integrate rerun ${record.id} 重建验证。`); return; }
				await runtime.memo(`check-started:${checkpoint.index}`, true, context);
				const cancel = hub.register(`integration:${record.id}`), signal = AbortSignal.any([runtime.signal, cancel]);
				let result;
				try { result = await runCli({ command: check.command === "node" ? process.execPath : check.command, args: check.args, cwd: join(record.path, record.subdir), env: cleanEnv(config.stripEnv), timeoutMs: (check.timeoutSeconds ?? 120) * 1000, signal, onLine: (line) => hub.output(`integration:${record.id}`, line) }); }
				finally { hub.release(`integration:${record.id}`); }
				if (runtime.signal.aborted || hub.closing) return;
				const passed = result.exitCode === 0 && !result.aborted && !result.timedOut;
				record.integration!.reports.push({ name: check.name, passed, exitCode: result.exitCode, output: (result.stdout + result.stderr).slice(-12000), at: runtime.now() });
				if (!passed) { await finish(result.aborted ? "cancelled" : "failed", `联合检查 ${check.name} ${result.timedOut ? "超时" : result.aborted ? "已取消" : "失败"}，保留日志与集成工作区。`); return; }
				await advance({ phase: "test", index: checkpoint.index + 1 }); return;
			}
			if (record.integration!.reports.length !== record.integration!.checks.length || record.integration!.reports.some((report) => !report.passed)) { await finish("failed", "联合检查结果不完整。"); return; }
			record.verification = { head: record.head, passed: true, at: runtime.now(), checks: record.integration!.checks.map((check) => check.name) };
			if (record.integration!.repair) {
				const rep = record.integration!.repair;
				const lessonKey = `integration:${record.id}`;
				await runtime.commit(async (tx: Tx) => {
					const learning = await tx.doc(Learning);
					if (!learning.lessons.some((l) => l.key === lessonKey)) {
						learning.lessons.push({
							key: lessonKey,
							kind: "integration",
							task: record.task.slice(0, 200),
							files: record.files.map((f) => f.path).slice(0, 20),
							checks: record.verification!.checks,
							repairs: 1,
							at: runtime.now(),
							failure: rep.previousFailure?.slice(-1200),
							resolution: `由 ${rep.member} 在独立修复副本解决后通过联合检查`,
							changeId: record.id,
							head: record.head,
						});
						learning.lessons = learning.lessons.slice(-50);
					}
				}, context);
			}
			await finish("passed", record.integration!.repair ? "冲突/联调问题已在独立副本修复并通过全量联合检查；等待用户 /apply 确认。" : "多成员改动已联合验证通过；等待用户 /apply 确认，不自动修改主目录。");
		} catch (error) { if (!runtime.signal.aborted && !hub.closing) await finish("failed", error instanceof Error ? error.message : String(error)); }
	}

	async function create(
		tx: Tx,
		controller: ConversationId,
		ids: string[],
		key: string,
		extra?: { replacesId?: string; repair?: NonNullable<ChangeRecord["integration"]>["repair"] },
	): Promise<ChangeRecord> {
		const doc = await tx.doc(Integrations), previous = doc.byKey[key];
		if (previous && doc.records[previous]) return clone(doc.records[previous]);
		if (ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error("联合集成需要 2–8 个不同的完整改动编号。");
		const signature = ids.map((id) => `${id}:${changes.get(id)?.head}`).sort().join("|");
		if (!extra?.repair) {
			const active = Object.values(doc.records).find((record) => record.integration?.controllerId === String(controller) && !ended(record) && !record.integration.repair && record.integration.sources.map((source) => `${source.id}:${source.head}`).sort().join("|") === signature);
			if (active) { doc.byKey[key] = active.id; return clone(active); }
		}
		const board = await tx.doc(Board);
		const sources = ids.map((id) => {
			const source = changes.list().find((item) => item.id === id);
			if (!source || !["pending", "empty"].includes(source.status) || source.integration || source.message) throw new Error(`来源 #${id} 不存在、未成功交付或不是可集成的成员改动。`);
			if (source.sessionId && hub.busySessions.has(source.sessionId)) throw new Error(`来源 #${id} 的成员会话仍在执行，等待收尾后集成。`);
			const owners = Object.values(board.tasks).filter((item) => item.changes.includes(id));
			if (owners.some((item) => item.status !== "done" || (item.controllerId ?? item.lastAttempt?.controllerId ?? String(controller)) !== String(controller))) throw new Error(`来源 #${id} 所属任务尚未验收，或属于其他总控。`);
			return source;
		});
		const first = sources[0]!;
		if (sources.some((source) => resolve(source.root).toLowerCase() !== resolve(first.root).toLowerCase() || source.subdir !== first.subdir)) throw new Error("联合集成的来源必须属于同一仓库和工作目录。");
		const checks = autonomyChecksForRoot(first.root, config);
		if (!checks.length) {
			if (!sameConfigRepoRoot(first.root, config)) throw new Error(`外部仓库 ${first.root} 未配置 autonomy.checks（请在目标仓库添加 pi-agent.config.json 或按目标目录新建会话并配置检查），未误用主仓库检查。`);
			throw new Error("请先配置 autonomy.checks 作为联合测试命令；没有检查不能标记集成通过。");
		}
		for (const check of checks) if (!check.name || !check.command || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string") || check.timeoutSeconds !== undefined && (!Number.isFinite(check.timeoutSeconds) || check.timeoutSeconds <= 0)) throw new Error("联合检查需要有效的名称、命令、参数和正数超时。");
		const id = `I${createHash("sha256").update(`${controller}:${key}`).digest("hex").slice(0, 12)}`;
		const path = join(dirname(config.storage), "worktrees", "integrations", id), branch = `codex/integration-${id}`;
		const taskId = await tx.createTask(task, { id }, { ownership: { kind: "conversation" }, conversationId: controller, background: true });
		const taskLabel = extra?.repair ? `修复集成 #${extra.repair.fromId}（${ids.map((s) => `#${s}`).join(" + ")}）` : `联合集成 ${ids.map((s) => `#${s}`).join(" + ")}`;
		const record: ChangeRecord = {
			id, agent: "integration", callId: key, task: taskLabel, root: first.root, subdir: first.subdir, path, branch, base: "", head: "", files: [], add: 0, del: 0, status: "running", createdAt: Date.now(), updatedAt: Date.now(),
			integration: {
				id, controllerId: String(controller), taskId: String(taskId),
				sources: sources.map((source) => ({ id: source.id, base: changes.range(source)[0], head: source.head })),
				baselineTree: "", checks: clone(checks), status: "preparing", reports: [],
				...(extra?.replacesId ? { replacesId: extra.replacesId } : {}),
				...(extra?.repair ? { repair: clone(extra.repair) } : {}),
			},
		};
		doc.records[id] = clone(record); doc.byKey[key] = id;
		if (extra?.replacesId && doc.records[extra.replacesId]?.integration) {
			const old = doc.records[extra.replacesId]!;
			old.integration!.supersededBy = id;
			publish(old);
			for (const item of Object.values(board.tasks)) {
				if (item.integrationId === extra.replacesId && item.status === "blocked" && !item.dispatches.length && (item.controllerId ?? String(controller)) === String(controller)) {
					item.integrationId = id;
					item.status = "todo";
					item.notes.push(`已使用新联合集成 #${id} 替代 #${extra.replacesId}，等待联合验证通过后继续。`);
					item.updatedAt = Date.now();
				}
			}
			if (hooks.ensureWorkflow) await hooks.ensureWorkflow(tx, controller);
		}
		return record;
	}

	async function rerun(tx: Tx, controller: ConversationId, targetId: string, key: string): Promise<ChangeRecord> {
		const doc = await tx.doc(Integrations), existing = doc.byKey[key];
		if (existing && doc.records[existing]) return clone(doc.records[existing]);
		const original = doc.records[targetId] ?? Object.values(doc.records).find((r) => r.id.startsWith(targetId));
		if (!original?.integration || original.integration.controllerId !== String(controller)) throw new Error("找不到本总控的集成记录。");
		if (!ended(original)) throw new Error(`集成 #${original.id} 仍在运行中；如需重来请先取消。`);
		if (original.status === "applied") throw new Error(`集成 #${original.id} 已应用到主目录，无需重验。`);
		return create(tx, controller, original.integration.sources.map((s) => s.id), key, { replacesId: original.id });
	}

	async function repair(tx: Tx, controller: ConversationId, targetId: string, member: string, note: string | undefined, model: string | undefined, key: string): Promise<ChangeRecord> {
		const doc = await tx.doc(Integrations), existing = doc.byKey[key];
		if (existing && doc.records[existing]) return clone(doc.records[existing]);
		const original = doc.records[targetId] ?? Object.values(doc.records).find((r) => r.id.startsWith(targetId));
		if (!original?.integration || original.integration.controllerId !== String(controller)) throw new Error("找不到本总控的集成记录。");
		if (!["conflict", "failed"].includes(original.integration.status)) throw new Error(`仅失败（failed）或冲突（conflict）的集成可启动修复；当前状态为 ${original.integration.status}。`);
		if (!config.isolation.enabled) throw new Error("集成修复需要启用 Git worktree 隔离（isolation.enabled = true）。");
		if (!hooks.available?.has(member) || !hooks.enqueue) throw new Error(`编码成员 ${member} 当前不可用，请检查 /agents。`);
		const agentCfg = config.agents[member];
		if (!agentCfg || agentCfg.workspace === "none") throw new Error(`成员 ${member} 不是代码工作区成员（workspace=none），不能执行集成代码修复。`);
		if (agentCfg.api && !memberToolNames(agentCfg.api).some((t) => ["write", "edit"].includes(t))) throw new Error(`API 成员 ${member} 缺少 write/edit 权限，不能执行集成代码修复。`);
		if (model && agentCfg.models.length && !agentCfg.models.some((m) => m.id === model)) throw new Error(`成员 ${member} 没有配置模型 ${model}。`);
		const failedReport = original.integration.reports.find((r) => !r.passed);
		const previousFailure = [
			original.message ?? "",
			failedReport ? `[${failedReport.name} exit ${failedReport.exitCode}]\n${failedReport.output.slice(-2500)}` : "",
		].filter(Boolean).join("\n");
		return create(tx, controller, original.integration.sources.map((s) => s.id), key, {
			replacesId: original.id,
			repair: {
				fromId: original.id,
				member,
				...(model ? { model } : {}),
				...(note?.trim() ? { note: note.trim().slice(0, 2000) } : {}),
				callId: `integration-repair:${key}`,
				...(previousFailure ? { previousFailure } : {}),
			},
		});
	}

	const tool = defineTool({
		name: "integrate_changes",
		description: "将 2–8 个已验收的成员代码改动放到独立集成 worktree，依次合并并运行配置中的 autonomy.checks；也可传 rerun_id 对因主目录变化或中断失效的集成基于最新基线重验。返回集成编号，read_integration 查看进度、冲突与测试日志；只有用户终端 /apply 才应用。",
		parameters: obj({
			changes: opt(arr(str(), { minItems: 2, maxItems: 8, description: "2–8 个已验收成员改动编号（与 rerun_id 二选一）" })),
			rerun_id: opt(str({ description: "要基于当前最新主目录与来源基线重新合并验证的旧集成编号" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			try {
				if (!args.rerun_id && (!args.changes || args.changes.length < 2)) throw new Error("请提供 2–8 个 changes 改动编号，或指定 rerun_id 重验已有集成。");
				const record = await api.commit((tx) => args.rerun_id ? rerun(tx, api.conversationId, args.rerun_id, `tool:${api.taskId}`) : create(tx, api.conversationId, args.changes!, `tool:${api.taskId}`), context);
				publish(record);
				return { output: [{ type: "text" as const, text: JSON.stringify(integrationSummary(record)) }] };
			} catch (error) { return { output: [{ type: "text" as const, text: String(error) }], isError: true }; }
		},
	});

	const repairTool = defineTool({
		name: "repair_integration",
		description: "针对处于 conflict（合并冲突）或 failed（联合检查未通过）的联合集成，在独立修复副本中派编码成员解决冲突或跨模块问题，完成后自动重跑全部 autonomy.checks。原始来源分支与主目录不会被修改；通过后仍需用户终端 /apply。",
		parameters: obj({
			id: str({ description: "处于 conflict 或 failed 状态的集成编号（如 I...）" }),
			member: str({ description: "负责修复的可用编码成员 ID（CLI 或具备写权限的 API 编码成员）" }),
			note: opt(str({ description: "可选修复提示，说明如何取舍冲突或对齐接口" })),
			model: opt(str({ description: "可选指定成员模型 ID" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			try {
				const record = await api.commit((tx) => repair(tx, api.conversationId, args.id, args.member, args.note, args.model, `tool:${api.taskId}`), context);
				publish(record);
				return { output: [{ type: "text" as const, text: JSON.stringify(integrationSummary(record)) }] };
			} catch (error) { return { output: [{ type: "text" as const, text: String(error) }], isError: true }; }
		},
	});

	const read = defineTool({
		name: "read_integration",
		description: "读取当前总控的联合集成进度与检查结果；wait:true 等待完成时由 Durable 原生挂起，不反复调用模型。",
		parameters: obj({ id: opt(str()), wait: opt(bool()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const records = Object.values((await api.snapshot(Integrations, context))?.records ?? {}).filter((record) => record.integration?.controllerId === String(api.conversationId) && (!args.id || record.id === args.id));
			if (args.wait && records.some((record) => !ended(record))) return { sleep: { until: api.now() + 250 } };
			return { output: [{ type: "text" as const, text: JSON.stringify(records.map((record) => integrationSummary(changes.get(record.id) ?? record))) }], isError: !!args.id && !records.length };
		},
	});

	return {
		task,
		tools: [tool, repairTool, read],
		create,
		rerun,
		repair,
		async start(controller: ConversationId, ids: string[], context: Context) {
			if (!hub.harness) throw new Error("运行时尚未就绪。");
			const record = await hub.harness.commit((tx) => create(tx, controller, ids, `terminal:${randomUUID()}`), context);
			publish(record); hub.harness.resume(); return record;
		},
		async startRerun(controller: ConversationId, id: string, context: Context) {
			if (!hub.harness) throw new Error("运行时尚未就绪。");
			const record = await hub.harness.commit((tx) => rerun(tx, controller, id, `terminal-rerun:${randomUUID()}`), context);
			publish(record); hub.harness.resume(); return record;
		},
		async startRepair(controller: ConversationId, id: string, member: string, note: string | undefined, context: Context) {
			if (!hub.harness) throw new Error("运行时尚未就绪。");
			const record = await hub.harness.commit((tx) => repair(tx, controller, id, member, note, undefined, `terminal-repair:${randomUUID()}`), context);
			publish(record); hub.harness.resume(); return record;
		},
		async cancel(controller: ConversationId, id: string, context: Context) {
			const record = (await hub.harness?.snapshot(Integrations, context))?.records[id];
			if (!record || record.integration?.controllerId !== String(controller)) throw new Error("找不到本总控的集成记录。");
			if (ended(record)) return;
			const repairJobId = record.integration.repair?.jobId;
			if (repairJobId) {
				await hub.cancel(repairJobId, "user", context);
				const job = (await hub.harness?.snapshot(Jobs, context))?.jobs[repairJobId];
				if (job?.piTask) await hub.harness!.abortTask(Number(job.piTask) as any, BACKGROUND_CONTEXT).catch(() => {});
			}
			await hub.cancel(`integration:${record.id}`, "user", context);
			await hub.harness!.abortTask(Number(record.integration.taskId) as any, context);
		},
	};
}
