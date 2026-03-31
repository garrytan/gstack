# 设计系统 — gstack

## 产品背景
- **这是什么：** gstack 的社区网站。gstack 是一个把 Claude Code 变成虚拟工程团队的 CLI 工具。
- **面向谁：** 正在了解 gstack 的开发者，以及已有社区成员
- **所属赛道 / 行业：** Developer tools（对标：Linear、Raycast、Warp、Zed）
- **项目类型：** 社区仪表盘 + 营销站点

## 美术方向
- **方向：** Industrial / Utilitarian，以功能优先、信息密集为主，monospace 作为品牌性格字体
- **装饰程度：** 有意识地克制，在表面加入微弱 noise / grain 纹理，提升材质感
- **气质：** 这是一个由真正关心 craft 的人做出来的严肃工具。要温暖，不要冰冷。CLI 传统本身就是品牌的一部分。
- **参考站点：** formulae.brew.sh（竞品，但我们的版本是实时且可交互的）、Linear（深色且克制）、Warp（带暖色强调）

## 字体系统
- **Display/Hero：** Satoshi（Black 900 / Bold 700），几何感里带一点温度，字形很有辨识度（尤其小写 `a` 和 `g`）。不要用 Inter，也不要用 Geist。从 Fontshare CDN 加载。
- **Body：** DM Sans（Regular 400 / Medium 500 / Semibold 600），干净、易读，比纯几何 Display 字体更友好。从 Google Fonts 加载。
- **UI/Labels：** DM Sans（与正文字体一致）
- **Data/Tables：** JetBrains Mono（Regular 400 / Medium 500），这是品牌性格字体。支持 tabular-nums。Monospace 应该被突出，而不是只藏在代码块里。从 Google Fonts 加载。
- **Code：** JetBrains Mono
- **加载方式：** DM Sans + JetBrains Mono 使用 Google Fonts，Satoshi 使用 Fontshare，并统一开启 `display=swap`
- **字号体系：**
  - Hero：72px / clamp(40px, 6vw, 72px)
  - H1：48px
  - H2：32px
  - H3：24px
  - H4：18px
  - Body：16px
  - Small：14px
  - Caption：13px
  - Micro：12px
  - Nano：11px（JetBrains Mono 标签）

## 色彩
- **策略：** 克制使用色彩。amber 只在少数、重要的地方出现。数据和状态承担颜色，chrome 保持中性。
- **Primary（深色模式）：** amber-500 `#F59E0B`，温暖、有能量，看起来像“terminal cursor”
- **Primary（浅色模式）：** amber-600 `#D97706`，在白底上有更好的对比
- **Primary 文字强调（深色模式）：** amber-400 `#FBBF24`
- **Primary 文字强调（浅色模式）：** amber-700 `#B45309`
- **中性色：** 冷调 zinc grays
  - zinc-50：`#FAFAFA`
  - zinc-400：`#A1A1AA`
  - zinc-600：`#52525B`
  - zinc-800：`#27272A`
  - Surface（dark）：`#141414`
  - Base（dark）：`#0C0C0C`
  - Surface（light）：`#FFFFFF`
  - Base（light）：`#FAFAF9`
- **语义色：** success `#22C55E`、warning `#F59E0B`、error `#EF4444`、info `#3B82F6`
- **深色模式：** 默认模式。近黑色 base（`#0C0C0C`），surface 卡片为 `#141414`，边框为 `#262626`
- **浅色模式：** 偏暖的 stone base（`#FAFAF9`），白色卡片表面，stone 边框（`#E7E5E4`）。amber 强调改用 amber-600 以提升对比度。

## 间距
- **基础单位：** 4px
- **密度：** 舒适，不拥挤（不是 Bloomberg Terminal），也不过度宽松（不是典型 marketing site）
- **刻度：** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)

## 布局
- **方式：** dashboard 使用严格网格；landing page 使用更偏 editorial 的 hero 布局
- **Grid：** `lg+` 为 12 列，移动端为单列
- **最大内容宽度：** 1200px（6xl）
- **圆角：** sm: 4px，md: 8px，lg: 12px，full: 9999px
  - Cards / panels：lg（12px）
  - Buttons / inputs：md（8px）
  - Badges / pills：full（9999px）
  - Skill bars：sm（4px）

## 动效
- **策略：** 最小且功能导向，只保留有助于理解界面的过渡。dashboard 的 live feed 本身就是动效的一部分。
- **缓动：** enter（ease-out / cubic-bezier(0.16,1,0.3,1)）、exit（ease-in）、move（ease-in-out）
- **时长：** micro（50-100ms）、short（150ms）、medium（250ms）、long（400ms）
- **动画元素：** live feed dot pulse（2s 无限循环）、skill bar 填充动画（600ms ease-out）、hover 状态（150ms）

## Grain Texture
给整个页面叠一层极其微弱的噪点纹理，提升材质感：
- 深色模式：opacity 0.03
- 浅色模式：opacity 0.02
- 使用 SVG `feTurbulence` 过滤器，挂到 `body::after` 的 CSS background-image 上
- `pointer-events: none`，`position: fixed`，`z-index: 9999`

## 决策记录
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-21 | 初版设计系统 | 由 `/design-consultation` 创建。工业感审美、温暖 amber 强调，以及 Satoshi + DM Sans + JetBrains Mono 的字体组合。 |
| 2026-03-21 | 浅色模式使用 amber-600 | amber-500 在白底上太亮、太发灰；amber-700 又太偏棕。amber-600 刚好。 |
| 2026-03-21 | 加入 grain texture | 为平整的深色表面增加材质感，避免落入“泛 SaaS 模板”的同质化。 |
