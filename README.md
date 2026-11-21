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

```bash
npm start -- "让 Codex 实现 X，再让 Claude 审查"
```

### 网页界面

```bash
npm run web
```

打开 http://127.0.0.1:8787 。界面上能看到：
- 对话时间线：每次派活显示为一张派工单，带实时滚动的日志和计时
- 并行执行的多个成员
- 总调度的流式回答
- 侧栏的成员状态、CLI 会话（点击复制 ID）和用量
- 路由分配图（顶栏「路由图」开关）：你 → 总调度 → 各成员的拓扑。执行中的线路有流动光点；派工、回报、回答时有数据包沿线路飞过；下方列出每条线路正在处理的任务和计时

界面支持中止本轮、开始新的上下文、明暗主题切换，手机宽度下也能用。

不想花钱、只想看看界面或调试时，用演示模式（假模型 + 模拟 CLI，地址 http://127.0.0.1:8788）：

```bash
npm run web:demo
```

- 服务只监听 `127.0.0.1`，并校验 Host 和 Origin，其他网站无法向它提交任务。不要把它暴露到局域网：它能驱动 agent 改文件、执行命令。
- 终端模式和网页服务共用 `data/session.sqlite`，**同一时间只能开一个**（有进程锁保护，第二个会拒绝启动）。演示模式用独立的 `data/demo.sqlite`。

### 终端模式

交互模式里的命令：`/agents` 查看成员、`/usage` 查看用量、`/abort` 中止本轮、`/new` 开始新的上下文、`/exit` 退出；Ctrl+C 中止正在进行的一轮。

会话存储在 `data/session.sqlite`。重启后历史和没跑完的任务都还在。

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

`stripEnv`：启动子 CLI 前去掉的环境变量。默认去掉 `CLAUDECODE`、`CLAUDE_CODE_*`、`ANTHROPIC_*`，让各 CLI 使用自己的配置文件，而不是宿主进程注入的变量。

## 测试

```bash
npm test
```

用模拟 CLI（`scripts/fake-agent.mjs`）和 pi-ai 的 faux 模型做测试，不调用真实 API：

- `test/smoke.ts`：并行派活、汇总、会话续接、续接时回到原目录、错误目录处理
- `test/crash.ts`：成员执行到一半时强杀整个进程树，重启后续接同一会话并完成
- `test/web.ts`：启动演示模式的网页服务，检查接口、Host/Origin 校验、路径穿越、SSE 实时推送的完整流程

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/cli-runner.ts` | 启动子进程：提示词走 stdin、超时、中止时杀进程树 |
| `src/agents.ts` | 各 CLI 适配器：参数、会话续接、输出解析、进度摘要 |
| `src/tools.ts` | 把 CLI 包装成 Pi Durable 工具，以及总调度的系统提示 |
| `src/models.ts` | 总调度模型 |
| `src/app.ts` | 打开 Harness（SQLite + 工具 + 模型） |
| `src/printer.ts` | 终端实时显示进度 |
| `src/main.ts` | 终端入口（交互 / 单次） |
| `src/server.ts` | 网页后端：REST 接口 + SSE 实时推送 + 静态页面 |
| `src/view.ts` | 把对话条目和实时状态转成前端用的 JSON |
| `src/demo.ts` | 演示模式：脚本化假模型 + 模拟 CLI |
| `web/` | 前端单页（无构建步骤、无依赖） |
| `scripts/check-agents.ts` | 实测三个 CLI 能否调通 |
| `scripts/fake-agent.mjs` | 模拟 CLI，测试和演示模式共用 |
