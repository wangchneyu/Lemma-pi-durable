// 网页端设置与协作控制弹窗：成员增改、并发预算、总控模型、任务恢复、集成修复与外部操作核对。
import { refreshChanges, refreshDispatches, refreshState, store } from "./store.js";
import { esc, post, toast } from "./util.js";

let dialogEl;

function ensureDialog() {
	if (dialogEl) return dialogEl;
	dialogEl = document.createElement("dialog");
	dialogEl.className = "edit-dialog";
	dialogEl.innerHTML = `
		<form class="edit-form" method="dialog">
			<header class="edit-head">
				<h3 data-n="title"></h3>
				<button type="button" class="icon-btn" data-n="close" aria-label="关闭">
					<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
				</button>
			</header>
			<div class="edit-body" data-n="body"></div>
			<p class="edit-error" data-n="error" role="alert" hidden></p>
			<footer class="edit-foot">
				<button type="button" class="ghost-btn" data-n="cancel">取消</button>
				<button type="submit" class="primary-btn" data-n="submit">保存</button>
			</footer>
		</form>`;
	document.body.append(dialogEl);
	const close = () => dialogEl.close();
	dialogEl.querySelector('[data-n="close"]').addEventListener("click", close);
	dialogEl.querySelector('[data-n="cancel"]').addEventListener("click", close);
	return dialogEl;
}

function openModal({ title, submitText = "确认", danger = false, bodyHtml, onMount, onSubmit }) {
	const d = ensureDialog();
	const form = d.querySelector("form");
	const body = d.querySelector('[data-n="body"]');
	const err = d.querySelector('[data-n="error"]');
	const submitBtn = d.querySelector('[data-n="submit"]');
	d.querySelector('[data-n="title"]').textContent = title;
	submitBtn.textContent = submitText;
	submitBtn.classList.toggle("danger-btn", danger);
	submitBtn.disabled = false;
	err.hidden = true;
	err.textContent = "";
	body.innerHTML = bodyHtml;
	onMount?.(body);
	form.onsubmit = async (e) => {
		e.preventDefault();
		err.hidden = true;
		submitBtn.disabled = true;
		try {
			const msg = await onSubmit(body);
			d.close();
			refreshState();
			refreshChanges();
			refreshDispatches();
			if (msg) toast(msg);
		} catch (error) {
			err.textContent = error instanceof Error ? error.message : String(error);
			err.hidden = false;
		} finally {
			submitBtn.disabled = false;
		}
	};
	if (typeof d.showModal === "function") d.showModal();
	else d.setAttribute("open", "");
}

export async function runControlAction(path, payload, successMessage) {
	const res = await post(path, payload);
	refreshState();
	refreshChanges();
	refreshDispatches();
	toast(successMessage || res?.message || "操作已完成");
	return res;
}

