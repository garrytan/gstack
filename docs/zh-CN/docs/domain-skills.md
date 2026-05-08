# 领域技能

智能体为自己写下的每站点笔记。跨会话复利积累：一旦智能体发现了网站的非显而易见的细节，它就会保存一个技能，未来访问该主机的会话将在其提示上下文中自动触发该笔记。

这是 gstack 借鉴 [browser-use/browser-harness](https://github.com/browser-use/browser-harness) 的东西。gstack 复制了每站点笔记模式，**不是**自修改运行时模式。技能是加载到提示中的 Markdown 文本；它们不是可执行代码。

## 智能体如何使用它

```bash
# 智能体在成功完成任务后记录下了它学到的关于网站的东西。
# 主机自动从当前活跃标签页获取（无需智能体参数）。
echo "# LinkedIn 申请按钮

/jobs/view 页面上的申请按钮位于一个 class
匹配 'jobs-apply-button-iframe' 的 iframe 内。
先使用 \$B frame --url 'apply'，然后再快照。" | $B domain-skill save

# 查看已保存的内容
$B domain-skill list

# 读取特定主机的技能内容
$B domain-skill show linkedin.com

# 在 $EDITOR 中交互式编辑
$B domain-skill edit linkedin.com

# 将每项目的活跃技能提升为全局（跨项目）
$B domain-skill promote-to-global linkedin.com

# 回滚最近的编辑
$B domain-skill rollback linkedin.com

# 删除（置墓碑——可通过回滚恢复）
$B domain-skill rm linkedin.com
```

## 状态机

```
  ┌──────────────┐  3次成功使用           ┌────────┐  promote-to-global   ┌────────┐
  │   隔离区     │ ─────────────────────▶  │ 活跃   │ ──────────────────▶  │  全局  │
  │（每项目）    │  （无分类器标志）        │(项目)  │  （手动命令）        │        │
  └──────────────┘                        └────────┘                      └────────┘
         ▲                                       │
         │  使用期间出现分类器标志                 │  回滚（版本日志）
         └───────────────────────────────────────┘
```

新保存的技能会以**隔离区**状态出现，**不会**在提示中自动触发。在该主机上 3 次使用且 L4 ML 分类器未对技能内容标记后，技能会自动提升为项目中的**活跃**状态。活跃技能会在该主机名的每个新侧边栏智能体会话中触发。

要让技能跨项目触发（例如，"我想在每个我工作的 gstack 项目上都有我的 LinkedIn 技能"），请明确运行 `$B domain-skill promote-to-global <host>`。这是出于设计的选择加入（Codex T4 外部视角评审）：大范围的跨项目复利会泄漏跨不相关工作的上下文。

## 存储

技能存在于两个地方：

- **每项目**：`~/.gstack/projects/<slug>/learnings.jsonl` — 与 `/learn` 技能使用的同一 JSONL 文件。领域技能是 `type:"domain"` 行。
- **全局**：`~/.gstack/global-domain-skills.jsonl` — 仅包含 `state:"global"` 行。

两个文件都是追加式 JSONL。删除使用墓碑；空闲压缩器会定期重写文件。容错解析器在读取时会丢弃部分尾行，因此写入中途崩溃不会毒害后续读取。

## 安全模型

技能是智能体编写的内容，加载到未来的提示上下文中。这使它们成为经典的智能体对智能体提示注入向量。计划明确通过多层来解决这个问题：

| 层次 | 内容 | 位置 |
|------|------|------|
| L1-L3 | 数据标记、隐藏元素剥离、ARIA 正则表达式、URL 黑名单 | `content-security.ts`（编译二进制文件）|
| L4 | TestSavantAI ONNX 分类器 | `security-classifier.ts`（侧边栏智能体，非编译）|
| L4b | Claude Haiku 转录分类器 | `security-classifier.ts`（侧边栏智能体）|
| L5 | 金丝雀令牌泄漏检测 | `security.ts` |

L1-L3 检查在**保存时**运行（在守护进程中）。L4 ML 分类器在**加载时**运行（在侧边栏智能体中），因此每个将技能加载到提示中的会话也会重新验证内容。这能捕捉到只有在分类器模型更新后才会出现的问题。

save 命令从**活跃标签页的顶级来源**推导主机名，而不是从智能体参数。这关闭了 Codex 标记的混淆代理 Bug：恶意页面重定向链否则可能欺骗智能体毒害不同的域。

## 错误参考

| 错误 | 原因 | 处理方法 |
|------|------|---------|
| `保存被阻止：分类器将内容标记为潜在注入` | 保存时 L4 分数 ≥ 0.85 | 重写技能，移除类似指令的散文；重试。|
| `保存被阻止：<L1-L3 消息>` | 保存时匹配 URL 黑名单或 ARIA 注入 | 检查技能正文是否有可疑模式。|
| `保存失败：空正文` | 没有通过 stdin 或 `--from-file` 提供内容 | 将 Markdown 通过管道传入 `$B domain-skill save`，或传递 `--from-file <path>`。|
| `无法保存领域技能：活跃标签页上没有顶级 URL` | 标签页是 `about:blank` 或 `chrome://...` | 先运行 `$B goto <目标站点>`，然后保存。|
| `无法提升：技能处于"隔离区"状态` | 技能尚未自动提升 | 在该项目中使用它，直到没有分类器标志的 3 次成功运行。|
| `无法回滚：<host> 的版本少于 2 个` | 只有一个版本存在 | 改用 `$B domain-skill rm` 删除。|

## 遥测

当遥测开启（默认 `community` 模式，除非关闭）时，以下事件写入 `~/.gstack/analytics/browse-telemetry.jsonl`：

- `domain_skill_saved {host, scope, state, bytes}`
- `domain_skill_save_blocked {host, reason}`
- `domain_skill_fired {host, source, version}`
- `domain_skill_state_changed {host, from_state, to_state}`（计划中）

仅主机名——没有正文内容，没有智能体文本。通过 `gstack-config set telemetry off` 或 `GSTACK_TELEMETRY_OFF=1` 完全禁用。
