# API Contract Specialist 审查清单

范围：当 `SCOPE_API=true` 时运行  
输出：每行一个 JSON 对象。Schema：
`{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"api-contract","summary":"...","fix":"...","fingerprint":"path:line:api-contract","specialist":"api-contract"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

## 分类

### Breaking Changes
- 从 response body 中移除了字段（客户端可能依赖这些字段）
- 改变字段类型（例如 string → number，object → array）
- 给已有 endpoint 新增了必填参数
- 修改 HTTP method（GET → POST）或 status code（200 → 201）
- 重命名 endpoint 却没有保留旧路径作为 redirect / alias
- 改变鉴权要求（public → authenticated）

### Versioning 策略
- 存在 breaking changes 却没有 bump version（v1 → v2）
- 同一个 API 里混用了多种 versioning 方式（URL、header、query param）
- deprecated endpoints 没有 sunset timeline 或 migration guide
- version-specific 逻辑分散在各个 controller 中，而不是集中处理

### 错误 Response Consistency
- 新 endpoint 返回的错误格式与现有接口不一致
- 错误响应缺少标准字段（error code、message、details）
- HTTP status code 与错误类型不匹配（例如错误却返回 200，验证失败却返回 500）
- 错误消息泄露内部实现细节（stack trace、SQL）

### Rate Limiting 与 Pagination
- 新 endpoint 在同类接口已有 rate limit 的情况下却没有限制
- 分页方式发生变化（offset → cursor）但没有向后兼容
- 默认 page size 或 limit 变化却没有文档说明
- 分页响应缺少 total count 或 next-page 信息

### Documentation Drift
- OpenAPI / Swagger 没有同步更新新 endpoint 或参数变化
- README 或 API docs 仍描述旧行为
- 示例请求 / 响应已经无法工作
- 新 endpoint 或改动参数没有任何文档

### Backwards Compatibility
- 旧版本客户端是否会直接挂掉？
- 无法强制升级的 mobile apps 是否还能正常工作？
- webhook payload 发生变化却没有通知订阅方
- 使用新功能是否需要同步修改 SDK 或 client library？
