<!-- BRAND_START -->
<div align="center">

<img src="docs/assets/logo.webp" alt="Lemma Logo" width="112" />

<h1>Lemma</h1>

<p><strong>把复杂目标，化为可验证的每一步。</strong></p>

<img src="docs/assets/bench-badges.svg" alt="Lemma 核心动态指标徽章" />

</div>
<!-- BRAND_END -->

**Lemma（引理）是一个基于 [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)、面向 coding 场景的多 Agent 协同系统。**
它将不同能力的模型与 CLI 组织成有明确职责、独立上下文、结构化交接与独立复核机制的工程团队，完成仓库分析、并行开发、盲审返工、多分支联合集成、自动验收与人工确认合并。

执行与会话状态由 Pi Durable + SQLite 持久化；终端负责下发任务与人工决策，本地后台网页（默认 `http://127.0.0.1:8787`）同步提供实时进度、图谱、代码改动与用量观测。

## 核心创新与差异化设计

不同于把多个 Agent 塞进同一个聊天室“靠 Prompt 自觉协作”的通用框架，Lemma 针对真实 **coding 工程闭环**的痛点（编排税、上下文污染、自我吹嘘幻觉、越界改测试、提前交白卷与多分支冲突）设计了一套可物理强制执行、可断点续跑的工程机制：

| 常见多 Agent 编码痛点 | Lemma 的工程解法 | 实际收益与证据 |
|---|---|---|
| **小改也走完整编排，协调税比写代码还贵** | **自适应快慢双通路（Fast-Slow Path）**<br>总调度自带只读代码感知工具（零派工零 worktree）；简单单文件改走 `/fast` 单跳直出，预内联任务提及的目标文件并启用快路极简提示，干净 worktree 直接复用 `HEAD` | Tier 1 实测较去快路编排 **请求 -93%、耗时 -97%**（`2.0 reqs / 4.5s`），全面领先 `single`（`7.0 reqs / 35.4s`） |
| **执行者"既当运动员又当裁判"，自述掩盖边界 bug** | **剥离自述的客观盲审（Blind Review）**<br>`reviewer: { member, blind: true }` 屏蔽执行者总结，由 [task-workflow.ts](src/task-workflow.ts) 预内联客观 `git_diff` 并 `readonly: true` 直接复用原 worktree（零新建审查副本），一次往返结构化裁决返工 | 消灭虚假通过，Core 9 题 Tier 2 闭环通过率从 `0%` 升至 **67%（隐藏用例 6/6 = 100%）** |
| **靠 Prompt 约束“别改测试目录”形同虚设** | **工具层硬契约拦截（API Scope Guardrails）**<br>任务级 `scope: { allow, forbid }` 在工具执行前（`beforeTool`）物理拒绝越界 `write`/`edit`，叠加收尾硬校验与写后即时语法诊断 | 真实多模块压测连续多次实时拦截越界篡改并驱动自愈（`selfHealed`） |
| **模型推理中途偷懒提前结束、或死循环卡死** | **Pre-Flight Gate 门禁 + 心跳/死循环熔断（评测 Harness）**<br>交卷前强制校验所有子任务状态、非空 `git_diff`、联合集成落盘与本地语法检查；连续两次同参数报错立即熔断 `LOOP_DETECTED`，活跃流式推理期间心跳延展 | 实测将提前交卷（`PREMATURE_STOP`）与死循环清零，Core 9 题总隐藏用例达 **16/16（100%）** |
| **并行改完代码手动合并冲突灾难** | **多 Worktree 三方联合集成（`wait: true`）**<br>并行任务在独立 Git worktree 推进，通过 `integrate_changes(..., wait: true)` 基于 Pi Durable `sleep`/`checkpoint` 原生阻塞完成三方合流、`autonomy.checks` 联合测试与 `repair_integration` | 结合并行测试语法校验契约，Tier 3 Core 通过率从 `0%` 升至 **67%（隐藏用例 4/4 = 100%）** |
| **跑一半崩溃丢状态、或 CLI / API 混用割裂** | **Durable 持久化 + 异构 CLI/API 混编 + 人工闸门**<br>全量状态与 `lemma.delivery.v1` 结构化交接（按需分页 `read_result`）存于 Pi Durable + SQLite；支持重推理总控 + 高吞吐 Flash + 本机 CLI 混编；合并与推送由终端人类拍板 | 进程中断后 `/task inspect\|resume\|supply\|reassign` 无损续接 |