export function openMemberEditor(agent) {
	const isAdd = !agent;
	const isCli = !!agent && !agent.api;
	const tools = new Set(agent?.api?.builtinTools ?? ["read"]);
	const modelChoices = (agent?.models ?? []).map((m) => `<option value="${esc(m.id)}"></option>`).join("");
	openModal({
		title: isAdd ? "新增 API 成员" : isCli ? `配置 CLI 成员 · ${agent.label}` : `编辑 API 成员 · ${agent.label}`,
		submitText: isAdd ? "创建成员" : "保存生效",
		bodyHtml: isCli
			? `
				<p class="edit-note">本地 CLI 成员（<code>${esc(agent.kind)}</code>）的接入命令由本地环境探测，网页端支持切换启停状态与默认模型。</p>
				<label class="field"><span>成员状态</span><select name="enabled"><option value="true"${agent.enabled ? " selected" : ""}>启用</option><option value="false"${!agent.enabled ? " selected" : ""}>停用</option></select></label>
				<label class="field"><span>默认模型 ID</span><input name="defaultModel" list="memberModelList" value="${esc(agent.defaultModel ?? "")}" placeholder="留空表示 CLI 默认" autocomplete="off" /><datalist id="memberModelList">${modelChoices}</datalist></label>
			`
			: `
				<div class="field-grid">
					<label class="field"><span>成员 ID</span><input name="id" value="${esc(agent?.kind ?? "")}" ${isAdd ? 'required pattern="[a-z][a-z0-9_]{0,47}" placeholder="例如 reviewer_ds"' : "readonly"} autocomplete="off" /></label>
					<label class="field"><span>显示名称</span><input name="name" value="${esc(agent?.label ?? "")}" required placeholder="例如 复核专家" /></label>
				</div>
				<label class="field"><span>职责说明（给总调度分配任务看）</span><input name="description" value="${esc(agent?.description ?? "")}" required placeholder="例如 代码只读盲审与架构把关" /></label>
				<label class="field"><span>专属系统指令（选填）</span><textarea name="instructions" rows="2" placeholder="可选，留空清空">${esc(agent?.instructions ?? "")}</textarea></label>
				<div class="field-grid">
					<label class="field"><span>API 协议</span><select name="type">
						<option value="openai-compatible"${agent?.api?.type !== "anthropic-compatible" ? " selected" : ""}>openai-compatible</option>
						<option value="anthropic-compatible"${agent?.api?.type === "anthropic-compatible" ? " selected" : ""}>anthropic-compatible</option>
					</select></label>
					<label class="field"><span>工作区模式</span><select name="workspace">
						<option value="code"${(agent?.workspace ?? "code") === "code" ? " selected" : ""}>code（隔离 git worktree）</option>
						<option value="none"${agent?.workspace === "none" ? " selected" : ""}>none（纯对话/无 Git）</option>
					</select></label>
				</div>
				<label class="field"><span>API 服务地址</span><input name="baseUrl" type="url" value="${esc(agent?.api?.baseUrl ?? "")}" required placeholder="https://api.deepseek.com/v1" /></label>
				<div class="field-grid">
					<label class="field"><span>默认模型 ID</span><input name="defaultModel" list="memberModelList" value="${esc(agent?.defaultModel ?? "")}" required placeholder="例如 deepseek-chat" autocomplete="off" /><datalist id="memberModelList">${modelChoices}</datalist></label>
					<label class="field"><span>启用状态</span><select name="enabled"><option value="true"${agent?.enabled !== false ? " selected" : ""}>启用</option><option value="false"${agent?.enabled === false ? " selected" : ""}>停用</option></select></label>
				</div>
				<div class="field"><span>内置工具权限（只读复核建议仅勾选 read）</span>
					<div class="check-row">
						${["read", "write", "edit", "bash"].map((t) => `<label class="check-chip"><input type="checkbox" name="tool" value="${t}"${tools.has(t) ? " checked" : ""} /><code>${t}</code></label>`).join("")}
					</div>
				</div>
				<label class="field" data-n="bashRow"${tools.has("bash") ? "" : " hidden"}><span>允许的 Bash 命令前缀（逗号分隔）</span><input name="bashAllow" value="${esc((agent?.api?.bashAllow ?? []).join(", "))}" placeholder="例如 npm test, git diff" /></label>
				<label class="field"><span>API 密钥（仅写入本机加密凭据，永不回显）</span><input name="secret" type="password" value="" placeholder="${agent?.api?.hasCredential ? "留空保留现有密钥（来源：" + esc(agent.api.keySource) + "）" : "留空使用环境变量"}" autocomplete="new-password" /></label>
			`,
		onMount(body) {
			const bashBox = body.querySelector('input[name="tool"][value="bash"]');
			const bashRow = body.querySelector('[data-n="bashRow"]');
			bashBox?.addEventListener("change", () => {
				if (bashRow) bashRow.hidden = !bashBox.checked;
			});
		},
		async onSubmit(body) {
			const val = (name) => body.querySelector(`[name="${name}"]`)?.value ?? "";
			if (isCli) {
				await post(`/api/agents/${encodeURIComponent(agent.kind)}`, {
					quick: true,
					enabled: val("enabled") === "true",
					...(val("defaultModel").trim() ? { defaultModel: val("defaultModel").trim() } : {}),
				});
				return `已更新成员 ${agent.label}`;
			}
			const selectedTools = [...body.querySelectorAll('input[name="tool"]:checked')].map((el) => el.value);
			const bashAllow = val("bashAllow").split(",").map((s) => s.trim()).filter(Boolean);
			const payload = {
				id: val("id").trim(),
				name: val("name").trim(),
				description: val("description").trim(),
				instructions: val("instructions"),
				type: val("type"),
				workspace: val("workspace"),
				baseUrl: val("baseUrl").trim(),
				defaultModel: val("defaultModel").trim(),
				enabled: val("enabled") === "true",
				tools: selectedTools,
				bashAllow,
				...(val("secret").trim() ? { secret: val("secret").trim() } : {}),
			};
			if (isAdd) await post("/api/agents", payload);
			else await post(`/api/agents/${encodeURIComponent(agent.kind)}`, payload);
			return isAdd ? `已新增成员 ${payload.name}` : `已保存成员 ${payload.name}`;
		},
	});
}

