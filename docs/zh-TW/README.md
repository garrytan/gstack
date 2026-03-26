# gstack

> **[English](../../README.md)** | 繁體中文

gstack 是一個開源的軟體工廠框架，由 [Garry Tan](https://x.com/garrytan)（Y Combinator 現任 CEO）打造。它將 Claude Code 轉變為一支你可以管理的虛擬工程團隊 — 十五個專業角色加上六個強力工具，全部以 slash command 形式提供，全部用 Markdown 寫成，完全免費、MIT 授權。

## 適合誰使用

- **創辦人與 CEO** — 尤其是還想親手寫 code 的技術創辦人。這是讓你一個人有二十人團隊產出的方法。
- **Claude Code 新手** — gstack 是最好的起點。結構化的角色取代空白的 prompt。
- **Tech Lead 與 Staff Engineer** — 為每個 PR 帶來嚴謹的 review、QA 和發佈自動化。

## 快速開始：你的前 10 分鐘

1. 安裝 gstack（30 秒 — 見下方）
2. 執行 `/office-hours` — 描述你正在打造的東西。它會在你寫任何程式碼之前重新定義問題。
3. 對任何功能構想執行 `/plan-ceo-review`
4. 對任何有變更的 branch 執行 `/review`
5. 對你的 staging URL 執行 `/qa`
6. 到這裡就好。你會知道這是不是適合你的工具。

在已有測試的 repo 上，預計 5 分鐘內就能看到實際效果。

## 安裝 — 只需 30 秒

**需求：** [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Git](https://git-scm.com/)、[Bun](https://bun.sh/) v1.0+

### 步驟一：安裝到你的電腦

打開 Claude Code，貼上以下指令。Claude 會處理剩下的事。

> Install gstack: run **`git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`** then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, and lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies, /retro, /investigate, /document-release, /codex, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade. Then ask the user if they also want to add gstack to the current project so teammates get it.

### 步驟二：加入你的 repo（可選）

> Add gstack to this project: run **`cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup`** then add a "gstack" section to this project's CLAUDE.md.

實際檔案會直接提交到你的 repo（不是 submodule），所以 `git clone` 就能直接使用。所有東西都在 `.claude/` 目錄裡，不會動到你的 PATH 或在背景執行。

### Codex、Gemini CLI 或 Cursor

gstack 支援任何實作了 [SKILL.md 標準](https://github.com/anthropics/claude-code) 的 agent。

```bash
git clone https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host auto
```

這會自動偵測你安裝了哪些 agent，並安裝到對應的目錄。

## Sprint 流程

gstack 是一個流程，不是一堆工具的集合。Skills 按照 sprint 的順序排列：

**思考 → 規劃 → 建造 → 審查 → 測試 → 發佈 → 反思**

每個 skill 的輸出會餵給下一個。`/office-hours` 寫的設計文件會被 `/plan-ceo-review` 讀取。`/plan-eng-review` 寫的測試計畫會被 `/qa` 接手。`/review` 找到的 bug 會被 `/ship` 驗證已修復。

## Skills 一覽

| Skill | 角色 | 功能 |
|-------|------|------|
| `/office-hours` | **YC Office Hours** | 起點。六個關鍵問題重新定義你的產品。 |
| `/plan-ceo-review` | **CEO / 創辦人** | 重新思考問題，找到隱藏在需求中的十星產品。 |
| `/plan-eng-review` | **工程經理** | 鎖定架構、資料流、圖表、邊界案例和測試。 |
| `/plan-design-review` | **資深設計師** | 為每個設計維度評分 0-10，說明 10 分的標準。 |
| `/design-consultation` | **設計合作夥伴** | 從零開始建立完整的設計系統。 |
| `/review` | **Staff Engineer** | 找到那些通過 CI 但在生產環境爆炸的 bug。 |
| `/investigate` | **除錯專家** | 系統性的根因除錯。 |
| `/design-review` | **會寫 code 的設計師** | 審查後直接修復問題。 |
| `/qa` | **QA 主管** | 用真實瀏覽器測試你的 app，找 bug、修 bug、再驗證。 |
| `/qa-only` | **QA 報告員** | 同樣的方法論，但只產出報告不修改程式碼。 |
| `/ship` | **發佈工程師** | 同步 main、跑測試、審計覆蓋率、push、開 PR。一個指令搞定。 |
| `/document-release` | **技術文件工程師** | 更新所有專案文件以符合剛發佈的內容。 |
| `/retro` | **工程經理** | 每週回顧。個人分析、發佈紀錄、測試健康度趨勢。 |
| `/browse` | **QA 工程師** | 讓 agent 看得到。真正的 Chromium 瀏覽器。 |
| `/codex` | **第二意見** | 來自 OpenAI Codex CLI 的獨立程式碼審查。 |
| `/careful` | **安全護欄** | 在破壞性指令執行前警告。 |
| `/freeze` | **編輯鎖** | 限制檔案編輯範圍到一個目錄。 |
| `/guard` | **全面安全** | `/careful` + `/freeze` 合而為一。 |

## 授權

MIT — 完全免費、開源。Fork 它、改進它、讓它成為你的。

---

*這是社群翻譯版本。以 [英文原版](../../README.md) 為準。*
