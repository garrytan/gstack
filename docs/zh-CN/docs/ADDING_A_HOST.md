# 向 gstack 添加新的宿主

gstack 使用声明式宿主配置系统。每个受支持的 AI 编程智能体（Claude、Codex、Factory、Kiro、OpenCode、Slate、Cursor、OpenClaw）都被定义为一个类型化的 TypeScript 配置对象。添加新宿主意味着创建一个文件并重新导出它。生成器、安装程序或工具无需任何代码改动。

## 工作原理

```
hosts/
├── claude.ts        # 主要宿主
├── codex.ts         # OpenAI Codex CLI
├── factory.ts       # Factory Droid
├── kiro.ts          # Amazon Kiro
├── opencode.ts      # OpenCode
├── slate.ts         # Slate（Random Labs）
├── cursor.ts        # Cursor
├── openclaw.ts      # OpenClaw（混合模式：配置 + 适配器）
└── index.ts         # 注册表：导入全部，派生 Host 类型
```

每个配置文件导出一个 `HostConfig` 对象，告诉生成器：
- 将生成的技能放在哪里（路径）
- 如何转换前置元数据（允许/拒绝字段）
- 要重写哪些 Claude 特定的引用（路径、工具名称）
- 要检测哪个二进制文件用于自动安装
- 要抑制哪些解析器节
- 安装时要创建哪些资源符号链接

生成器、安装脚本、平台检测、卸载、健康检查、工作树复制和测试都从这些配置中读取。它们都没有每宿主的代码。

## 分步指南：添加新宿主

### 1. 创建配置文件

复制一个现有配置作为起点。`hosts/opencode.ts` 是一个简洁的极简示例。`hosts/factory.ts` 展示了工具重写和条件字段。`hosts/openclaw.ts` 展示了对工具模型不同的宿主的适配器模式。

创建 `hosts/myhost.ts`：

```typescript
import type { HostConfig } from '../scripts/host-config';

const myhost: HostConfig = {
  name: 'myhost',
  displayName: 'MyHost',
  cliCommand: 'myhost',        // 用于 `command -v` 检测的二进制名称
  cliAliases: [],              // 替代二进制名称

  globalRoot: '.myhost/skills/gstack',
  localSkillRoot: '.myhost/skills/gstack',
  hostSubdir: '.myhost',
  usesEnvVars: true,           // 仅 Claude 为 false（使用字面 ~ 路径）

  frontmatter: {
    mode: 'allowlist',         // 'allowlist' 只保留列出的字段
    keepFields: ['name', 'description'],
    descriptionLimit: null,    // 对有限制的宿主设置为 1024
  },

  generation: {
    generateMetadata: false,   // 仅 Codex 为 true（openai.yaml）
    skipSkills: ['codex'],     // codex 技能仅适用于 Claude
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.myhost/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.myhost/skills/gstack' },
    { from: '.claude/skills', to: '.myhost/skills' },
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: { 'review': ['checklist.md', 'TODOS-format.md'] },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default myhost;
```

### 2. 在索引中注册

编辑 `hosts/index.ts`：

```typescript
import myhost from './myhost';

// 添加到 ALL_HOST_CONFIGS 数组：
export const ALL_HOST_CONFIGS: HostConfig[] = [
  claude, codex, factory, kiro, opencode, slate, cursor, openclaw, myhost
];

// 添加到重导出：
export { claude, codex, factory, kiro, opencode, slate, cursor, openclaw, myhost };
```

### 3. 添加到 .gitignore

将 `.myhost/` 添加到 `.gitignore`（生成的技能文档会被忽略）。

### 4. 生成并验证

```bash
# 为新宿主生成技能文档
bun run gen:skill-docs --host myhost

# 验证输出存在且没有 .claude/skills 泄漏
ls .myhost/skills/gstack-*/SKILL.md
grep -r ".claude/skills" .myhost/skills/ | head -5
# （应该为空）

# 为所有宿主生成（包括新的那个）
bun run gen:skill-docs --host all

# 健康看板显示新宿主
bun run skill:check
```

### 5. 运行测试

```bash
bun test test/gen-skill-docs.test.ts
bun test test/host-config.test.ts
```

参数化冒烟测试会自动接收新宿主。无需编写测试代码。它们会验证：输出存在，没有路径泄漏，前置元数据有效，新鲜度检查通过，codex 技能被排除。

### 6. 更新 README.md

在适当的部分为新宿主添加安装说明。

## 配置字段参考

有关带 JSDoc 注释的完整 `HostConfig` 接口，请参阅 `scripts/host-config.ts`。

关键字段：

| 字段 | 用途 |
|------|-----|
| `frontmatter.mode` | `allowlist`（只保留列出的）或 `denylist`（去掉列出的）|
| `frontmatter.descriptionLimit` | 最大字符数，`null` 表示无限制 |
| `frontmatter.descriptionLimitBehavior` | `error`（构建失败）、`truncate`、`warn` |
| `frontmatter.conditionalFields` | 根据模板值添加字段（例如，sensitive → disable-model-invocation）|
| `frontmatter.renameFields` | 重命名模板字段（例如，voice-triggers → triggers）|
| `pathRewrites` | 对内容执行字面 replaceAll。顺序很重要。 |
| `toolRewrites` | 重写 Claude 工具名称（例如，"use the Bash tool" → "run this command"）|
| `suppressedResolvers` | 对此宿主返回空的解析器函数 |
| `coAuthorTrailer` | 提交的 Git 共同作者字符串 |
| `boundaryInstruction` | 跨模型调用的反提示注入警告 |
| `adapter` | 用于复杂转换的适配器模块路径 |

## 适配器模式（适用于工具模型不同的宿主）

如果字符串替换工具重写还不够（宿主有根本不同的工具语义），请使用适配器模式。参见 `hosts/openclaw.ts` 和 `scripts/host-adapters/openclaw-adapter.ts`。

适配器在所有通用重写之后作为后处理步骤运行。它导出 `transform(content: string, config: HostConfig): string`。

## 验证

`scripts/host-config.ts` 中的 `validateHostConfig()` 函数会检查：
- 名称：小写字母、数字和连字符
- CLI 命令：字母数字加连字符/下划线
- 路径：仅安全字符（字母数字、`.`、`/`、`$`、`{}`、`~`、`-`、`_`）
- 跨配置没有重复的名称、hostSubdirs 或 globalRoots

运行 `bun run scripts/host-config-export.ts validate` 检查所有配置。
