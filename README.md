# pi-agent：本机多 agent 协作

基于 [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)（`@earendil-works/pi-durable`，实验性）搭建。
一个"总调度"agent 负责拆解任务、派活、汇总；本机已登录的 AI CLI 作为干活的成员：

```
你 ──► 总调度（Pi Durable，SQLite 持久化）
          ├─ ask_claude  → claude -p   （Claude Code）
          ├─ ask_codex   → codex exec  （Codex / ChatGPT）
          └─ ask_gemini  → gemini      （Gemini CLI）
```

- 每个成员都是完整的编码 agent，能在工作目录里读写文件、执行命令。
- 同一轮里互不依赖的子任务会**并行**执行。
- 成员返回 `session_id`，总调度之后可以在同一个上下文里继续追问或修改。CLI 的会话和启动目录绑定，续接时会自动回到会话当初的目录（会话登记表随对话一起持久化）。
- **崩溃可恢复**：进程在成员干活时被杀，重启后会自动用 `--resume` 续接被中断的那个 CLI 会话，而不是从头重跑。
- **工作区隔离**：工作目录是 git 仓库时，每次新派工都在独立的 git worktree 里干活，改动提交到独立分支，**等你在终端确认后才合并到主目录**。并行的成员不会互相覆盖文件。
- **总调度选模型**：每位成员可以配一份模型清单（经济 / 标准 / 强力），总调度按任务难度挑；清单外的模型会被拒绝。
- **花费上限**：一次运行（你的一次输入）里成员的花费超过上限后，后续派工被拒绝，总调度直接汇报已有结果。

## 运行

需要 Node ≥ 22.19。项目里的 `.npmrc` 让 `@earendil-works` 这组包走官方源（国内镜像同步有延迟），其他包仍走你的全局镜像。

```bash
npm install
```

先检查三个 CLI 能否调通（每个发一句话，会产生少量费用）：

```bash
npm run check
```

`npm run check` 用各成员的默认模型；想确认配置清单里的每个模型在你的中转站上都能用：

```bash
npm run check -- --models
```

```bash
npm start
```

终端是主体：任务只在终端里下发。启动交互模式时，同一个进程会顺带打开**后台网页** http://127.0.0.1:8787（地址会印在终端横幅里，也可以输入 `/web` 查看）。

单次提问（答完退出，不开后台）：

```bash
npm start -- "让 Codex 实现 X，再让 Claude 审查"
```

### 终端命令

`/agents` 查看成员、`/web` 后台地址、`/usage` 查看用量、`/abort` 中止本轮、`/new` 开始新的上下文、`/exit` 退出；Ctrl+C 中止正在进行的一轮。

### 共同目标和分工表

像一个真人团队那样协作：大家对最终目标有共同的理解，有一张分工表记录谁负责什么、做到哪了。

- **`.pi-agent/GOAL.md`：最终目标**。写清楚要做成什么、验收标准、约束和不做什么。**以你写的为准**；还没有这个文件时，你把项目目标告诉总调度，它会起草一份并标明"待你确认"，已经存在的不会被它改。
- **`.pi-agent/ASSIGN.md`：分工表，由 AI 维护**。总调度把项目级任务拆成多项（`plan_tasks`），每项写明角色、负责成员、依赖和验收标准；派工时带上任务编号，成员完成后任务变成"待验收"，总调度对照验收标准核对，再标完成或打回（`update_task`）。任务数据存在 Pi Durable 里（和派工在同一个事务里，崩溃也不会错乱），每次变化后写出 ASSIGN.md，人和任何 AI 都能读。**不要手动编辑**：手动改过的会被另存为 `ASSIGN.edited-*.md`，不会丢，也不会被当成数据导回去。
- **每次派工，成员都会拿到**：项目最终目标、自己负责的任务和验收标准、前置任务的状态，以及团队分工全貌（知道自己在全局里的位置）。
- **角色**（配置里的 `roles`）：总调度按角色分工，比如架构用 Claude（opus）、设计用 Codex（GPT）、编码用 Gemini（不可用时由 Codex 顶上）、审查用 Claude（sonnet）。

终端里 `/goal` 看最终目标、`/tasks` 看分工表；后台的「项目」页显示目标、任务看板和角色分工。

运行中的交互：

