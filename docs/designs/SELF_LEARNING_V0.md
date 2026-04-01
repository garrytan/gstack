# 设计：GStack 自学习基础设施

由 `/office-hours` + `/plan-ceo-review` + `/plan-eng-review` 于 2026-03-28 生成  
分支：`garrytan/ce-features`  
仓库：`gstack`  
状态：`ACTIVE`  
模式：开源 / 社区

## 问题陈述

GStack 会跨会话运行 30+ 个 skill，但它们之间什么都学不到。一次 `/review`
会话发现了 N+1 查询模式，下一次对同一代码库运行 `/review` 时还是从头开始。一次 `/ship`
发现了正确的测试命令，之后每次 `/ship` 都还要重新发现一次。一次 `/investigate`
找到了一个棘手的竞态条件，后面的会话却完全不知道这件事。

所有 AI 编码工具都有这个问题。Cursor 有按用户维度的记忆。Claude Code 有
`CLAUDE.md`。Windsurf 有持久化上下文。但它们都不能复利。它们不会结构化地管理
自己学到的东西。它们也不会在不同 skill 之间共享知识。

## 我们在构建什么

一种按项目沉淀的机构级知识，它会在不同会话和不同 skill 之间持续复利。每条学习结果都具备结构化字段、类型、置信度评分，并且任意 gstack skill 都能读写。目标是：当同一个代码库被跑过 20 次之后，gstack 已经知道所有架构决策、过去出现过的 bug 模式，以及它曾经出错的地方。

## 北极星

`/autoship`（Release 4）。用一条命令调用完整工程团队。你描述一个功能，批准计划，剩下的全部自动完成。没有 learnings，`/autoship` 就不可能成立，因为没有记忆它就会重复犯同样的错。Release 1-3 就是为了让 `/autoship` 真正可用而铺设的基础设施。

## 目标用户

使用 AI 构建产品的 YC 创始人。他们每周会在真实代码库上运行 gstack 20+ 次，因此能明显感知到工具是不是问了同一个问题两遍。

## 差异化

| 工具 | 记忆模型 | 作用范围 | 结构化程度 |
|------|-------------|-------|-----------|
| Cursor | 按用户聊天记忆 | 单会话 | 非结构化 |
| CLAUDE.md | 静态文件 | 单项目 | 手工维护 |
| Windsurf | 持久化上下文 | 单会话 | 非结构化 |
| **GStack** | **按项目 JSONL** | **跨会话、跨 skill** | **有类型、可打分、会衰减** |

---

## 版本路线图

### Release 1: “GStack Learns” (v0.14)

**标题：** 每一次会话都会让下一次更聪明。

交付内容：

- 在 `~/.gstack/projects/{slug}/learnings.jsonl` 持久化 learnings
- 提供 `/learn` skill，用于手工审查、搜索、修剪和导出
- 所有 review 发现都增加置信度校准（1-10 分，带展示规则）
- 对 observed / inferred learnings 启用置信度衰减（每 30 天减 1 分）
- 支持跨项目 learnings 发现（可选加入，需要 `AskUserQuestion` 同意）
- 当 review 命中过去的 learnings 时，给出 “Learning applied” 提示
- 接入 `/review`、`/ship`、`/plan-*`、`/office-hours`、`/investigate`、`/retro`

Schema（兼容 Supabase）：

```json
{
  "ts": "2026-03-28T12:00:00Z",
  "skill": "review",
  "type": "pitfall",
  "key": "n-plus-one-activerecord",
  "insight": "Always check includes() for has_many in list endpoints",
  "confidence": 8,
  "source": "observed",
  "branch": "feature-x",
  "commit": "abc1234",
  "files": ["app/models/user.rb"]
}
```

类型：`pattern` | `pitfall` | `preference` | `architecture` | `tool`  
来源：`observed` | `user-stated` | `inferred` | `cross-model`

架构：采用 append-only JSONL。重复项在读取时解决（同一 `key+type` 以最新记录为准）。写入阶段不做原地变更，因此没有竞态条件。沿用了现有的 `gstack-review-log` 模式。

### Release 2: “审查 Army” (v0.15)