export function openLimitsEditor(state) {
	const ex = state.execution ?? { maxConcurrent: 8, perMember: 4, perService: 8 };
	const b = state.budget ?? {};
	openModal({
		title: "编辑并发与预算配额",
		submitText: "保存配额",
		bodyHtml: `
			<div class="field-grid">
				<label class="field"><span>团队总并发 (1–64)</span><input name="maxConcurrent" type="number" min="1" max="64" value="${esc(ex.maxConcurrent)}" required /></label>
				<label class="field"><span>单成员并发 (1–64)</span><input name="perMember" type="number" min="1" max="64" value="${esc(ex.perMember)}" required /></label>
				<label class="field"><span>同服务地址并发 (1–64)</span><input name="perService" type="number" min="1" max="64" value="${esc(ex.perService)}" required /></label>
			</div>
			<div class="field-grid">
				<label class="field"><span>每轮成员预算 USD（留空不限）</span><input name="perRunUsd" type="number" step="0.01" min="0" value="${b.perRunUsd != null ? esc(b.perRunUsd) : ""}" placeholder="不限" /></label>
				<label class="field"><span>每次派工预留 USD（0 关闭）</span><input name="reservePerDispatchUsd" type="number" step="0.001" min="0" value="${esc(b.reservePerDispatchUsd ?? 0)}" /></label>
			</div>
		`,
		async onSubmit(body) {
			const val = (n) => body.querySelector(`[name="${n}"]`).value.trim();
			await post("/api/limits", {
				maxConcurrent: Number(val("maxConcurrent")),
				perMember: Number(val("perMember")),
				perService: Number(val("perService")),
				perRunUsd: val("perRunUsd") === "" ? null : Number(val("perRunUsd")),
				reservePerDispatchUsd: Number(val("reservePerDispatchUsd") || 0),
			});
			return "并发与预算配额已保存";
		},
	});
}

export function openOrchestratorEditor(orch) {
	openModal({
		title: "配置总控模型与接口",
		submitText: "保存总控设置",
		bodyHtml: `
			<label class="field"><span>API 协议</span><select name="type">
				<option value="openai-compatible"${orch.type === "openai-compatible" ? " selected" : ""}>openai-compatible</option>
				<option value="anthropic-compatible"${orch.type !== "openai-compatible" ? " selected" : ""}>anthropic-compatible</option>
			</select></label>
			<label class="field"><span>API 服务地址</span><input name="baseUrl" type="url" value="${esc(orch.baseUrl ?? "")}" required placeholder="https://api.anthropic.com" /></label>
			<label class="field"><span>总控模型 ID</span><input name="modelId" value="${esc(orch.modelId ?? "")}" required /></label>
			<label class="field"><span>API 密钥（仅写入本机凭据）</span><input name="secret" type="password" value="" placeholder="${orch.hasCredential ? "留空保留现有密钥（来源：" + esc(orch.keySource) + "）" : "留空使用环境变量"}" autocomplete="new-password" /></label>
		`,
		async onSubmit(body) {
			const val = (n) => body.querySelector(`[name="${n}"]`).value.trim();
			await post("/api/orchestrator", {
				type: val("type"),
				baseUrl: val("baseUrl"),
				modelId: val("modelId"),
				...(val("secret") ? { secret: val("secret") } : {}),
			});
			return "总控配置已保存并生效";
		},
	});
}

export function openRecoverDialog(task, agents = []) {
	const enabled = agents.filter((a) => a.enabled && a.available && a.kind !== task.reviewer?.member);
	const memberOpts = enabled.map((a) => `<option value="${esc(a.kind)}">${esc(a.label)} (${esc(a.kind)})</option>`).join("");
	const hasPendingPlan = (task.recoveries ?? []).some((r) => ["prepared", "running"].includes(r.status));
	openModal({
		title: `恢复 / 干预任务 · ${task.id}`,
		submitText: "执行恢复",
		bodyHtml: `
			<p class="edit-note">${esc(task.title)}</p>
			<label class="field"><span>操作方式</span><select name="action">
				<option value="resume">resume · 续接原成员会话</option>
				<option value="supply">supply · 补充资料继续执行</option>
				<option value="reassign">reassign · 改派其他成员接手</option>
				${hasPendingPlan ? `<option value="cancel">cancel · 取消未执行的恢复计划</option>` : ""}
			</select></label>
			<label class="field" data-n="memberRow" hidden><span>接手成员</span><select name="member">${memberOpts}</select></label>
			<label class="field"><span>处理依据 / 补充资料</span><textarea name="note" rows="3" required placeholder="说明为何恢复、补充上下文或交接要求"></textarea></label>
		`,
		onMount(body) {
			const actionSel = body.querySelector('select[name="action"]');
			const memberRow = body.querySelector('[data-n="memberRow"]');
			actionSel.addEventListener("change", () => {
				memberRow.hidden = actionSel.value !== "reassign";
			});
		},
		async onSubmit(body) {
			const action = body.querySelector('select[name="action"]').value;
			const member = body.querySelector('select[name="member"]')?.value;
			const note = body.querySelector('textarea[name="note"]').value.trim();
			const res = await post(`/api/tasks/${encodeURIComponent(task.id)}/recover`, {
				action,
				note,
				...(action === "reassign" && member ? { member } : {}),
			});
			return action === "cancel" ? `已取消 ${task.id} 恢复计划` : `已派 ${res.agent} 恢复 ${task.id}`;
		},
	});
}