| 操作 | 作用 |
|---|---|
| 总调度正忙时直接输入 | **插话**：这句话插进当前这一轮，总调度在这一轮工具做完后、下一次思考前就能看到（比如"用 pnpm，别用 npm"）。后台的运行记录里标成「你 · 插话」 |
| `/queue <任务>` | **排队**：等这一轮结束后，作为新的一轮处理 |
| `/continue` | **续跑**：一轮因为出错、中断或中止没有完成时，不用重新输入，在原来的上下文里接着跑 |
| `/compact [说明]` | **压缩**：把较早的对话总结成摘要，总调度之后只看摘要和最近的内容（原始记录仍在存储里）。上下文接近上限时也会自动压缩 |

还没放进对话的插话和排队会显示在后台的顶栏和总览「正在执行」里。

改动（工作区隔离）：

| 命令 | 作用 |
|---|---|
| `/changes` | 列出待合并的改动（`/changes all` 列出全部） |
| `/diff <编号>` | 改了哪些文件、增删多少行；完整差异在后台「改动」页 |
| `/apply <编号>` | 把改动应用到主目录的工作区（**不提交**，你检查后自己 commit）；冲突时不动你的文件。`/apply all` 处理全部 |
| `/drop <编号>` | 丢弃改动：删掉 worktree 和分支 |
| `/clean` | 清理已合并 / 没改动的 worktree（之后不能再续接它们的会话） |

启动时如果有待合并的改动，终端会先列出来。

会话存储在 `data/session.sqlite`。重启后历史和没跑完的任务都还在。同一个存储同一时间只能开一个终端（有进程锁保护，第二个会拒绝启动）。

### 后台网页

后台和终端共用同一个 Harness，终端里的每一步都实时同步到网页。网页**只看和控制**（中止本轮、开始新上下文），不能下发任务；配置只读展示。

| 页面 | 内容 |
|---|---|
| 总览 | 当前状态、累计派工 / 成功率 / 花费 / token、路由分配（见下）、正在执行的派工单（实时日志）、最近运行、成员状态 |
| 项目 | 最终目标（GOAL.md）、分工表看板（待办 / 进行中 / 待验收 / 受阻 / 完成，每项有角色、负责成员、依赖、验收标准、改动）、角色分工 |
| 运行记录 | 按每次输入分组：你的输入 → 总调度的派工 → 各成员结果 → 最终回答；可以加载更早的历史 |
| 派工明细 | 每次派工一行（含模型、改动编号），可按成员、状态筛选和搜索；点开看完整任务、实时输出、结果、模型、花费和改动 |
| 改动 | 每个隔离派工的改动：状态（进行中 / 待合并 / 有冲突 / 已合并 / 已丢弃）、改了哪些文件、着色的差异，以及要在终端执行的命令 |
| 成员 | 每个 CLI 的可用性、模型清单（档位、默认、各用了多少次和花了多少）、实际启动命令和参数，以及派工数、成功率、平均耗时、累计花费 |
| CLI 会话 | 会话登记表：成员、目录、最近使用、派工次数，一键复制续接命令（如 `claude --resume <id>`） |
| 用量 | 总调度模型的 token 和花费；派工活动图；各成员的派工次数、累计耗时、累计花费；按模型对比花费和成功率 |
| 配置 | 当前生效的配置：配置文件、工作目录、存储、总调度协议 / 模型 / 密钥来源（不显示密钥）、成员参数、工作区隔离和花费上限 |

**路由分配**是一张桑基流向图：总调度 → Claude / Codex / Gemini → 完成 / 执行中 / 失败 / 中止。带子宽度可以按**次数、耗时、花费**切换，时间范围可选全部 / 24 小时 / 1 小时；正在执行的线路上有流光。悬停看这条线的次数、平均耗时、花费和占比；点击成员、结果或某条线，跳到派工明细并自动筛选。

- 只监听 `127.0.0.1`，并校验 Host 和 Origin，其他网站无法向它发起操作。不要把它暴露到局域网。
- 端口被占用时自动往后找；`--no-web` 或配置 `"web": { "enabled": false }` 可以关掉后台。

