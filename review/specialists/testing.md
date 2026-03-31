# Testing Specialist 审查清单

范围：常驻（每次 review 都运行）  
输出：每行一个 JSON 对象。Schema：
`{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"testing","summary":"...","fix":"...","fingerprint":"path:line:testing","specialist":"testing"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

## 分类

### 缺失负路径测试
- 新代码里处理错误、拒绝、非法输入的路径，没有任何对应测试
- Guard clauses 和 early returns 没有被覆盖
- try/catch、rescue 或 error boundaries 里的错误分支没有 failure-path 测试
- 代码里有 permission / auth 检查，但没有 “denied” 场景测试

### 缺失边界情况覆盖
- 边界值：0、负数、max-int、空字符串、空数组、nil/null/undefined
- 单元素集合（容易出现循环 off-by-one）
- 用户输入中的 Unicode 与特殊字符
- 并发访问模式没有任何 race-condition 测试

### 测试隔离性违规
- 多个测试共享可变状态（类变量、全局单例、未清理的 DB 记录）
- 测试依赖执行顺序（串行能过，打乱顺序就挂）
- 测试依赖系统时钟、时区或 locale
- 测试直接访问真实网络，而不是使用 stubs / mocks

### Flaky 测试模式
- 基于时间的断言（sleep、setTimeout、超短 waitFor）
- 断言无序结果的顺序（哈希键、Set 迭代、异步返回顺序）
- 无兜底就依赖外部服务（API、数据库）
- 使用随机测试数据但没有固定 seed

### 缺失安全策略测试
- controllers 里有 auth / authz 检查，但没有未授权场景测试
- 有 rate limiting 逻辑，但没有证明其真的会拦截的测试
- 有输入清洗逻辑，但没有恶意输入测试
- 有 CSRF / CORS 配置，但没有 integration test

### 覆盖率空洞
- 新 public methods / functions 完全没有测试覆盖
- 已修改的方法，现有测试只覆盖旧行为，没有覆盖新分支
- 被多个地方调用的 utility functions 只被间接测试，没有直接测试
