# 致谢

`/cso v2` 的设计参考了大量安全审计领域的研究成果。特别感谢：

- **[Sentry Security Review](https://github.com/getsentry/skills)** —— 他们基于置信度的报告系统（只有 HIGH confidence 的问题才会上报）以及 “research before reporting” 方法（追踪数据流、检查上游校验）验证了我们 8/10 的日常置信门槛。TimOnWeb 在测试 5 个安全 skill 后，认为它是唯一值得安装的一个。
- **[Trail of Bits Skills](https://github.com/trailofbits/skills)** —— 他们“先建立审计上下文，再开始找 bug”的方法直接启发了我们的 Phase 0。其 variant analysis 概念（找到一个漏洞后，在整个代码库中搜索相同模式）也启发了我们在 Phase 12 中加入 variant analysis。
- **[Shannon by Keygraph](https://github.com/KeygraphHQ/shannon)** —— 这个自主 AI pentester 在 XBOW benchmark 上取得了 96.15%（104 个 exploit 中命中 100 个）。它证明了 AI 可以做真正的安全测试，而不只是跑 checklist。我们在 Phase 12 中的主动验证，就是 Shannon 实时测试方式在静态分析场景中的映射。
- **[afiqiqmal/claude-security-audit](https://github.com/afiqiqmal/claude-security-audit)** —— 他们对 AI / LLM 特定安全问题的检查（prompt injection、RAG poisoning、tool calling permissions）启发了我们的 Phase 7。他们的框架级自动识别（比如直接识别 “Next.js” 而不是只识别 “Node/TypeScript”）启发了我们在 Phase 0 中加入 framework detection。
- **[Snyk ToxicSkills Research](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/)** —— 他们发现 36% 的 AI agent skills 存在安全缺陷、13.4% 带有恶意，这直接启发了我们的 Phase 8（Skill Supply Chain 扫描）。
- **[Daniel Miessler's Personal AI Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure)** —— 其中的事件响应 playbooks 和 protection file 概念，对我们的 remediation 与 LLM 安全阶段有很大影响。
- **[McGo/claude-code-security-audit](https://github.com/McGo/claude-code-security-audit)** —— 他们关于生成可分享报告与可执行 epic 的思路，推动了我们报告格式的演化。
- **[Claude Code Security Pack](https://dev.to/myougatheaxo/automate-owasp-security-audits-with-claude-code-security-pack-4mah)** —— 它的模块化方法（拆成 `/security-audit`、`/secret-scanner`、`/deps-check` 等多个 skill）证明这些确实是不同问题域。我们的统一方案则是在牺牲模块化的前提下，换取跨阶段推理能力。
- **[Anthropic Claude Code Security](https://www.anthropic.com/news/claude-code-security)** —— 其多阶段验证与置信度评分，验证了我们并行发现校验方法的合理性。他们在开源项目中发现了 500+ 个 zero-days。
- **[@gus_argon](https://x.com/gus_aragon/status/2035841289602904360)** —— 他指出了 v1 的关键盲点：没有 stack detection（导致所有语言模式一起跑）、使用 bash grep 而不是 Claude Code 的 Grep tool、`| head -20` 会悄悄截断结果，以及 preamble 过于臃肿。这些直接塑造了 v2 的 stack-first 方法和 Grep tool 强制策略。