> 核心特性与架构细节亦直接配套在仓库内：内置 **13 题分层编码/故障注入/边缘防御基准套件**（`npm run bench:coding`）与 **零硬编码全自动 SVG 看板**（`npm run bench:chart`）。

## 快速开始

- **环境要求**：Node.js ≥ 22.19、Git（worktree 隔离需要）；Windows 建议使用 Windows Terminal + PowerShell 7。
- **成员准备**：支持 Claude / Codex / Gemini 本机 CLI（需提前各自登录），也支持直接配置 OpenAI / Anthropic 兼容 API 成员（见 [成员使用说明](docs/custom-agents.md)）。

```bash
git clone https://github.com/wangchneyu/Lemma-pi-durable.git pi-agent
cd pi-agent
npm install
npm start
```

> `npm start` 默认使用真实模式并同时启动本地网页（`--no-web` 可关闭，`--plain` 切换纯文本，`npm start -- "任务"` 单次运行后退出）。直接由 Node TypeScript 原生运行，无需额外构建步骤。

首次使用在终端执行 `/setup` 配置总调度模型与凭据，用 `/agent add` 管理 API 成员；可用 `npm run check`（会产生真实调用）验证各成员连通性。API 密钥经隐藏输入存入本机 `~/.lemma/credentials.json`，配置文件与网页响应仅保留引用。

## 终端速查

| 类别 | 常用命令与快捷键 |
|---|---|
| 任务与协作 | `/tasks` `/ready` `/jobs` `/jobs cancel <ID\|all>` `/workflow pause\|resume` `/task inspect\|resume\|supply\|reassign\|cancel` `/goal` |
| 代码隔离与集成 | `/changes` `/diff <ID>` `/apply [ID\|all]`（交互确认）/ `/drop <ID>` `/clean` `/integrate create\|list\|show\|rerun\|repair\|cancel` |
| 成员与规范 | `/setup` `/agents` `/agent add\|edit\|enable\|disable\|model\|key` `/tool` `/mcp` `/rules [init\|sync]` `/limits edit` |
| 会话与终端交互 | `/session new\|use\|rename` `/sessions` `/abort [all]` `/continue` `/compact` `/usage` `/web`<br>`Ctrl+K` 会话与只读子对话 · `Ctrl+L` (`/model`) 切换模型 · `Alt+C` (`/tree`) 关系树 · `Ctrl+T` (`/taskgraph`) 原生任务面板 · `Ctrl+N`/`Ctrl+O` 新建/切换会话 · `Ctrl+E` 展开输出 · `Alt+T` 思考块 |

## 本地后台网页

网页与终端共享同一套 Harness 状态（仅监听 `127.0.0.1` 并校验 Host/Origin，不可跨站控制或从网页直接派发新任务）：

- **工作台**：**总览**（桑基流向图、实时派工与执行中状态）、**项目**（四格控制台、自适应分工看板、目标与角色分工）、**任务图谱 (`#/dag`)**、**协作时间线 (`#/topology`)**、**运行记录**。
- **明细与版本管理**：**派工明细**（实时输出/详情抽屉）、**改动**（GitLens 风格多仓库提交图谱、差异审阅与受控推送管理）、**成员会话**、**用量**。
- **团队与设置**：**成员**（启停与模型切换）、**Agent 规范**（项目/用户级规则一致性扫描与只读查看）、**配置**（模型、预算与按仓库匹配的自动验收编辑器）。

## 配置概要 (`pi-agent.config.json`)