**标题：** 每个 PR 都有 10 个专家 reviewer。

交付内容：

- 7 个并行 specialist subagent：常驻型（testing、maintainability）+
  条件型（security、performance、data-migration、API contract、design）+
  red team（针对大 diff 或关键发现）
- 结构化 JSON findings，带置信度评分 + 跨 agent 的 fingerprint 去重
- 每次 review 记录 PR 质量分（0-10），并在 `/retro` 中形成趋势（E2）
- 引入学习结果驱动的 specialist prompt，各领域会注入过去的 pitfalls（E4）
- 多 specialist 共识高亮，多个 agent 共同确认的问题会被提升优先级（E6）
- 通过 `PLAN_COMPLETION_AUDIT` 强化 Delivery Integrity，包括调查深度、
  commit message fallback，以及计划文件的 learnings 记录
- 重构 checklist：关键类别保留在主流程中，specialist 类别拆到 `review/specialists/` 的聚焦清单中

### Release 2.5: “审查 Army Expansions” (v0.15.x)

**标题：** 在 R2 证明稳定后再上线。先检查核心循环表现如何。

前置检查：审查 R2 的质量指标（PR 质量分、specialist 命中率、误报率、E2E 测试稳定性）。如果核心循环本身有问题，先修这个，再扩展。

交付内容：

- E1：自适应 specialist gating。对长期保持 0 发现记录的 specialist 自动跳过。
  通过 `gstack-learnings-log` 存储每个项目的命中率。用户可用 `--security` 等参数强制启用。
- E3：生成测试桩。每个 specialist 除 findings 外还输出 `TEST_STUB`。
  从项目中自动识别测试框架（Jest / Vitest / RSpec / pytest / Go test）。
  接入 Fix-First：`AUTO-FIX` 既应用修复，也创建测试文件。
- E5：跨 review 去重。读取 `gstack-review-read` 中历史 review 条目。
  若本次发现命中了之前已被用户跳过的问题，则抑制该条发现。
- E7：跟踪 specialist 表现。通过 `gstack-review-log` 记录各 specialist 指标。
  接入 `/retro`，例如输出：“Top finding specialist: Performance（7 findings）。”

### Release 3: “Smart Ceremony” (v0.16)

**标题：** GStack 尊重你的时间。

交付内容：

- 在 `/review`、`/ship`、`/autoplan` 中增加范围评估（TINY / SMALL / MEDIUM / LARGE）
- 根据 diff 大小和范围类别跳过不必要 ceremony
- 基于文件的 todo 生命周期（`/triage` 用于交互式批准，`/resolve` 用并行 agent 批量处理）

### Release 4: “/autoship — One Command, Full 功能” (v0.17)

**标题：** 描述一个功能，批准计划，剩下全部自动完成。

交付内容：

- `/autoship` 自治流水线：office-hours → autoplan → build → review → qa →
  ship → learn。7 个阶段，1 个审批关口（计划）
- `/ideate` 头脑风暴 skill（并行发散 agent + 对抗式过滤）
- 在 `/plan-eng-review` 中加入研究型 agent（代码库分析、历史分析、
  最佳实践研究、learnings 研究）

### Release 5: “Studio” (v0.18)

**标题：** 全栈 AI 工程工作室。

交付内容：

- Figma 设计同步（像素级对齐迭代闭环）
- 功能视频录制（自动生成 PR 演示）
- PR 反馈处理（并行 comment resolver）
- Swarm 编排（多 worktree 并行构建）
- `/onboard`（自动生成贡献者指南）
- `/triage-prs`（维护者批量处理 PR）
- Codex 构建委托（把实现工作委托给 Codex CLI）
- 跨平台可移植性（Copilot、Kiro、Windsurf 输出）

---

## 致谢与灵感来源

这条自学习路线图受到了 Nico Bailon 的 [Compound Engineering](https://github.com/nicobailon/compound-engineering) 项目启发。他们对 learnings 持久化、并行 review agent 和自治流水线的探索，促成了 GStack 这套方案的设计。我们并不是直接移植，而是将这些概念重新适配到了 GStack 的模板系统、语言风格与整体架构中。
