import { refreshState, subscribe } from "./store.js";
import { $, esc, getJson, post, toast } from "./util.js";

let conversations = [];
let active = "";
let loading = false;
let changing = false;
let mode = "create";
let origin = "";
let refreshTimer;
const dialog = $("#conversationDialog");
const list = $("#conversationList");

function render() {
	const query = $("#conversationSearch").value.trim().toLowerCase();
	const rows = conversations.filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(query));
	list.innerHTML = rows.map((c) => `<button type="button" class="conversation-item" data-conversation="${esc(c.id)}" aria-current="${c.id === active}" title="${esc(c.workdir)}" ${changing ? "disabled" : ""}><strong>${esc(c.title)}</strong><small>${esc(c.id)}</small><small class="${c.busy || c.runningJobs ? "conversation-running" : ""}">${c.id === active ? "当前 · " : ""}${c.busy ? "总控运行中" : c.opened ? "已打开" : "历史已保存"}${c.runningJobs ? ` · 后台 ${c.runningJobs}` : ""}</small></button>`).join("") || '<p class="muted">没有匹配的对话</p>';
	$("#newConversationBtn").disabled = changing || !active;
	$("#sideNewConversationBtn").disabled = changing || !active;
	$("#renameConversationBtn").disabled = changing || !active;
}

async function refresh() {
	if (loading || changing) return;
	loading = true;
	try {
		const data = await getJson("/api/conversations");
		conversations = data.conversations;
		active = data.current;
		render();
	} catch { /* 终端切换期间等 SSE 重连，不清除已有历史列表。 */ }
	finally { loading = false; }
}

function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }

function open(modeName) {
	if (changing || !active) return;
	mode = modeName; origin = active;
	const rename = mode === "rename";
	$("#conversationDialogTitle").textContent = rename ? "重命名对话" : "新建独立对话";
	$("#conversationDialogHint").textContent = rename ? "只修改名称，对话 ID、聊天记录和所有后台数据保持不变。" : "旧对话及对应的任务、派工、用量和改动完整保留。旧任务继续运行，新对话从空白上下文开始。";
	$("#conversationTitle").value = rename ? conversations.find((c) => c.id === active)?.title ?? "" : "";
	$("#saveConversationBtn").textContent = rename ? "保存名称" : "创建并切换";
	$("#saveConversationBtn").disabled = false;
	$("#conversationError").hidden = true;
	dialog.showModal();
	$("#conversationTitle").focus();
}

async function awaitSelection(id) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch("/api/state", { cache: "no-store" });
			if (response.ok && (await response.json()).conversation?.id === id) { location.reload(); return; }
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("切换未完成。新旧对话均已保留，请刷新查看列表后重试。");
}

async function change(path, body, expected) {
	changing = true; render();
	$("#conversationSwitching").hidden = false;
	try {
		const result = await post(path, { ...body, expectedSession: expected });
		dialog.close();
		await awaitSelection(result.id);
	} catch (error) {
		changing = false; $("#conversationSwitching").hidden = true; render();
		throw error;
	}
}

$("#newConversationBtn").addEventListener("click", () => open("create"));
$("#sideNewConversationBtn").addEventListener("click", () => open("create"));
$("#renameConversationBtn").addEventListener("click", () => open("rename"));
$("#cancelConversationBtn").addEventListener("click", () => dialog.close());
$("#conversationSearch").addEventListener("input", render);
list.addEventListener("click", (event) => {
	const button = event.target.closest("[data-conversation]");
	if (!button || changing || button.dataset.conversation === active) return;
	void change(`/api/conversations/${encodeURIComponent(button.dataset.conversation)}/select`, {}, active).catch((error) => toast(error.message));
});
$("#conversationForm").addEventListener("submit", async (event) => {
	event.preventDefault();
	if (changing) return;
	$("#saveConversationBtn").disabled = true;
	try {
		const title = $("#conversationTitle").value.trim();
		if (mode === "rename") {
			await post(`/api/conversations/${encodeURIComponent(origin)}/title`, { title, expectedSession: origin });
			dialog.close(); await refresh(); refreshState(); toast("名称已保存，历史数据保持不变");
		} else await change("/api/conversations", { title }, origin);
	} catch (error) {
		$("#conversationError").textContent = error.message; $("#conversationError").hidden = false;
		if (!dialog.open) toast(error.message);
	} finally { $("#saveConversationBtn").disabled = false; }
});
subscribe((kind) => {
	if (kind === "snapshot" || kind === "state" || kind === "jobs") scheduleRefresh();
});
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
void refresh();