不想花钱、只想看看界面或调试时，用演示模式（假模型 + 模拟 CLI，独立的 `data/demo.sqlite`，工作目录是沙盒仓库 `data/demo-workspace`，后台在 http://127.0.0.1:8788）：

```bash
npm run demo
```

演示模式会真的在沙盒仓库的 worktree 里写文件。沙盒里带一份示例 GOAL.md；每个新任务都会先拆成任务写进分工表，按角色派工，完成后逐项验收。轮换几种剧本：
- Claude + Codex 并行；
- Codex 实现完，再让 Claude 用强力模型**基于它的改动**审查（`based_on`）；
- 三位成员并行，Claude 用经济档写文档，Codex 模拟一次失败；
- 输入里带"继续 / 接着"：续接 Claude 上一次的会话，回到同一个 worktree；
- 提问（"……什么模型？"）：总调度不派工，直接回答。

可以在演示终端里试 `/changes`、`/diff`、`/apply`、`/drop`，改动会合并到沙盒仓库，不会碰你的真实项目。

## 配置 `pi-agent.config.json`

**总调度模型**（`orchestrator`）：总调度本身需要一个 API 模型来做拆解和汇总，CLI 成员走它们各自的登录。

| type | 说明 |
|---|---|
| `anthropic-compatible` | Anthropic Messages 协议。默认读取 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（与 Claude CLI 共用中转站），也可以设置环境变量 `PI_ORCHESTRATOR_API_KEY` 或写 `baseUrl`。 |
| `openai-compatible` | OpenAI Chat Completions 协议（DeepSeek、Ollama、各种中转站），需填 `baseUrl`。 |
| `builtin` | pi-ai 内置 provider，填 `provider`（如 `anthropic`、`openai`、`google`），读取对应的标准环境变量。 |

**成员**（`agents.<claude|codex|gemini>`）：

- `enabled`：开关
- `extraArgs`：追加的 CLI 参数（权限 / 沙箱模式等，**不要在这里写模型**）。默认值：Claude `--permission-mode acceptEdits --allowedTools "Bash(npm test:*)" "Bash(npm run test:*)" "Bash(node --test:*)"`；Codex `sandbox_mode="workspace-write"`；Gemini `--approval-mode auto_edit --skip-trust`
  - Claude 的 `acceptEdits` 只放行改文件，其他命令要审批，无头模式下会被直接拒绝。`--allowedTools` 单独放开了跑测试的命令，`git push`、带 `;` 拼接的命令等仍然会被拒绝。被拒绝的操作会附在结果末尾告诉总调度。需要放开别的命令时照这个格式加，比如 `"Bash(pytest:*)"`。
  - Gemini 的 `--skip-trust`：无头模式下 Gemini 拒绝在未信任的目录运行，这个参数只对本次调用信任当前目录。
- `models`：总调度可以选的模型清单，每项 `{ "id", "tier": "economy" | "standard" | "premium", "note", "price" }`。`note` 写给总调度看（适合什么活）；`price` 是每百万 tokens 的美元单价 `{ "input", "output", "cacheRead" }`，CLI 不自报花费时（Codex、Gemini）用它估算。
- `defaultModel`：总调度没指定时用的模型；不填就用 CLI 自己的默认。旧配置里 `extraArgs` 写死的 `-m` 会自动当成默认模型。
  - 当前配置：Claude 默认 `claude-sonnet-5-5`，可选 haiku（经济）/ opus（强力）；Codex 只列了你本机的 `gpt-6.1-sol`；Gemini 免费档只有 `gemini-3.5-flash-lite` 可用（pro 额度为 0，flash 常 503）。想让总调度有更便宜的选择，把中转站支持的模型加进 `models`。
- `command`：手动指定启动命令；不填时会在 npm 全局目录里自动查找真实入口
- `timeoutMinutes`、`maxOutputChars`

**工作区隔离**（`isolation`）：`enabled`（默认 `true`，工作目录是 git 仓库时生效）；`linkDirs`（默认 `node_modules`、`.venv`、`venv`）：主目录里被 git 忽略的这些目录会用目录联接挂进 worktree，成员能直接跑测试。worktree 放在会话存储旁边的 `worktrees/` 里，不在你的仓库里。开工时会给当前工作区拍快照（`git stash create`，包含未提交的改动，但不含未跟踪的新文件）。

