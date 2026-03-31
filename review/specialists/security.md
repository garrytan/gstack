# Security Specialist 审查清单

范围：当 `SCOPE_AUTH=true`，或（`SCOPE_BACKEND=true` 且 diff > 100 行）时运行  
输出：每行一个 JSON 对象。Schema：
`{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"security","summary":"...","fix":"...","fingerprint":"path:line:security","specialist":"security"}`
如果没有发现：输出 `NO FINDINGS`，不要输出其他内容。

---

这份清单会比主流程中的 CRITICAL pass 更深入。主 agent 已经检查过 SQL injection、race conditions、LLM trust 和 enum completeness。这个 specialist 进一步聚焦 auth / authz 模式、加密误用与攻击面扩展。

## 分类

### 信任边界上的输入校验
- 用户输入在 controller / handler 层直接接受，没有校验
- query parameters 直接进入数据库查询或文件路径
- request body 字段没有类型检查或 schema validation
- 文件上传没有做类型 / 大小 / 内容校验
- 处理 webhook payload 时没有做签名校验

### Auth 与 Authorization 绕过
- endpoint 缺少 authentication middleware（检查路由定义）
- authorization checks 默认 “allow” 而不是 “deny”
- 角色升级路径存在问题（用户可修改自己的 role / permissions）
- Direct object reference 漏洞（用户 A 通过改 ID 访问用户 B 的数据）
- session fixation 或 session hijacking 机会
- token / API key 校验没有检查 expiration

### 注入向量（不止 SQL）
- 子进程调用中，用户可控参数导致 command injection
- 模板注入（Jinja2、ERB、Handlebars）与用户输入混用
- LDAP 查询中的注入
- 用户可控 URL 导致 SSRF（fetch、redirect、webhook target）
- 用户可控文件路径导致 path traversal（如 `../../etc/passwd`）
- 用户可控 HTTP header 值导致 header injection

### 加密误用
- 安全敏感场景下使用弱哈希算法（MD5、SHA1）
- 对 tokens 或 secrets 使用可预测随机数（`Math.random`、`rand()`）
- 用 `==` 这种非常量时间比较 secret、token 或 digest
- 硬编码加密 key 或 IV
- 密码哈希缺少 salt

### Secrets 暴露
- 源码中硬编码 API keys、tokens 或密码（哪怕是在注释里）
- secrets 被打进应用日志或错误信息
- credentials 出现在 URL 里（query 参数或 URL 中的 basic auth）
- 返回给用户的错误响应中带了敏感数据
- 本应加密的 PII 却以明文存储

### 逃逸式 XSS
- Rails：对用户可控数据使用 `.html_safe`、`raw()`
- React：用 `dangerouslySetInnerHTML` 渲染用户内容
- Vue：对用户内容使用 `v-html`
- Django：对用户输入使用 `|safe`、`mark_safe()`
- 通用场景：把未清洗内容直接赋给 `innerHTML`

### 反序列化
- 对不可信数据进行反序列化（pickle、Marshal、`YAML.load`、带可执行类型的 `JSON.parse`）
- 来自用户输入或外部 API 的序列化对象未做 schema validation 就直接接受
