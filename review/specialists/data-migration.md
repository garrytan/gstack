# Data Migration Specialist 审查清单

范围：当 `SCOPE_MIGRATIONS=true` 时运行  
输出：每行一个 JSON 对象。Schema：
`{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"data-migration","summary":"...","fix":"...","fingerprint":"path:line:data-migration","specialist":"data-migration"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

## 分类

### 可回滚性
- 这次 migration 是否能在不丢数据的前提下回滚？
- 是否有对应的 down / rollback migration？
- rollback 真能撤销改动，还是只是 no-op？
- 回滚后会不会让当前应用代码失效？

### 数据丢失风险
- 删除仍有数据的列（应先经历 deprecation period）
- 修改列类型导致数据截断（例如 `varchar(255)` → `varchar(50)`）
- 删除表时，没有确认代码中已无引用
- 重命名列后，没有同步更新所有引用（ORM、raw SQL、views）
- 给已有 NULL 值的列加上 NOT NULL 约束（必须先 backfill）

### 锁时间
- 大表上的 `ALTER TABLE` 没有使用 `CONCURRENTLY`（PostgreSQL）
- 超过 100K 行的表新增索引时没有使用 `CONCURRENTLY`
- 多个 `ALTER TABLE` 本可合并为一次锁获取，却被拆开执行
- 在高峰流量时进行会获取 exclusive lock 的 schema 改动

### Backfill 策略
- 新的 NOT NULL 列没有默认值（需要先 backfill 再加约束）
- 带计算默认值的新列，需要对历史记录分批填充
- 缺少针对历史记录的 backfill script 或 rake task
- backfill 一次性更新全表，而不是分批执行（会锁表）

### 索引创建
- 在生产表上执行 `CREATE INDEX` 却没有 `CONCURRENTLY`
- 重复索引（新索引覆盖了已存在索引的相同列）
- 新的外键列没加索引
- 使用 partial index 或 full index 的选择不合理

### 多阶段安全性
- 某些 migration 必须与应用代码按特定顺序发布
- schema 改动会直接破坏当前运行中的代码（应先发代码，再跑 migration）
- migration 默认依赖部署边界（旧代码 + 新 schema 就会崩）
- 缺少 feature flag 来处理 rolling deploy 中的新旧代码混跑
