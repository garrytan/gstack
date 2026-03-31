# gstack — AI 工程工作流

gstack 是一组 `SKILL.md` 文件的集合，用来为 AI agents 提供结构化的软件开发角色。
每个 skill 都对应一个专门身份：CEO reviewer、eng manager、designer、QA lead、
release engineer、debugger 等。

## 可用 skills

skills 位于 `.agents/skills/` 中。通过名字直接调用（例如 `/office-hours`）。

| Skill | 作用 |
|-------|------|
| `/office-hours` | 从这里开始。在写代码之前，先重构你的产品想法。 |
| `/plan-ceo-review` | CEO 级审视：找出请求中真正的 10-star 产品。 |
| `/plan-eng-review` | 锁定架构、数据流、边界情况和测试方案。 |
| `/plan-design-review` | 对每个设计维度打 0-10 分，并解释 10 分长什么样。 |
| `/design-consultation` | 从零构建完整设计系统。 |
| `/review` | 合并前的 PR 审查。专门找 CI 过了但线上会炸的问题。 |
| `/debug` | 系统化根因排查。不调查清楚，不允许修。 |
| `/design-review` | 设计审计 + 修复循环，配合原子提交。 |
| `/qa` | 打开真实浏览器，找 bug、修 bug、再验证。 |
| `/qa-only` | 与 `/qa` 方法相同，但只报告问题，不改代码。 |
| `/ship` | 跑测试、审查、推送、开 PR，一条命令完成。 |
| `/document-release` | 更新所有文档，使其与刚发布的内容保持一致。 |
| `/retro` | 每周 retrospective，包含逐人拆解和连续交付记录。 |
| `/browse` | Headless browser，真实 Chromium、真实点击，约 100ms/命令。 |
| `/setup-browser-cookies` | 从你真实浏览器导入 cookies，用于已登录场景测试。 |
| `/careful` | 在破坏性命令前发出警告（如 `rm -rf`、`DROP TABLE`、force-push）。 |
| `/freeze` | 将编辑范围锁定到单个目录。是硬性阻止，不只是提醒。 |
| `/guard` | 同时开启 careful + freeze。 |
| `/unfreeze` | 解除目录编辑限制。 |
| `/gstack-upgrade` | 把 gstack 升级到最新版本。 |

## 构建命令

```bash
bun install              # 安装依赖
bun test                 # 运行测试（免费，<5s）
bun run build            # 生成文档并编译二进制
bun run gen:skill-docs   # 从模板重新生成 SKILL.md
bun run skill:check      # 查看所有 skills 的健康面板
```

## 关键约定

- `SKILL.md` 文件是从 `.tmpl` 模板**生成**的。请修改模板，不要直接改生成结果。
- 运行 `bun run gen:skill-docs --host codex` 以重新生成 Codex 专用输出。
- `browse` 二进制提供 headless browser 能力。在 skills 中使用 `$B <command>`。
- 安全类 skills（careful、freeze、guard）通过内嵌提示文本发挥作用，在执行破坏性操作前始终需要确认。
