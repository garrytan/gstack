# gstack 中文整理版

> 说明：这是 `gstack` 的中文整理版入口文档，帮助中文读者快速理解这套“AI 软件工厂”方法论与安装路径。英文原文保持不变。

## 这是什么

`gstack` 是一套把 Claude Code 等编码代理组织成“虚拟软件团队”的技能系统。

它的目标不是给你一个单一提示词，而是给你一整条可重复的软件交付链路：

**Think → Plan → Build → Review → Test → Ship → Reflect**

仓库里提供了大量角色化 skill，例如：

- 创始人 / CEO 视角
- 工程经理
- 设计评审
- Staff Engineer review
- QA lead
- CSO / 安全审查
- Release engineer

以及一系列配套能力：

- 浏览器联动
- 安全边界
- QA 回归
- 上线与部署
- retro
- 多模型 second opinion

## 适合谁

- 技术型 founder
- 想像“一个人带一个 AI 团队”那样推进产品的人
- 需要把规划、评审、QA、发版系统化的人

## 快速开始

原仓库建议的最小路径是：

1. 安装 `gstack`
2. 运行 `/office-hours`
3. 对功能想法运行 `/plan-ceo-review`
4. 对有改动的分支运行 `/review`
5. 用 `/qa` 在 staging 上做真实浏览器验证

## 核心理念

### 1. 它是一个流程，不只是工具集合

`gstack` 最大的特点是：每一步的输出都会成为下一步的输入。

例如：

- `/office-hours` 会产出设计文档
- `/plan-ceo-review` 和 `/plan-eng-review` 会基于设计文档继续收缩范围、验证架构
- `/review` 会对实现后的分支做代码与完整性审查
- `/qa` 会在真实浏览器中验证用户流并发现 bug
- `/ship` 负责把通过验证的结果推向 PR 与发布

### 2. 强调“像团队一样工作”

仓库里把许多角色显式拆开：

- CEO / Founder
- Eng manager
- Senior designer
- Staff engineer reviewer
- QA lead
- Security officer
- Release engineer

这能帮助用户在 solo 开发时补足“平时没有人帮你挑战和审查”的环节。

### 3. 设计被放在系统中心

`gstack` 不把设计当成附属物，而是强调：

- 先审方案里的设计质量
- 再做视觉方向探索
- 再做 design review
- 再让工程方案和 QA 读取这些设计结论

## 安装方式

### Claude Code

原仓库提供了基于 Claude Code 的安装方式和 setup 脚本。

### Codex / Gemini CLI / Cursor

对于支持 `SKILL.md` 标准的宿主，可以按以下方式在单仓库里安装：

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git .agents/skills/gstack
cd .agents/skills/gstack && ./setup --host codex
```

也可以按用户级全局安装：

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host codex
```

`setup --host codex` 会把运行时根目录放到 `~/.codex/skills/gstack`，并处理好 Codex 所需的技能发现结构。

## 最常用的一组命令

### 规划与方向

- `/office-hours`
- `/plan-ceo-review`
- `/plan-eng-review`
- `/plan-design-review`
- `/autoplan`

### 设计与实现

- `/design-consultation`
- `/design-shotgun`
- `/design-html`
- `/review`
- `/investigate`

### QA 与发布

- `/qa`
- `/qa-only`
- `/ship`
- `/land-and-deploy`
- `/canary`
- `/benchmark`
- `/document-release`
- `/retro`

### 安全与护栏

- `/cso`
- `/careful`
- `/freeze`
- `/guard`
- `/unfreeze`

### 浏览器与辅助

- `/browse`
- `/connect-chrome`
- `/setup-browser-cookies`
- `/setup-deploy`
- `/gstack-upgrade`
- `/learn`
- `/codex`

## 你应该如何使用它

如果你是 solo builder，不建议一口气把 `gstack` 全量吃下。

更现实的用法是：

1. 先用 `/office-hours` 把产品问题和方案写清楚
2. 用 `/plan-ceo-review` / `/plan-eng-review` 收缩范围
3. 开始 build
4. 只在关键节点用 `/review`、`/qa`、`/ship`

也就是说，先把它当成：

- 规划器
- 审查器
- QA / 发版器

而不是马上把所有技能都纳入日常工作。

## 推荐阅读顺序

如果你想继续深入，建议按这个顺序看英文原文：

1. `README.md`
2. `docs/skills.md`
3. `AGENTS.md`
4. `ARCHITECTURE.md`
5. `DESIGN.md`
6. `ETHOS.md`

## 相关文件

- 英文原文：[README.md](/Users/zhanyu/projects/gstack/README.md)
- 技能总览：[docs/skills.md](/Users/zhanyu/projects/gstack/docs/skills.md)
- 架构说明：[ARCHITECTURE.md](/Users/zhanyu/projects/gstack/ARCHITECTURE.md)
- 设计说明：[DESIGN.md](/Users/zhanyu/projects/gstack/DESIGN.md)

