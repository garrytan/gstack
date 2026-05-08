# gstack × OpenClaw 集成

gstack 以方法论来源而非移植代码库的方式与 OpenClaw 集成。OpenClaw 的 ACP 运行时原生派生 Claude Code 会话。gstack 提供规划纪律和方法论，使这些会话更出色。

这是一个编码为提示文本的轻量级协议。没有守护进程，没有 JSON-RPC，没有兼容性矩阵。提示就是桥梁。

## 架构

```
  OpenClaw                               gstack 仓库
  ─────────────────────                    ──────────────
  编排者：消息、日历、                        方法论 + 计划的
  记忆、助理                                  真实来源
       │                                        │
       ├── 原生技能（对话式）                    ├── 通过 gen-skill-docs 管道
       │   office-hours, ceo-review,            │   生成原生技能
       │   investigate, retro                   │
       │                                        ├── 生成 gstack-lite
       ├── sessions_spawn(runtime: "acp")       │   （规划纪律）
       │       │                                │
       │       └── Claude Code                  ├── 生成 gstack-full
       │           └── gstack 安装于            │   （完整流水线）
       │               ~/.claude/skills/gstack  │
       │                                        └── docs/OPENCLAW.md（本文件）
       └── 调度路由（AGENTS.md）
```

## 调度路由

OpenClaw 在派生时决定使用哪个层次的 gstack 支持：

| 层次 | 触发时机 | 提示前缀 |
|------|---------|---------|
| **简单** | 单文件编辑、拼写错误、配置更改 | 不注入 gstack 上下文 |
| **中等** | 多文件功能、重构 | 追加 gstack-lite CLAUDE.md |
| **繁重** | 需要特定 gstack 技能 | "Load gstack. Run /X" |
| **完整** | 完整功能、目标、项目 | 追加 gstack-full 流水线 |
| **计划** | "帮我规划一个 Claude Code 项目" | 追加 gstack-plan 流水线 |

### 决策启发

- 不超过 10 行代码能完成？-> **简单**
- 涉及多个文件但方法明显？-> **中等**
- 用户点名了某个技能（/cso, /review, /qa）？-> **繁重**
- 是一个功能、项目或目标（而不是一个任务）？-> **完整**
- 用户想在不实现的情况下为 Claude Code 规划某事？-> **计划**

### 调度路由指南（用于 AGENTS.md）

完整的即用即贴内容位于 `openclaw/agents-gstack-section.md`。
将其复制到你的 OpenClaw AGENTS.md 中。

关键行为规则（这些放在调度层次**之上**）：

1. **总是派生，永不重定向。** 当用户要求使用任何 gstack 技能时，
   **总是**派生一个 Claude Code 会话。永远不要告诉用户去打开 Claude Code。
2. **解析仓库。** 如果用户指定了一个仓库，设置工作目录。如果
   不知道，询问哪个仓库。
3. **Autoplan 端到端运行。** 派生，让它运行完整流水线，在聊天中汇报。
   用户不应该需要离开 Telegram。

### CLAUDE.md 冲突处理

当在已有 CLAUDE.md 的仓库中派生 Claude Code 时，将 gstack-lite/full **追加**为新章节。不要替换仓库现有的指令。

## gstack 为 OpenClaw 生成什么

所有产物都位于 `openclaw/` 目录中，由 `bun run gen:skill-docs --host openclaw` 生成：

### gstack-lite（中等层次）
`openclaw/gstack-lite-CLAUDE.md` — 约 15 行规划纪律：
1. 修改前读取每个文件
2. 写一个 5 行计划：内容、原因、哪些文件、测试用例、风险
3. 使用决策原则解决歧义
4. 报告完成前进行自我审查
5. 完成报告：发布了什么、做了什么决定、有什么不确定的

A/B 测试结果：时间翻倍，输出质量明显更好。

### gstack-full（完整层次）
`openclaw/gstack-full-CLAUDE.md` — 串联现有 gstack 技能：
1. 读取 CLAUDE.md，理解项目
2. 运行 /autoplan（CEO + 工程 + 设计评审）
3. 实现批准的计划
4. 运行 /ship 创建 PR
5. 汇报 PR URL 和决策

### gstack-plan（计划层次）
`openclaw/gstack-plan-CLAUDE.md` — 完整评审流程，不实现：
1. 运行 /office-hours 生成设计文档
2. 运行 /autoplan（CEO + 工程 + 设计 + DX 评审 + codex 对抗性）
3. 将评审后的计划保存到 `plans/<project-slug>-plan-<date>.md`
4. 汇报：计划路径、摘要、关键决策、推荐的下一步

编排者将计划链接持久化到自己的记忆存储（brain 仓库、知识库或 AGENTS.md 中配置的任何东西）。当用户准备好构建时，派生一个引用已保存计划的完整会话。

### 原生方法论技能
已发布到 ClawHub。使用 `clawhub install` 安装：
- `gstack-openclaw-office-hours` — 产品质询（6 个强制性问题）
- `gstack-openclaw-ceo-review` — 战略挑战（10 节评审，4 种模式）
- `gstack-openclaw-investigate` — 操作性调试（4 阶段方法论）
- `gstack-openclaw-retro` — 操作性回顾（每周评审）

源码位于 gstack 仓库的 `openclaw/skills/` 中。这些是针对 OpenClaw 对话上下文手工改编的 gstack 方法论版本。不依赖 gstack 基础设施（无浏览器、无遥测、无前言）。

## 派生会话检测

当 Claude Code 在 OpenClaw 派生的会话中运行时，应该设置 `OPENCLAW_SESSION` 环境变量。gstack 检测到这个变量后会进行调整：
- 跳过交互式提示（自动选择推荐选项）
- 跳过升级检查和遥测提示
- 专注于任务完成和文字汇报

在 sessions_spawn 中设置环境变量：`env: { OPENCLAW_SESSION: "1" }`

## 安装

对于 OpenClaw 用户：告诉你的 OpenClaw 智能体"为 openclaw 安装 gstack"。

智能体应该：
1. 将 gstack-lite CLAUDE.md 安装到其编程会话模板中
2. 安装 4 个原生方法论技能
3. 将调度路由添加到 AGENTS.md
4. 用测试派生进行验证

对于 gstack 开发者：`./setup --host openclaw` 输出本文档。
实际产物由 `bun run gen:skill-docs --host openclaw` 生成。

## 我们不做的事情

- 没有调度守护进程（ACP 处理会话派生）
- 没有 Clawvisor 中继（不需要安全层）
- 没有双向学习桥（brain 仓库是知识存储）
- 没有 JSON 模式或协议版本控制
- 没有来自 gstack 的 SOUL.md（OpenClaw 有自己的）
- 没有完整技能移植（编程技能在 Claude Code 中保持原生）
