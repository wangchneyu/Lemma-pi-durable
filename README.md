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

## 运行

需要 Node ≥ 22.19。项目里的 `.npmrc` 让 `@earendil-works` 这组包走官方源（国内镜像同步有延迟），其他包仍走你的全局镜像。

```bash
npm install
```

先检查三个 CLI 能否调通（每个发一句话，会产生少量费用）：

```bash
npm run check
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

会话存储在 `data/session.sqlite`。重启后历史和没跑完的任务都还在。同一个存储同一时间只能开一个终端（有进程锁保护，第二个会拒绝启动）。

### 后台网页

后台和终端共用同一个 Harness，终端里的每一步都实时同步到网页。网页**只看和控制**（中止本轮、开始新上下文），不能下发任务；配置只读展示。

| 页面 | 内容 |
|---|---|
| 总览 | 当前状态、累计派工 / 成功率 / 花费 / token、路由分配（见下）、正在执行的派工单（实时日志）、最近运行、成员状态 |
| 运行记录 | 按每次输入分组：你的输入 → 总调度的派工 → 各成员结果 → 最终回答；可以加载更早的历史 |
| 派工明细 | 每次派工一行，可按成员、状态筛选和搜索；点开看完整任务、实时输出、结果和会话信息 |
| 成员 | 每个 CLI 的可用性、实际启动命令和参数，以及派工数、成功率、平均耗时、累计花费 |
| CLI 会话 | 会话登记表：成员、目录、最近使用、派工次数，一键复制续接命令（如 `claude --resume <id>`） |
| 用量 | 总调度模型的 token 和花费；各成员的派工次数、累计耗时、累计花费 |
| 配置 | 当前生效的配置：配置文件、工作目录、存储、总调度协议 / 模型 / 密钥来源（不显示密钥）、成员参数 |

**路由分配**有两种视图：

- **流向图**（桑基图）：你 → 总调度 → Claude / Codex / Gemini → 完成 / 执行中 / 失败 / 中止。带子宽度可以按**次数、耗时、花费**切换，时间范围可选全部 / 24 小时 / 1 小时。带子上的光点一直在流，正在执行的线路更亮更快。悬停看这条线的次数、耗时、花费和占比；点击成员、结果或某条线，跳到派工明细并自动筛选。
- **实时拓扑**：节点连线图，执行中的线路有流动光点，派工、回报、回答时有数据包沿线飞过，下方列出每条线路正在处理的任务。

- 只监听 `127.0.0.1`，并校验 Host 和 Origin，其他网站无法向它发起操作。不要把它暴露到局域网。
- 端口被占用时自动往后找；`--no-web` 或配置 `"web": { "enabled": false }` 可以关掉后台。

不想花钱、只想看看界面或调试时，用演示模式（假模型 + 模拟 CLI，独立的 `data/demo.sqlite`，后台在 http://127.0.0.1:8788）：

```bash
npm run demo
```
## 配置 `pi-agent.config.json`

**总调度模型**（`orchestrator`）：总调度本身需要一个 API 模型来做拆解和汇总，CLI 成员走它们各自的登录。

| type | 说明 |
|---|---|
| `anthropic-compatible` | Anthropic Messages 协议。默认读取 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（与 Claude CLI 共用中转站），也可以设置环境变量 `PI_ORCHESTRATOR_API_KEY` 或写 `baseUrl`。 |
| `openai-compatible` | OpenAI Chat Completions 协议（DeepSeek、Ollama、各种中转站），需填 `baseUrl`。 |
| `builtin` | pi-ai 内置 provider，填 `provider`（如 `anthropic`、`openai`、`google`），读取对应的标准环境变量。 |

**成员**（`agents.<claude|codex|gemini>`）：

- `enabled`：开关
- `extraArgs`：追加的 CLI 参数（权限/沙箱模式、模型等）。默认值：Claude `--permission-mode acceptEdits`；Codex `sandbox_mode="workspace-write"`；Gemini `--approval-mode auto_edit --skip-trust -m gemini-3.5-flash-lite`
  - Gemini 的 `--skip-trust`：无头模式下 Gemini 拒绝在未信任的目录运行，这个参数只对本次调用信任当前目录。
  - Gemini 免费档的 API Key 用不了 pro 系列（额度为 0），flash 系列高峰期常返回 503 过载，所以默认用 `gemini-3.5-flash-lite`。升级付费档后可以改成 `gemini-3.1-pro-preview` 或去掉 `-m` 用 `auto`。
- `command`：手动指定启动命令；不填时会在 npm 全局目录里自动查找真实入口
- `timeoutMinutes`、`maxOutputChars`

**后台网页**（`web`）：`enabled`（默认 `true`）、`port`（默认 `8787`，演示模式用 `port + 1`；环境变量 `PI_AGENT_PORT` 可覆盖）。

`stripEnv`：启动子 CLI 前去掉的环境变量。默认去掉 `CLAUDECODE`、`CLAUDE_CODE_*`、`ANTHROPIC_*`，让各 CLI 使用自己的配置文件，而不是宿主进程注入的变量。

## 测试

```bash
npm test
```

用模拟 CLI（`scripts/fake-agent.mjs`）和 pi-ai 的 faux 模型做测试，不调用真实 API：

- `test/smoke.ts`：并行派活、汇总、会话续接、续接时回到原目录、错误目录处理
- `test/crash.ts`：成员执行到一半时强杀整个进程树，重启后续接同一会话并完成
- `test/web.ts`：以演示模式启动终端，从 stdin 下发任务，检查后台接口、Host/Origin 校验、网页不能下发任务、SSE 实时推送、派工汇总和历史分页

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/cli-runner.ts` | 启动子进程：提示词走 stdin、超时、中止时杀进程树 |
| `src/agents.ts` | 各 CLI 适配器：参数、会话续接、输出解析、进度摘要 |
| `src/tools.ts` | 把 CLI 包装成 Pi Durable 工具，以及总调度的系统提示 |
| `src/models.ts` | 总调度模型 |
| `src/app.ts` | 打开 Harness（SQLite + 工具 + 模型） |
| `src/printer.ts` | 终端实时显示进度 |
| `src/main.ts` | 终端入口（交互 / 单次 / 演示），交互模式顺带启动后台 |
| `src/admin.ts` | 后台网页服务（嵌在终端进程里）：只读接口 + 控制 + SSE + 派工汇总 |
| `src/view.ts` | 把对话条目、实时状态和工具结果转成前端用的 JSON |
| `src/demo.ts` | 演示模式：脚本化假模型 + 模拟 CLI |
| `web/` | 后台前端（原生 ES 模块，无构建步骤、无依赖）：`js/views.js` 各页面，`js/store.js` 数据同步，`js/sankey.js` 流向图，`js/routemap.js` 实时拓扑 |
| `scripts/check-agents.ts` | 实测三个 CLI 能否调通 |
| `scripts/fake-agent.mjs` | 模拟 CLI，测试和演示模式共用 |
