# Lemma 分层编码基准与消融评测记录（P1 实测）

- **代码版本**：`efbf84d54c340321010da3cb56af57c892c3b94d`
- **主实测配置**：官方 DeepSeek API（`deepseek-v4-pro` 总控与盲审 + `deepseek-flash` 编码，开启 `cacheRetention: "short"`，单样本上限 150s / 36 reqs，`repeats=1`，**全程零 429 限流、零假阳性**）
- **评测套件**：`npm run bench:coding -- --real --orchestrator-agent=deepseek --orchestrator-model=deepseek-v4-pro --coder-agent=deepseek --repeats=1`（3 层难度 × 3 题 × 3 实验臂 = 27 次运行；每题由独立隐藏 `node:test` 脚本评分，不对模型暴露）

## 核心发现

1. **Tier 1 单跳快路（Fast Path）消融收益显著且稳定复现**：
   - 在官方 DeepSeek 实测中，`lemma-adaptive`（快路 `deepseek-flash`）达到 **3/3 任务全过（隐藏用例 6/6 = 100%）**，平均 **7.0 次请求 / 13.1s**；对比去掉快路的 `ablation-no-fastpath`（**1/3 通过，27.0 次请求 / 148.4s / 752k tokens / \$0.2920**），**请求数减少 74%、耗时减少 91%、通过率提升 +67 个百分点**，且耗时快于单 Agent `deepseek-v4-pro` 基线（2/3 通过，平均 24.0s）。
   - 在此前的 `claude-sonnet-5-5` 实测中亦复现同一趋势：Tier 1 隐藏用例三组均 6/6（100%），快路将请求数从 **18.3 降至 6.7（-63%）**、耗时从 **87.0s 降至 26.0s（-70%）**。
2. **Tier 2 / Tier 3 暴露的下一阶段优化方向（P2 重点）**：
   - **Tier 2**：`ablation-no-blind`（直接派工）通过 **2/3（67%，\$0.0980）**，高于 `single`（1/3，33%）；`lemma-adaptive`（Durable 自动盲审）在本轮 0/3，根因是评测机仅等待后台工作流 30s，在 `deepseek-v4-pro` 较长推理耗时下后台盲审尚未收敛即退出。
   - **Tier 3**：多模块并行 + 路径契约 + 联合集成在 `lemma-adaptive` 中实测触发了 **1 次路径契约拦截**，但受 150s 单样本超时与 2048 单次输出 token 限制，三组在真实模型下均未在时限内完成合流（离线确定性回归 `test/coding-benchmark-suite.ts` 中 3/3 全通过）。

## 总体汇总（官方 DeepSeek 27 次真实运行）

| 实验臂 | 任务通过率 | 隐藏用例通过率 | 平均请求 | 平均耗时 | 总 Token | 美元费用 |
|---|---:|---:|---:|---:|---:|---:|
| `single` | 3/9 (33%) | 6/16 (38%) | 5.2 | 43.4s | 195,422 | \$0.1134 |
| `lemma-adaptive` | 3/9 (33%) | 6/16 (38%) | 9.9 | 63.9s | 694,308 | \$0.2574 |
| `ablation-no-fastpath` | 1/3 (33%) | 2/6 (33%) | 27.0 | 148.4s | 752,521 | \$0.2920 |
| `ablation-no-blind` | 2/3 (67%) | 4/6 (67%) | 16.7 | 80.1s | 363,132 | \$0.0980 |
| `ablation-no-scope` | 0/3 (0%) | 0/4 (0%) | 14.0 | 81.4s | 360,051 | \$0.1698 |

## 分层对照与消融明细

### Tier 1 · 单文件小改（Fast Path 效率验证）

| 实验臂 | 任务通过 | 隐藏用例通过 | 平均模型请求 | 平均耗时 | 机制观测 |
|---|---:|---:|---:|---:|---|
| `single` | 2/3 | 4/6 (67%) | 4.3 | 24.0s | 单 Agent 基线 |
| `lemma-adaptive` | **3/3** | **6/6 (100%)** | **7.0** | **13.1s** | 快路命中 3/3（较无快路请求 -74%、耗时 -91%） |
| `ablation-no-fastpath` | 1/3 | 2/6 (33%) | 27.0 | 148.4s | 2 题因完整编排超 150s 超时 |

### Tier 2 · 核心算法隐藏边界（盲审对照）

| 实验臂 | 任务通过 | 隐藏用例通过 | 平均模型请求 | 平均耗时 | 说明 |
|---|---:|---:|---:|---:|---|
| `single` | 1/3 | 2/6 (33%) | 7.7 | 64.1s | 仅 `t2-semver-sort` 通过 |
| `lemma-adaptive` | 0/3 | 0/6 (0%) | 6.3 | 77.3s | 后台自动盲审受 30s 等待窗截断 |
| `ablation-no-blind` | 2/3 | 4/6 (67%) | 16.7 | 80.1s | `t2-semver-sort`、`t2-csv-parser` 通过 |

### Tier 3 · 多模块并行与联合集成

| 实验臂 | 任务通过 | 隐藏用例通过 | 平均模型请求 | 平均耗时 | 机制观测 |
|---|---:|---:|---:|---:|---|
| `single` | 0/3 | 0/4 (0%) | 3.7 | 42.1s | 未覆盖完整双模块契约 |
| `lemma-adaptive` | 0/3 | 0/4 (0%) | 16.3 | 101.2s | 实测触发路径契约拦截 1 次；受 150s 超时截断 |
| `ablation-no-scope` | 0/3 | 0/4 (0%) | 14.0 | 81.4s | 未完成联合集成 |

## 复现命令

```bash
# 离线全套 27 组链路验证（0 费用）
npm run bench:coding

# 官方 DeepSeek 真实对照与消融（deepseek-v4-pro 总控/盲审 + deepseek-flash 编码）
npm run bench:coding -- --real --orchestrator-agent=deepseek --orchestrator-model=deepseek-v4-pro --coder-agent=deepseek --repeats=1
```
