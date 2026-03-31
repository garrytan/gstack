# QA 问题分类法

## 严重级别

| Severity | 定义 | 示例 |
|----------|------|------|
| **critical** | 阻塞核心工作流、导致数据丢失，或让应用崩溃 | 提交表单直接进入 error page、结账流程损坏、未确认就删除数据 |
| **high** | 重要功能损坏或不可用，且没有 workaround | 搜索结果错误、文件上传静默失败、认证重定向死循环 |
| **medium** | 功能还能工作，但存在明显问题，且有 workaround | 页面加载很慢（>5s）、表单缺少校验但仍能提交、布局只在移动端坏掉 |
| **low** | 轻微的视觉或打磨问题 | footer 里有错字、1px 对齐问题、hover 状态不一致 |

## 分类

### 1. Visual / UI
- 布局损坏（元素重叠、文字被裁切、出现水平滚动条）
- 图片损坏或缺失
- z-index 错误（元素被盖在别人后面）
- 字体 / 颜色不一致
- 动画故障（卡顿、过渡不完整）
- 对齐问题（不在网格上、间距不均）
- Dark mode / theme 问题

### 2. Functional
- 链接损坏（404、跳错位置）
- 死按钮（点击无反应）
- 表单校验问题（缺失、错误、可绕过）
- 错误重定向
- 状态不持久（刷新后数据丢失、返回按钮丢状态）
- Race conditions（重复提交、旧数据覆盖）
- 搜索返回错误结果或完全无结果

### 3. UX
- 导航让人迷惑（没有 breadcrumbs、走进死胡同）
- 缺少 loading indicators（用户不知道系统正在处理）
- 交互响应过慢（>500ms 仍无反馈）
- 错误提示含糊（只有 “Something went wrong”，没有上下文）
- 破坏性操作前没有确认
- 页面间交互模式不一致
- 死路（没有返回方式，也没有下一步动作）

### 4. Content
- 拼写与语法错误
- 文字过时或错误
- 残留 placeholder / lorem ipsum 文本
- 文本被截断（没有省略号，也没有 “more”）
- 按钮或表单标签错误
- 缺失或质量很差的 empty states

### 5. Performance
- 页面加载过慢（>3 秒）
- 滚动卡顿（掉帧）
- Layout shift（内容加载后跳动）
- 单页网络请求过多（>50）
- 图片过大且未优化
- 阻塞式 JavaScript（加载时页面无响应）

### 6. Console / Errors
- JavaScript exceptions（未捕获错误）
- 失败的网络请求（4xx、5xx）
- Deprecation warnings（未来会导致 breakage）
- CORS errors
- Mixed content warnings（HTTPS 页面中加载 HTTP 资源）
- CSP violations

### 7. Accessibility
- 图片缺少 alt text
- 表单输入缺少 label
- 键盘导航损坏（无法 tab 到元素）
- Focus trap（无法从 modal 或 dropdown 中退出）
- 缺少或错误的 ARIA attributes
- 颜色对比度不足
- 屏幕阅读器无法到达内容

## 每页探索清单

在 QA session 中访问每个页面时，都执行以下检查：

1. **视觉扫描** —— 使用带标注截图（`snapshot -i -a -o`）。检查布局问题、坏图、对齐问题。
2. **交互元素** —— 点击每个按钮、链接和控件。它们是否真的按文案所说工作？
3. **表单** —— 填写并提交。测试空提交、非法数据和边界输入（超长文本、特殊字符）。
4. **导航** —— 检查所有进入与离开路径，包括 breadcrumbs、返回按钮、deep links、移动端菜单。
5. **状态** —— 检查 empty state、loading state、error state，以及 full / overflow state。
6. **Console** —— 交互后运行 `console --errors`。是否出现新的 JS errors 或失败请求？
7. **响应式** —— 如果相关，检查移动端与平板 viewport。
8. **Auth 边界** —— 登出后会怎样？不同用户角色下会怎样？
