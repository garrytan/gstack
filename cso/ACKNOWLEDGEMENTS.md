# CSO research and source versions

CSO v3 separates supported static evidence, reproduction, proposed repair candidates, and current-source closure. The design is informed by [Mozilla's account of hardening Firefox](https://hacks.mozilla.org/2026/05/behind-the-scenes-hardening-firefox/) and [Codex Security's research-preview description](https://openai.com/index/codex-security-now-in-research-preview/): application context and reproducible verification inform the workflow. Their results are not measurements of CSO.

The domain instructions in `sections/audit-phases.md.tmpl` identify the versions they use:

- [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/), including exceptional conditions and the revised supply-chain category.
- [OWASP API Top 10:2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).
- Selected controls from [ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/); requirement IDs must carry their version.
- [OWASP LLM Top 10 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/) and [Agentic Applications Top 10 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), inspected September 9, 2026. Audits record the actual artifact/version used, rather than inferring content from a release announcement.
- [MCP security guidance dated 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).

Execution details follow primary documentation: [Bun compiled executables](https://bun.com/docs/bundler/executables), [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/), [container networking](https://docs.docker.com/engine/network/), [Docker logging](https://docs.docker.com/engine/logging/configure/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [uv CLI](https://docs.astral.sh/uv/reference/cli/), and [RubyGems commands](https://guides.rubygems.org/command-reference/#gem-fetch). Compiling alone does not suppress Bun configuration or runtime injection variables. Offline dependency preparation must exclude local Python builds during acquisition and defer Gemfile evaluation until offline execution.

Earlier CSO work drew on [Trail of Bits' skills](https://github.com/trailofbits/skills) for context building and variant analysis, [Sentry's skills](https://github.com/getsentry/skills) for research before reporting, and the broader community's security-skill reviews. v3 replaces inherited blanket false-positive exclusions and numerical confidence gates with explicit attacker/control/impact evidence and independent challenge.

CSO accuracy, recall, setup success, and repair correctness are release measurements, not inherited vendor benchmark claims. Qualification requires matched models/budgets, held-out assertions, supported setup failures counted as misses, and zero falsely certified repairs. The presence of documentation or an adapter does not mean its runtime image or release gates have passed.
