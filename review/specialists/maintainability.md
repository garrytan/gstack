# Maintainability Specialist 审查清单

范围：常驻（每次 review 都运行）  
输出：每行一个 JSON 对象。Schema：
`{"severity":"INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"maintainability","summary":"...","fix":"...","fingerprint":"path:line:maintainability","specialist":"maintainability"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

## 分类

### Dead Code 与未使用导入
- 在改动文件中赋值但从未读取的变量
- 定义了但从未调用的函数 / 方法（要用 Grep 在整个仓库确认）
- 这次改动后已经不再使用的 imports / requires
- 被注释掉的代码块（要么删掉，要么解释为什么保留）

### Magic Numbers 与字符串耦合
- 逻辑里直接写裸数字（阈值、限制、重试次数）—— 应提取成具名常量
- 错误消息字符串在其他地方被拿来做查询条件或判断
- 硬编码 URL、端口或主机名，本该走配置
- 多个文件里重复出现同样的字面量

### 过时注释与 Docstrings
- 注释描述的是旧行为，而代码在本次 diff 中已经改了
- TODO / FIXME 注释还在引用已经完成的工作
- Docstring 的参数列表和当前函数签名不一致
- 注释里的 ASCII 图已经和实际代码流程不一致

### DRY 违例
- diff 中多个地方出现相似代码块（3 行以上）
- 明显的复制粘贴模式，本应抽成共享 helper
- 测试文件之间重复的配置或 setup 逻辑
- 反复出现的条件分支链，其实更适合用 lookup table 或 map

### 条件分支下的副作用缺失
- 某段逻辑按条件分支，但某个分支遗漏了必要副作用
- 日志里声称某个动作已发生，实际上该动作在某些分支被跳过
- 状态迁移中，一个分支会更新关联记录，另一个不会
- 事件只在 happy path 上被发出，错误 / 边界路径上完全缺失

### 模块边界违规
- 直接访问其他模块的内部实现（例如调用按约定应视为私有的方法）
- controller / view 直接查数据库，而不是通过 service / model
- 本应通过接口通信的组件被紧耦合在一起