export function openRepairIntegrationDialog(integration, agents = []) {
	const codeMembers = agents.filter((a) => a.enabled && a.available && a.workspace !== "none");
	const opts = codeMembers.map((a) => `<option value="${esc(a.kind)}">${esc(a.label)} (${esc(a.kind)})</option>`).join("");
	openModal({
		title: `指派修复联合集成 · #${integration.id}`,
		submitText: "发起修复派工",
		bodyHtml: `
			<p class="edit-note">系统将在隔离集成分支工作区启动修复派工，完成后自动重跑全部联合检查。</p>
			<label class="field"><span>修复成员</span><select name="member">${opts}</select></label>
			<label class="field"><span>修复重点说明（可选）</span><textarea name="note" rows="3" placeholder="例如：优先解决 src/api.ts 接口对齐与单元测试报错"></textarea></label>
		`,
		async onSubmit(body) {
			const member = body.querySelector('select[name="member"]').value;
			const note = body.querySelector('textarea[name="note"]').value.trim();
			const res = await post(`/api/integrations/${encodeURIComponent(integration.id)}/repair`, { member, ...(note ? { note } : {}) });
			return `已指派 ${member} 修复并创建集成 #${res.integration?.id ?? integration.id}`;
		},
	});
}

export function openCreateIntegrationDialog(changes = []) {
	const candidates = changes.filter((c) => !c.integration && ["pending", "conflict"].includes(c.status));
	openModal({
		title: "发起多分支联合集成",
		submitText: "合并并运行联合检查",
		bodyHtml: candidates.length >= 2
			? `<p class="edit-note">勾选至少 2 个成员分支，系统将按冻结基线合并到临时集成分支并运行全套验收命令。</p>
				<div class="check-list">${candidates.map((c) => `<label class="check-item"><input type="checkbox" name="cid" value="${esc(c.id)}" checked /><span class="mono">#${esc(c.id)}</span><span>${esc(c.agent)}</span><span class="muted">${esc(c.task.slice(0, 60))}</span></label>`).join("")}</div>`
			: `<p class="edit-note">目前待处理的独立分支改动不足 2 个，无法新建联合集成。</p>`,
		onMount(body) {
			if (candidates.length < 2) ensureDialog().querySelector('[data-n="submit"]').disabled = true;
		},
		async onSubmit(body) {
			const ids = [...body.querySelectorAll('input[name="cid"]:checked')].map((x) => x.value);
			const res = await post("/api/integrations", { changeIds: ids });
			return `已创建联合集成 #${res.integration?.id}`;
		},
	});
}

export function openResolveOperationDialog(operation) {
	openModal({
		title: `核对外部操作 · ${operation.id}`,
		submitText: "提交核对结论",
		bodyHtml: `
			<p class="edit-note">${esc(operation.member)} / <code>${esc(operation.tool)}</code> · ${esc(operation.failure?.message ?? "结果未知")}</p>
			<label class="field"><span>核对结果</span><select name="outcome">
				<option value="succeeded">succeeded · 确认远端已生效（勿重提交）</option>
				<option value="not_applied">not_applied · 确认远端未执行</option>
			</select></label>
			<label class="field"><span>人工核对依据</span><textarea name="evidence" rows="3" required placeholder="填写从远端控制台/日志查到的订单号或无记录凭证"></textarea></label>
		`,
		async onSubmit(body) {
			const outcome = body.querySelector('select[name="outcome"]').value;
			const evidence = body.querySelector('textarea[name="evidence"]').value.trim();
			const res = await post(`/api/operations/${encodeURIComponent(operation.id)}/resolve`, { outcome, evidence });
			return res.message;
		},
	});
}
