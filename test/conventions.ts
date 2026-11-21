// Agent 规范文件：扫描归类、一致性检查、打码、共同规则同步。用临时项目 + 临时"用户目录"，不碰真实的 ~。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRules, readConvention, scanConventions, syncRules } from "../src/conventions.ts";
import { check } from "./helpers.ts";

const project = mkdtempSync(join(tmpdir(), "pi-agent-conv-project-"));
const home = mkdtempSync(join(tmpdir(), "pi-agent-conv-home-"));
const put = (root: string, rel: string, text: string) => {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), text);
};
put(home, ".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-abcdefghijklmnopqrstuvwxyz123456", ANTHROPIC_BASE_URL: "https://relay.example" }, model: "x" }, null, 2));
put(home, ".claude/CLAUDE.md", "");
put(home, ".claude/skills/review/SKILL.md", "---\nname: code-review\ndescription: 审查改动\n---\n正文");
put(home, ".codex/AGENTS.md", "# 全局\n用 pnpm install 装依赖\n");
put(home, ".codex/config.toml", 'model = "gpt-6.1-sol"\nexperimental_bearer_token = "abcdef1234567890"\nenv_key = "OPENAI_API_KEY"\n');
put(project, "CLAUDE.md", "# 项目\n\n用 npm install 装依赖。\n\n手写的说明，同步时要保留。\n");
put(project, ".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: 严格审查\n---\n");

let scan = scanConventions(project, home);
check(scan.members.claude.instructions.some((f) => f.id === "project:CLAUDE.md") && scan.members.claude.instructions.some((f) => f.id === "user:.claude/CLAUDE.md"), "Claude 的说明：项目 CLAUDE.md + 用户 ~/.claude/CLAUDE.md");
check(scan.members.codex.instructions.some((f) => f.id === "user:.codex/AGENTS.md"), "Codex 的说明：用户 ~/.codex/AGENTS.md");
check(scan.members.claude.subagents === 1 && scan.members.claude.skills === 1, "识别出 Claude 的子 agent 和技能");
check(scan.files.find((f) => f.kind === "skill")?.name === "code-review", "技能名取自 frontmatter");
const titles = scan.checks.map((c) => c.title).join("\n");
check(/Codex 没有项目级说明/.test(titles) && /Gemini 没有项目级说明/.test(titles) && !/Claude 没有项目级说明/.test(titles), "检查出缺少项目说明的成员");
check(/包管理器不一致：npm \/ pnpm|包管理器不一致：pnpm \/ npm/.test(titles), "检查出说明文件之间的矛盾（npm / pnpm）");
check(/有空的说明文件/.test(titles) && /明文密钥/.test(titles) && /还没有共同规则/.test(titles), "检查出空文件、明文密钥、缺共同规则");

const settings = readConvention(scan, "user:.claude/settings.json")!;
check(!settings.text.includes("sk-abcdefghijklmnop") && settings.text.includes("••••") && settings.text.includes("relay.example"), "设置文件里的密钥被打码，其他内容照常显示");
const toml = readConvention(scan, "user:.codex/config.toml")!;
check(!toml.text.includes("abcdef1234567890") && toml.text.includes('env_key = "OPENAI_API_KEY"'), "TOML 里的密钥被打码，环境变量名照常显示");
check(readConvention(scan, "project:../../etc/passwd") === undefined, "只能按扫描结果的编号读文件，不能读任意路径");

// 共同规则
check(syncRules(project).ok === false, "没有 RULES.md 时不同步");
check(initRules(project).ok && initRules(project).ok === false, "/rules init 生成模板，已存在时不覆盖");
const first = syncRules(project);
const actions = Object.fromEntries(first.results.map((r) => [r.file, r.action]));
check(actions["CLAUDE.md"] === "updated" && actions["AGENTS.md"] === "created" && actions["GEMINI.md"] === "created", "同步：更新 CLAUDE.md，新建 AGENTS.md 和 GEMINI.md");
const claude = readFileSync(join(project, "CLAUDE.md"), "utf8");
check(claude.includes("手写的说明，同步时要保留") && claude.includes("<!-- pi-agent:rules hash=") && claude.includes("## 项目协作"), "同步只加规则段落，原有内容保留");
scan = scanConventions(project, home);
check(scan.files.filter((f) => ["CLAUDE.md", "AGENTS.md", "GEMINI.md"].includes(f.rel)).every((f) => f.rules === "synced"), "三份说明文件都显示规则已同步");
check(syncRules(project).results.every((r) => r.action === "unchanged"), "规则没变时再同步不改文件");

writeFileSync(join(project, ".pi-agent", "RULES.md"), `${readFileSync(join(project, ".pi-agent", "RULES.md"), "utf8")}\n- 新增一条规则\n`);
scan = scanConventions(project, home);
check(scan.files.filter((f) => ["CLAUDE.md", "AGENTS.md", "GEMINI.md"].includes(f.rel)).every((f) => f.rules === "stale") && scan.checks.some((c) => c.title.includes("没有同步到所有成员")), "RULES.md 改了之后显示过期");
syncRules(project);
const claude2 = readFileSync(join(project, "CLAUDE.md"), "utf8");
check(claude2.includes("新增一条规则") && claude2.split("<!-- pi-agent:rules hash=").length === 2 && claude2.includes("手写的说明"), "再次同步替换规则段落，不重复、不丢原内容");

console.log("\nAgent 规范测试通过 ✅");
