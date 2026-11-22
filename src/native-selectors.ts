// UI-only projections. Never create a coding-agent SessionManager or AgentSession.
import { SessionSelectorComponent, TreeSelectorComponent, type SessionInfo, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { cleanText, safeNativeComponent } from "./native-terminal-components.ts";

export interface ConversationChoice {
	id: string; title: string; detail?: string; current?: boolean;
	parentId?: string; createdAt?: number; lastAt?: number; messageCount?: number; workdir?: string; searchText?: string;
}

export function nativeSessions(items: ConversationChoice[], select: (id: string) => void, cancel: () => void, render: () => void): SessionSelectorComponent {
	const project = (): SessionInfo[] => items.map((item) => ({
		path: item.id, id: item.id, cwd: cleanText(item.workdir ?? ""), name: cleanText(item.title),
		created: new Date(item.createdAt ?? item.lastAt ?? 0), modified: new Date(item.lastAt ?? item.createdAt ?? 0), messageCount: item.messageCount ?? 0,
		firstMessage: cleanText(`${item.id} ${item.detail ?? ""}`), allMessagesText: cleanText(`${item.id} ${item.detail ?? ""} ${item.searchText ?? ""}`),
		parentSessionPath: item.parentId,
	}));
	// Upstream only needs matches() here; use the application's existing key map.
	const keybindings = getKeybindings() as NonNullable<ConstructorParameters<typeof SessionSelectorComponent>[6]>["keybindings"];
	const selector = safeNativeComponent(new SessionSelectorComponent(async () => project(), async () => project(), select, cancel, cancel, render, { keybindings, showRenameHint: false }, items.find((item) => item.current)?.id), true);
	// The upstream default deletes JSONL files. Lemma selectors are navigation-only.
	selector.getSessionList().onDeleteSession = undefined;
	return selector;
}

export function conversationTree(items: ConversationChoice[]): SessionTreeNode[] {
	const parents = new Map(items.map((item) => [item.id, item.parentId]));
	const nodes = new Map(items.map((item) => [item.id, {
		entry: { type: "session_info" as const, id: item.id, parentId: item.parentId ?? null, timestamp: new Date(item.createdAt ?? 0).toISOString(), name: cleanText(`${item.title} · ${item.id}`) },
		label: cleanText(item.detail ?? ""), children: [],
	} as SessionTreeNode]));
	const roots: SessionTreeNode[] = [];
	for (const item of items) {
		const node = nodes.get(item.id)!;
		const seen = new Set([item.id]);
		let parent = item.parentId;
		while (parent && !seen.has(parent)) { seen.add(parent); parent = parents.get(parent); }
		if (item.parentId && nodes.has(item.parentId) && !parent) nodes.get(item.parentId)!.children.push(node);
		else { node.entry.parentId = null; roots.push(node); }
	}
	return roots;
}

export function nativeConversationTree(items: ConversationChoice[], height: number, select: (id: string) => void, cancel: () => void): TreeSelectorComponent {
	return safeNativeComponent(new TreeSelectorComponent(conversationTree(items), items.find((item) => item.current)?.id ?? null, height, select, cancel, undefined, undefined, "all"), true);
}
