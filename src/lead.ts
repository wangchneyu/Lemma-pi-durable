// 子调度：总调度把一个较大的子目标（比如"后端"、"前端"）整块交给一个子负责人。
// 子负责人是 Pi Durable 里的一个子对话，和总调度用同一个模型、同一套派工工具（ask_* / plan_tasks / wait_jobs …），
// 在自己的范围里拆任务、派成员、验收，最后把结果汇报给总调度。
// 只有一层：子负责人拿不到 delegate_to_lead，不能再往下开子调度。花费算在用户这一轮里，和总调度共用上限。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, configure, defineTool, type EntryRecord, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { commitBoard, defined, checkBudget, type DispatchDeps } from "./dispatch.ts";
import { clip, Jobs, type JobsState } from "./jobs.ts";

/** 子调度的提交 requestId 前缀：由它开始的运行不重置花费（仍算用户那一轮） */
export const LEAD_REQUEST_PREFIX = "pi-agent:lead:";
export const LEAD_TOOL = "delegate_to_lead";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text ?? ""))
		.join("");
}

function leadInstructions(name: string, goal: string, scope: string | undefined, taskId: string | undefined): string {
	return [
		`你现在是子调度「${name}」：总调度把下面这个子目标整块交给你负责。你和总调度用同一套工具（ask_* 派工、plan_tasks / update_task 维护分工表、wait_jobs / cancel_job 管后台派工），但只管这个子目标。`,
		`子目标：${goal}`,
		scope ? `范围和约束：${scope}` : "",
		taskId ? `它对应分工表里的任务 ${taskId}。你拆出的子任务用 plan_tasks 写进分工表时，传 parent: "${taskId}"。` : "",
		"工作方式：",
		"- 先判断要不要拆：小目标直接派一个成员；较大的才用 plan_tasks 拆成几项，按角色派给合适的成员，互不依赖的并行或放后台。",
		"- 只做这个子目标范围内的事，不要处理别的部分，也不要改总调度的其他任务。",
		"- 你没有再往下开子调度的工具，所有活都直接派给成员。",
		"- 开了后台派工的，必须先用 wait_jobs 收齐结果再汇报；不要留下还在跑的后台派工。",
		"- 最后用中文给总调度一份简短汇报：做了什么（按任务 / 派工列出成员、模型、改动编号）、验收结论、没做完或有风险的地方。这份汇报就是你的最终回答。",
	]
		.filter(Boolean)
		.join("\n");
}

/** 子对话里新出现的条目 → 进度行（子调度派了谁、做了什么决定） */
function progressLines(entry: EntryRecord): string[] {
	const m = entry.model?.[0] as any;
	if (!m) return [];
	if (entry.kind === "pi.assistant") {
		const out: string[] = [];
		for (const b of m.content ?? []) {
			if (b.type === "text" && b.text?.trim()) out.push(`💬 ${clip(b.text, 120)}`);
			if (b.type === "toolCall") {
				const a = b.arguments ?? {};
				const what = a.task ?? a.title ?? (Array.isArray(a.tasks) ? a.tasks.map((t: any) => t.title).join("；") : a.id ?? "");
				out.push(`🔧 ${b.name}${a.background ? "（后台）" : ""} ${clip(String(what), 90)}`);
			}
		}
		return out;
	}
	if (entry.kind === "pi.tool-result" && m.isError) return [`❌ ${m.toolName}：${clip(textOf(m.content), 140)}`];
	return [];
}

