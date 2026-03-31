# Performance Specialist 审查清单

范围：当 `SCOPE_BACKEND=true` 或 `SCOPE_FRONTEND=true` 时运行  
输出：每行一个 JSON 对象。Schema：
`{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"performance","summary":"...","fix":"...","fingerprint":"path:line:performance","specialist":"performance"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

## 分类

### N+1 Queries
- ActiveRecord / ORM 关联在循环中遍历，但没有 eager loading（`.includes`、`joinedload`、`include`）
- 在迭代块（`each`、`map`、`forEach`）内部执行数据库查询，本可批量处理
- 嵌套 serializer 触发 lazy-loaded associations
- GraphQL resolver 按字段逐个查询，而不是批量处理（检查是否用了 DataLoader）

### 缺失数据库索引
- 新增 WHERE 条件落在无索引列上（检查 migration 或 schema）
- 新增 `ORDER BY` 使用了无索引列
- 复合查询（`WHERE a AND b`）缺少 composite indexes
- 新增外键列但没有索引

### 算法复杂度
- O(n^2) 或更差的模式：集合上的嵌套循环、在 `Array.map` 里不断 `Array.find`
- 重复线性查找，本可用 hash / map / set
- 在循环里做字符串拼接（应改用 join 或 StringBuilder）
- 大集合被多次排序或过滤，而实际上一次就够

### Bundle Size 影响（前端）
- 新增已知较重的生产依赖（如 moment.js、完整 lodash、jquery）
- 使用 barrel import（`import from 'library'`）而不是 deep import（`import from 'library/specific'`）
- 提交了未经优化的大型静态资源（图片、字体）
- 路由级 chunks 缺失 code splitting

### Rendering Performance（前端）
- Fetch waterfalls：本可并行的 API 调用却被串行执行（应考虑 `Promise.all`）
- 由于不稳定引用（render 中不断新建对象 / 数组）导致不必要的 re-render
- 缺少对昂贵计算的 `React.memo`、`useMemo` 或 `useCallback`
- 在循环中反复读取再写入 DOM，造成 layout thrashing
- 折叠以下图片缺少 `loading="lazy"`

### 缺失分页
- 列表接口返回无上限结果（没有 LIMIT 或分页参数）
- 会随数据规模持续膨胀的数据库查询，却没有 LIMIT
- API 响应直接嵌入完整嵌套对象，而不是使用 ID + expansion 机制

### Async 上下文中的阻塞
- 在 async 函数里执行同步 I/O（文件读取、子进程、HTTP 请求）
- 在事件循环型 handler 中使用 `time.sleep()` / `Thread.sleep()`
- CPU 密集计算阻塞主线程，却没有 offload 到 worker
