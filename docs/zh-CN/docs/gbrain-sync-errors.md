# gbrain-sync 错误查询

`gstack-brain-*` 可能打印的每条错误消息，以及问题、原因和修复方法。

通过 `BRAIN_SYNC:` 后的前缀或命令输出中的二进制名称来搜索本文件。

---

## `BRAIN_SYNC: 检测到 brain 仓库：<url>`

**问题。** 你在一台拥有 `~/.gstack-brain-remote.txt`（从另一台机器复制来的）但在 `~/.gstack/.git` 没有本地 git 仓库的机器上。

**原因。** 你在别处设置了 GBrain 同步，但这台机器上的 gstack 还没有恢复。

**修复方法。**
```bash
gstack-brain-restore
```
这会将仓库拉到 `~/.gstack/` 并重新注册合并驱动程序。

如果你不想在这里恢复，用以下命令忽略提示：
```bash
gstack-config set gbrain_sync_mode_prompted true
```

---

## `BRAIN_SYNC: 已阻止：<模式-家族>:<片段>`

**问题。** 同步停止，因为秘密扫描器在暂存文件中检测到了凭证形状的内容。队列被保留；没有任何内容被推送。

**原因。** 预提交秘密模式之一匹配了文件内容——可能是嵌入在 JSON 中的 AWS 密钥、GitHub 令牌、OpenAI 密钥、PEM 块、JWT 或 Bearer 令牌。

**修复方法（三个选项）。**

1. **如果是真实秘密**：编辑违规文件以删除秘密，然后重新运行任何技能以重试同步。

2. **如果模式是误报**（例如，你的学习内容包含一个你*想要*发布的示例字符串中的 GitHub 令牌模式）：
   ```bash
   gstack-brain-sync --skip-file <path>
   ```
   这会永久从未来的同步中排除该路径。

3. **如果你想完全放弃这个同步批次**（重新开始）：
   ```bash
   gstack-brain-sync --drop-queue --yes
   ```
   这会清除队列而不提交。未来的写入将正常重新填充它。

---

## `BRAIN_SYNC: 推送失败：认证。`

**问题。** git 推送被拒绝，因为你与远程的认证已过期或缺失。

**原因。** 无法用当前凭证访问远程。

**修复方法。** 根据你的远程刷新认证：

- **GitHub**：`gh auth status`（然后如果需要 `gh auth refresh`）
- **GitLab**：`glab auth status`
- **其他**：`git remote -v` + 检查 SSH 密钥或凭证助手

修复认证后，运行任何技能自动重试同步。

---

## `BRAIN_SYNC: 推送失败：<错误第一行>`

**问题。** 推送因认证之外的原因失败。git 错误的第一行出现在冒号后。

**原因。** 可能是网络问题、推送被拒（远程超前）、服务器 500，或仓库访问被撤销。

**修复方法。** 查看 `~/.gstack/.brain-sync-status.json` 获取更多详情，或运行：
```bash
cd ~/.gstack && git status && git push origin HEAD
```
查看 git 的完整错误。队列在每次推送尝试后都会被清除，但你的本地提交仍然存在——下次技能运行将重试推送。

---

## `gstack-brain-init: ~/.gstack/.git 已经是一个指向 <url> 的 git 仓库`

**问题。** 你尝试用一个与现有远程 URL 不匹配的远程 URL 进行初始化。

**原因。** 你已经用不同的远程运行了 `gstack-brain-init`。

**修复方法。** 两个选项之一：

- 使用现有远程：不带 `--remote` 运行 `gstack-brain-init`，或带匹配的 URL。
- 切换远程：先运行 `gstack-brain-uninstall`，然后用新 URL 重新初始化。这不会删除你的数据。

---

## `远程不可访问：<url>`

**问题。** 初始化无法访问 git 远程以验证连接。

**原因。** 错误的 URL、缺少认证、网络问题。

**修复方法。** 手动测试：
```bash
git ls-remote <url>
```
如果失败，检查：
- URL 拼写
- GitHub：`gh auth status`
- GitLab：`glab auth status`
- 私有网络 / VPN / DNS

---

## `gstack-brain-init: 无法创建或找到 '<name>'`

**问题。** 通过 `gh repo create` 自动创建仓库失败，并且通过 `gh repo view` 也无法发现该仓库。

**原因。** `gh` 未认证、具有该名称的仓库已被他人拥有，或你的 GitHub 账户达到了配额。

**修复方法。**
```bash
gh auth status
```
如果未认证，运行 `gh auth login`。如果仓库名称冲突，传递不同的名称：
```bash
gstack-brain-init --remote git@github.com:YOURUSER/custom-name.git
```

---

## `gstack-brain-restore: ~/.gstack/.git 已经指向 <url>`

**问题。** 你尝试从一个与现有 git 配置不匹配的 URL 进行恢复。

**原因。** 之前用不同远程初始化的过期 `.git`。

**修复方法。** 运行 `gstack-brain-uninstall`，然后重新运行 `gstack-brain-restore <url>`。

---

## `gstack-brain-restore: ~/.gstack/ 包含将被覆盖的现有允许列表文件`

**问题。** 你正在尝试恢复，但 `~/.gstack/` 已经包含会被覆盖的学习内容或计划。

**原因。** 要么（a）这台机器从预同步 gstack 会话中积累了状态，要么（b）之前失败的恢复留下了部分状态。

**修复方法（三个选项）。**

1. **如果这台机器的状态应该成为新的真实来源**：运行 `gstack-brain-init` 而不是 restore——这从这台机器的状态创建一个全新的 brain 仓库。

2. **如果你想采用远程并丢弃这台机器的状态**：先备份 `~/.gstack/projects/`，然后删除违规文件并重新运行 restore。

3. **如果你想合并**：没有自动合并。手动将学习内容从 `~/.gstack/` 复制到已开启同步的机器上运行的 gstack，然后在这里进行 restore。

---

## `gstack-brain-restore: <url> 看起来不像 gstack-brain 仓库`

**问题。** 克隆成功，但仓库缺少 `.brain-allowlist` 和 `.gitattributes`。

**原因。** 你将 restore 指向了一个随机 git 仓库，或者有人从 brain 仓库中删除了规范配置文件。

**修复方法。** 验证 URL。如果正确，运行 `gstack-brain-init --remote <url>` 重新播种规范配置。

---

## 没有同步，但我期望有

**不是错误，但是常见的陷阱。** 按顺序检查：

1. `gstack-brain-sync --status` — 模式是 `off` 吗？
2. `~/.gstack/.git` 是否存在？
3. `gstack-config get gbrain_sync_mode` — 应该是 `full` 或 `artifacts-only`。
4. 你期望同步的文件——它在允许列表中吗？
   `cat ~/.gstack/.brain-allowlist`
5. 隐私类过滤器——如果模式是 `artifacts-only`，行为文件（时间轴、开发者档案）被故意跳过。

如果所有这些看起来都没问题，运行：
```bash
gstack-brain-sync --discover-new
gstack-brain-sync --once
```
强制清空。