**角色**（`roles`）：数组，每项 `{ "name", "agent", "model", "fallback", "note" }`。`agent` 是首选成员，`fallback` 是首选不可用时依次尝试的成员，`model` 是这个角色用的模型（不填用成员默认）。默认：架构 → claude（`claude-opus-5-5`）、设计 → codex、编码 → gemini（备选 codex）、审查 → claude（`claude-sonnet-5-5`）。

**花费上限**（`budget`）：`perRunUsd`（默认 `3`，`null` 不限）。只统计成员的花费：Claude 自报，Codex / Gemini 按 `models[].price` 估算，没配单价的计为 0。

**总调度单价**（`orchestrator.price`）：中转站模型没有内置定价，配上 `{ "input", "output" }`（每百万 tokens）才能在后台看到总调度花了多少。

**后台网页**（`web`）：`enabled`（默认 `true`）、`port`（默认 `8787`，演示模式用 `port + 1`；环境变量 `PI_AGENT_PORT` 可覆盖）。

`stripEnv`：启动子 CLI 前去掉的环境变量。默认去掉 `CLAUDECODE`、`CLAUDE_CODE_*`、`ANTHROPIC_*`，让各 CLI 使用自己的配置文件，而不是宿主进程注入的变量。

## 测试

```bash
npm test
```

用模拟 CLI（`scripts/fake-agent.mjs`）和 pi-ai 的 faux 模型做测试，不调用真实 API：

- `test/smoke.ts`：并行派活、汇总、会话续接、续接时回到原目录、错误目录处理
- `test/crash.ts`：成员执行到一半时强杀整个进程树，重启后续接同一会话并完成
- `test/board.ts`：拆任务 → 带目标和任务上下文派工 → 验收；ASSIGN.md 的内容、手动修改被另存；已有的 GOAL.md 不被总调度覆盖
- `test/steer.ts`：插话在同一次运行里被总调度看到、排队的任务在这一轮之后处理、中止后 `continue` 续跑、手动压缩
- `test/isolation.ts`：临时 git 仓库里走完整流程：模型白名单、在 worktree 里干活、快照包含未提交改动、依赖目录挂载、`based_on`、估算花费、超预算拦截、`/apply` 不冲掉主目录的未提交改动、`/drop` 删除分支
- `test/web.ts`：以演示模式启动终端，从 stdin 下发任务，检查后台接口、Host/Origin 校验、网页不能下发任务、SSE 实时推送、派工汇总和历史分页

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/cli-runner.ts` | 启动子进程：提示词走 stdin、超时、中止时杀进程树 |
| `src/agents.ts` | 各 CLI 适配器：参数、会话续接、输出解析、进度摘要 |
| `src/tools.ts` | 把 CLI 包装成 Pi Durable 工具（选模型、预算、隔离），以及总调度的系统提示 |
| `src/board.ts` | 共同目标（GOAL.md）和分工表：任务数据、写出 ASSIGN.md、给总调度和成员的上下文 |
| `src/git.ts` | 隔离用到的 git 操作：快照、worktree、提交、差异、合并回主目录 |
| `src/changes.ts` | 改动记录（存成会话存储旁边的 JSON 文件） |
| `src/change-ops.ts` | 终端里的合并 / 丢弃 / 清理 |
| `src/models.ts` | 总调度模型 |
| `src/app.ts` | 打开 Harness（SQLite + 工具 + 模型） |
| `src/printer.ts` | 终端实时显示进度 |
| `src/main.ts` | 终端入口（交互 / 单次 / 演示），交互模式顺带启动后台 |
| `src/admin.ts` | 后台网页服务（嵌在终端进程里）：只读接口 + 控制 + SSE + 派工汇总 |
| `src/view.ts` | 把对话条目、实时状态和工具结果转成前端用的 JSON |
| `src/demo.ts` | 演示模式：脚本化假模型 + 模拟 CLI + 沙盒仓库 |
| `web/` | 后台前端（原生 ES 模块，无构建步骤、无依赖）：`js/views.js` 各页面，`js/store.js` 数据同步，`js/sankey.js` 流向图 |
| `scripts/check-agents.ts` | 实测三个 CLI 能否调通 |
| `scripts/fake-agent.mjs` | 模拟 CLI，测试和演示模式共用 |
