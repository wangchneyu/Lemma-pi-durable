// 任务级路径边界契约（Task Scope Guard）：
// 支持契约先行（Contract-First）与实现/测试分离（Adversarial Test Split）。
// 在 API 成员 write/edit 工具调用前实时拦截，并在 CLI/API 派工收尾及任务完成验收时硬性核对改动文件列表。
import { isAbsolute, posix } from "node:path";

export type TaskScope = {
	/** 仅允许修改的相对路径前缀、文件或通配模式（如 ["src/parser/", "src/index.ts"]） */
	allow?: string[];
	/** 禁止修改的相对路径前缀、文件或通配模式（如 ["test/", "src/types.ts"]） */
	forbid?: string[];
};

export function normalizeScopePath(raw: string): string {
	return raw
		.trim()
		.replace(/\\/g, "/")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^\/+/, "");
}

export function validateTaskScope(scope: TaskScope | undefined): void {
	if (!scope) return;
	for (const [key, list] of [["allow", scope.allow], ["forbid", scope.forbid]] as const) {
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.length === 0 || list.length > 16) {
			throw new Error(`任务 scope.${key} 需要 1–16 条相对路径规则。`);
		}
		for (const item of list) {
			if (typeof item !== "string" || !item.trim() || item.length > 200) {
				throw new Error(`任务 scope.${key} 包含无效路径规则。`);
			}
			const raw = item.trim();
			if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("~") || /(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
				throw new Error(`任务 scope.${key} 只能使用工作目录内的相对路径，不能包含绝对路径或 ".."：${raw}`);
			}
		}
	}
}

function globToRegExp(pattern: string): RegExp {
	let out = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	out += "$";
	return new RegExp(out, "i");
}

export function matchesScopeRule(relPath: string, rawRule: string): boolean {
	const target = posix.normalize(normalizeScopePath(relPath)).toLowerCase();
	const rule = normalizeScopePath(rawRule).toLowerCase();
	if (!target || target === "." || !rule) return false;
	if (rule.includes("*") || rule.includes("?")) {
		return globToRegExp(rule).test(target);
	}
	const cleanRule = rule.replace(/\/+$/, "");
	if (!cleanRule) return true;
	if (rule.endsWith("/")) {
		return target === cleanRule || target.startsWith(`${cleanRule}/`);
	}
	return target === cleanRule || target.startsWith(`${cleanRule}/`);
}

export function scopeViolation(relPath: string, scope: TaskScope | undefined): string | undefined {
	if (!scope) return undefined;
	const norm = normalizeScopePath(relPath);
	if (!norm || norm === ".") return undefined;
	if (scope.forbid?.length) {
		const hit = scope.forbid.find((rule) => matchesScopeRule(norm, rule));
		if (hit) {
			return `路径 ${norm} 命中本任务禁止修改范围（scope.forbid: ${hit}）。请严格在任务职责边界内修改，不要触碰受保护的契约或测试文件。`;
		}
	}
	if (scope.allow?.length) {
		const ok = scope.allow.some((rule) => matchesScopeRule(norm, rule));
		if (!ok) {
			return `路径 ${norm} 超出本任务允许修改范围（scope.allow: ${scope.allow.join("、")}）。请仅修改任务授权范围内的文件。`;
		}
	}
	return undefined;
}

export function checkFilesScope(files: { path: string }[], scope: TaskScope | undefined): string[] {
	if (!scope || (!scope.allow?.length && !scope.forbid?.length)) return [];
	const violations: string[] = [];
	for (const file of files) {
		const violation = scopeViolation(file.path, scope);
		if (violation) violations.push(`${file.path}（${violation}）`);
	}
	return violations;
}

export function formatScopeSummary(scope: TaskScope | undefined): string {
	if (!scope || (!scope.allow?.length && !scope.forbid?.length)) return "";
	const parts: string[] = [];
	if (scope.allow?.length) parts.push(`允许修改：${scope.allow.join("、")}`);
	if (scope.forbid?.length) parts.push(`禁止修改：${scope.forbid.join("、")}`);
	return parts.join("；");
}