可通过环境变量 `PI_AGENT_CONFIG` 指定自定义配置文件（保留兼容原 `PI_AGENT_*` 变量与 `.pi-agent/` 规则目录）：

- **`orchestrator`**：总调度 API（`anthropic-compatible` / `openai-compatible` / `builtin`），支持 `modelId`、`modelIds`、`discoverModels`（`GET /v1/models`）与 `price`。
- **`agents`**：CLI 成员（`claude` / `codex` / `gemini`，含 `extraArgs`、`models`、`defaultModel`）及内置工具链的 API 成员（如 `deepseek`，默认受 worktree 路径锁与 `api.bash` 白名单约束）。
- **`roles` / `isolation` / `autonomy` / `budget` / `web`**：角色首选与回退链、Git worktree 快照与依赖目录联接（`linkDirs`）、按目标仓库生效的验收命令（`checks`）与最大修复次数、单轮预算上限与端口设置（默认 `8787`）。

## 效果评测

<!-- BENCH_START -->
以下图表与表格由 `npm run bench:chart`（[render-bench-charts.mjs](scripts/render-bench-charts.mjs)）**直接扫描 `data/benchmarks/` 下实测 JSON 自动渲染**。为确保评测口径严谨，主视觉仅展示**完全对齐的同口径实测对照**（Tier 1 快路对比去快路请求 **-93%**、耗时 **-97%**）；Tier 2/3 重型闭环、故障注入（Chaos）及 `Tier-Edge` 独立结果及归因详见 [分层编码评测记录](docs/benchmarks/tiered-coding-evaluation.md)。最近一次离线全链路回归（`coding-p2-offline`）共 **37 次运行**，`lemma-adaptive` 核心与 `Tier-Edge` 均全量跑通。

![Lemma Adaptive 自适应路由架构](docs/assets/bench-architecture-flow.svg)

![Tier 1 单跳快路消融对比](docs/assets/bench-tier1-fastpath.svg)

![分层架构同口径闭环演进](docs/assets/bench-p1-optimization.svg)

![全量实验臂综合效能与开销对比](docs/assets/bench-ablation-matrix.svg)

### 同口径核心对照（`lemma-adaptive` · Core 9 题口径对齐）

| 分层（严格同口径 Core） | 基线 `coding-p1-deepseek` (`deepseek-v4-pro`) | `coding-p4-complete` (`deepseek-v4-pro`) | `coding-p5-flash-complete` (`deepseek-flash`) |
|---|---:|---:|---:|
| **Tier 1 (Core 3 题)** | 3/3 (100%) · 13.1s | **3/3 (100%)** · 隐测 6/6 · 契约拦截 0 · 4.4s | **3/3 (100%)** · 隐测 6/6 · 契约拦截 0 · 4.9s |
| **Tier 2 (Core 3 题)** | 0/3 (0%) · 77.3s | **2/3 (67%)** · 隐测 4/6 · 契约拦截 0 · 186.4s | **2/3 (67%)** · 隐测 4/6 · 契约拦截 0 · 183.3s |
| **Tier 3 (Core 3 题)** | 0/3 (0%) · 101.2s | **3/3 (100%)** · 隐测 4/4 · 契约拦截 4 · 245.9s | **1/3 (33%)** · 隐测 2/4 · 契约拦截 2 · 141.5s |

### 全量实测与扩展专项明细（JSON 自动聚合，分母按作用域隔离）