export function createLeadTool(deps: DispatchDeps): ToolRegistration {
	const { config, project, hub } = deps;
	const tool: ToolRegistration = defineTool({
		name: LEAD_TOOL,
		description:
			"把一个较大的子目标（一整块功能、一个子系统，比如前端 / 后端 / 数据迁移）交给一个子调度负责。子调度会自己拆任务、派成员、验收，最后汇报给你；" +
			"你只需要给出子目标、范围和验收标准。互不依赖的几个子目标可以在同一轮里分别交给几个子调度并行推进。小任务直接用 ask_* 派给成员，不要用这个。",
		parameters: obj({
			goal: str({ description: "子目标：要做成什么、验收标准" }),
			name: opt(str({ description: "子调度的名字，比如「后端」「前端」，显示在拓扑和汇报里" })),
			scope: opt(str({ description: "范围和约束：哪些目录 / 模块归它，不能碰什么" })),
			task_id: opt(str({ description: "这个子目标对应分工表里的哪项任务（如 T2）" })),
		}),
		replay: "safe",
		execute: async (args: { goal: string; name?: string; scope?: string; task_id?: string }, api, context) => {
			const name = (args.name ?? "子调度").trim().slice(0, 24) || "子调度";
			const io = {
				commit: <T>(change: (tx: any) => T | Promise<T>) => api.commit(change, context),
				now: () => api.now(),
				output: (chunk: string) => api.output(chunk),
				callId: api.callId,
				taskId: String(api.taskId),
				conversationId: api.conversationId,
				signal: context.abortSignal,
				memo: (n: string, c?: any) => (c === undefined ? api.memo(n, context) : api.memo(n, c, context)),
				details: (v: JsonObject) => api.details(v, context),
			};
			const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
			const over = await checkBudget(io as any, config);
			if (over) return fail(over);
			if (args.task_id) {
				const exists = await api.commit(async (tx) => !!(await tx.doc((await import("./board.ts")).Board)).tasks[args.task_id!], context);
				if (!exists) return fail(`分工表里没有任务 ${args.task_id}。`);
			}

			// ---- 子对话：由这次调用拥有（中止调用就中止它；重放时按拥有者找回同一个） ----
			const childId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId as any }, 1)).items[0];
				if (existing) return String(existing.id);
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId as any } });
				// 和总调度同一个模型和派工工具，只是不能再开子调度
				await configure(tx, created.id, {
					instructions: leadInstructions(name, args.goal, args.scope, args.task_id),
					tools: { remove: [tool] },
					maxTurns: config.orchestrator.maxTurns ?? 40,
				});
				return String(created.id);
			}, context);
			await api.details({ conversationId: childId, name, goal: clip(args.goal, 200), ...(args.task_id ? { taskId: args.task_id } : {}) }, context);
			api.output(`🧭 子调度「${name}」开始：${clip(args.goal, 100)}\n`);
			if (args.task_id) {
				await commitBoard(project, io as any, (b) => {
					const t = b.tasks[args.task_id!];
					if (!t || t.status === "done") return;
					t.status = "doing";
					t.owner = `子调度·${name}`;
					if (!t.dispatches.includes(api.callId)) t.dispatches.push(api.callId);
					t.updatedAt = api.now();
				});
			}

			const harness = hub.harness;
			if (!harness) return fail("子调度没有就绪。");
			const ctx = BACKGROUND_CONTEXT;
			const child = await harness.conversation(childId as any, ctx);
			if (!child) return fail("找不到子调度的对话。");

			// 进度：子调度派了谁、做了什么
			const watch = await child.watch(ctx);
			const seen = new Set(watch.value.entries.map((e) => e.id));
			watch.start(async (call) => {
				if (call.kind !== "value") return;
				for (const entry of call.value.entries) {
					if (seen.has(entry.id)) continue;
					seen.add(entry.id);
					for (const line of progressLines(entry)) api.output(`  [${name}] ${line}\n`);
				}
			});

			const started = api.now();
			try {
				const first = await child.submit(
					{ type: "input", content: `${args.goal}${args.scope ? `\n\n范围和约束：${args.scope}` : ""}`, requestId: `${LEAD_REQUEST_PREFIX}${api.taskId}`, whenBusy: "followUp" },
					ctx,
				);
				let settled = (await first.wait(ctx)) as any;
				// 子调度汇报时还留着后台派工：提醒它收齐再汇报（最多两次）
				for (let round = 1; round <= 2 && settled.status === "done"; round++) {
					const running = Object.values(((await harness.snapshot(Jobs, ctx)) as JobsState | undefined)?.jobs ?? {}).filter((j) => j.status === "running" && j.conversation === childId);
					if (!running.length) break;
					api.output(`  [${name}] 还有后台派工 ${running.map((j) => j.id).join("、")} 没结束，让它收齐后再汇报\n`);
					const again = await child.submit(
						{
							type: "input",
							content: `（系统提示）你还有后台派工 ${running.map((j) => j.id).join("、")} 没有结束。请用 wait_jobs 收齐结果、验收后，再给出最终汇报。`,
							requestId: `${LEAD_REQUEST_PREFIX}${api.taskId}:wait:${round}`,
							whenBusy: "followUp",
						},
						ctx,
					);
					settled = (await again.wait(ctx)) as any;
				}

				// 汇总：最终回答、派了几次工、产生了哪些改动
				const entries: EntryRecord[] = [];
				let cursor: any;
				do {
					const page = await child.entries({ order: "ascending" } as any, 500, cursor, ctx);
					entries.push(...page.items);
					cursor = page.next;
				} while (cursor);
				let answer = "";
				let dispatches = 0;
				const changeIds = new Set<string>();
				for (const e of entries) {
					const m = e.model?.[0] as any;
					if (AssistantEntry.is(e)) {
						const t = textOf(m?.content).trim();
						if (t) answer = t;
						dispatches += (m?.content ?? []).filter((b: any) => b.type === "toolCall" && String(b.name).startsWith("ask_")).length;
					} else if (e.kind === "pi.tool-result" && String(m?.toolName).startsWith("ask_")) {
						for (const x of textOf(m?.content).matchAll(/\[改动 #(\w+)：\d+ 个文件/g)) changeIds.add(x[1]!);
					}
				}
				const done = settled.status === "done";
				if (args.task_id) {
					await commitBoard(project, io as any, (b) => {
						const t = b.tasks[args.task_id!];
						if (!t) return;
						if (t.status !== "done") t.status = done ? "review" : "blocked";
						for (const id of changeIds) if (!t.changes.includes(id)) t.changes.push(id);
						t.notes.push(`${new Date(api.now()).toLocaleString("zh-CN", { hour12: false })} 子调度·${name}：${done ? `完成，派工 ${dispatches} 次，待验收` : `没有完成（${settled.reason ?? settled.status}）`}`);
						t.updatedAt = api.now();
					});
				}
				const meta = `[子调度: ${name} | 派工: ${dispatches} 次 | 改动: ${changeIds.size ? [...changeIds].map((c) => `#${c}`).join(" ") : "无"} | 耗时: ${Math.round((api.now() - started) / 1000)}s]`;
				const body = done ? answer || "（子调度没有文字汇报）" : `子调度没有完成（${settled.reason ?? settled.status}${settled.detail ? `：${settled.detail}` : ""}）${answer ? `\n\n最后的输出：\n${answer}` : ""}`;
				return {
					output: [{ type: "text", text: `${body}\n\n${args.task_id ? `[任务 ${args.task_id} ${done ? "标为待验收：对照验收标准核对后用 update_task 标完成或打回" : "标为受阻"}]\n\n` : ""}${meta}` }],
					isError: !done,
					details: defined({ conversationId: childId, name, goal: clip(args.goal, 200), taskId: args.task_id, dispatches, changes: [...changeIds], durationMs: api.now() - started }) as JsonObject,
				};
			} finally {
				await watch.stop().catch(() => {});
			}
		},
	});
	return tool;
}