| 实验臂与批次 | 任务通过率 | 隐藏用例 | 路由准确率 | 平均请求 | 平均耗时 | 总 Token | 费用 | 机制观测 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `lemma-adaptive` (基线 Core (coding-p1-deepseek)) | 3/9 (33%) | 6/16 (38%) | — | 9.9 | 63.9s | 694k | $0.2574 | 快路 3 · 契约拦截 1 |
| `single` (基线 Core (coding-p1-deepseek)) | 3/9 (33%) | 6/16 (38%) | — | 5.2 | 43.4s | 195k | $0.1134 | — |
| `ablation-no-fastpath` (基线 Core (coding-p1-deepseek)) | 1/3 (33%) | 2/6 (33%) | — | 27.0 | 148.4s | 753k | $0.2920 | — |
| `ablation-no-blind` (基线 Core (coding-p1-deepseek)) | 2/3 (67%) | 4/6 (67%) | — | 16.7 | 80.1s | 363k | $0.0980 | — |
| `ablation-no-scope` (基线 Core (coding-p1-deepseek)) | 0/3 (0%) | 0/4 (0%) | — | 14.0 | 81.4s | 360k | $0.1698 | 契约拦截 1 |
| `lemma-adaptive [Core 同口径]` (deepseek-v4-pro 主控 (coding-p4-complete)) | 8/9 (89%) | 14/16 (88%) | 8/9 (89%) | 19.6 | 145.6s | 1.82M | $0.8901 | 快路 3 · 契约拦截 4 · 自愈 4 · 集成 3 · 门禁 1 |
| `lemma-adaptive [Chaos 自愈]` (故障注入加测 (coding-p4-complete)) | 1/2 (50%) | 3/4 (75%) | 2/2 (100%) | 24.5 | 157.9s | 450k | $0.2342 | 契约拦截 2 · 自愈 1 · 集成 1 |
| `lemma-adaptive [Tier-Edge]` (独立边缘防御 (coding-p4-complete)) | 2/2 (100%) | 4/4 (100%) | 2/2 (100%) | 12.0 | 73.8s | 230k | $0.1144 | 自愈 2 |
| `lemma-adaptive [Flash 全栈 Core]` (deepseek-flash 经济高速 (coding-p5-flash-complete)) | 6/9 (67%) | 12/16 (75%) | 8/9 (89%) | 15.6 | 109.9s | 1.75M | $0.2819 | 快路 3 · 契约拦截 2 · 自愈 2 · 集成 3 · 门禁 1 |
<!-- BENCH_END -->

## 测试与评测

```bash
npm run typecheck          # TypeScript 类型检查
npm test                   # 全量离线集成测试（faux 模型 + scripts/fake-agent.mjs，不消耗真实 API）
npm run bench:coding       # 分层编码基准与消融（加 -- --real 使用真实模型）
```

常用专项测试与基准脚本：`test:collaboration`（集成/盲审/契约/快慢路径/基准套件）、`test:conversations`（多会话切换/Git 工作台/网页控制）、`test:terminal`（终端组件与交互）、`bench:context`（[上下文裁剪初始记录](docs/benchmarks/initial-context-ablation.md)）与 `bench:collaboration`。

## 代码结构

- `src/main.ts`、`src/app.ts`：CLI 入口、Pi Durable Harness 初始化、进程锁与后台联动。
- `src/terminal.ts`、`src/terminal-state.ts`、`src/native-*.ts`、`src/printer.ts`：终端交互、Pi Coding Agent 官方组件复用与流式状态。
- `src/tools.ts`、`src/dispatch.ts`、`src/agents.ts`、`src/cli-runner.ts`、`src/api-member.ts`、`src/lead.ts`：派工引擎、CLI/API 成员接入、只读代码工具（`src/code-tools.ts`）与子调度。
- `src/board.ts`、`src/task-*.ts`、`src/scope.ts`、`src/jobs.ts`、`src/repair.ts`、`src/learning.ts`：分工表、依赖就绪、自动推进、独立复核、受阻恢复与有限自动修复。
- `src/git.ts`、`src/changes.ts`、`src/change-ops.ts`、`src/integrations.ts`、`src/integration-git.ts`、`src/git-workbench.ts`：worktree 隔离、改动管理、多分支联合集成、推送审批与终端合并交互。
- `src/admin.ts`、`src/view.ts`、`web/`：本地 HTTP/SSE 服务与无构建 ES Module 后台界面（总览、项目、任务图谱、协作时间线、改动工作台等）。
