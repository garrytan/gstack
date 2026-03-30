/**
 * SAST / linter integration resolver
 *
 * Generates a {{SAST_SCAN}} block that auto-detects project linters and
 * static analysis tools, runs them, and feeds deterministic findings into
 * the LLM review as ground truth.
 */
import type { TemplateContext } from './types';

export function generateSastScan(_ctx: TemplateContext): string {
  return `## Step 3.5: Static Analysis Scan

Before the LLM review begins, run whatever deterministic linters and SAST tools
the project already has configured. These findings are **ground truth** — the LLM
review builds on top of them, not alongside them.

### Detection

Check for tool configs in this order. Run every tool that's detected — they're
complementary, not exclusive.

**JavaScript/TypeScript:**
- \`npx eslint --version 2>/dev/null\` or check \`package.json\` for \`eslint\` in devDependencies
- If ESLint is available, run: \`npx eslint --no-warn-ignored --format json . 2>/dev/null || true\`
- Also check for \`biome.json\` / \`biome.jsonc\` → run \`npx biome check . --reporter json 2>/dev/null || true\`

**Python:**
- Check for \`ruff.toml\`, \`pyproject.toml\` with \`[tool.ruff]\`, or ruff in requirements
- If ruff: \`ruff check --output-format json . 2>/dev/null || true\`
- Else check for flake8: \`flake8 --format json . 2>/dev/null || true\`
- Check for bandit (security): \`bandit -r . -f json 2>/dev/null || true\`
- Check for mypy config → \`mypy --no-error-summary --output json . 2>/dev/null || true\`

**Ruby:**
- Check for \`.rubocop.yml\` → \`rubocop --format json 2>/dev/null || true\`
- Check for \`brakeman\` in Gemfile → \`brakeman -q -f json 2>/dev/null || true\`

**Go:**
- \`go vet ./... 2>&1 || true\`
- Check for \`.golangci.yml\` → \`golangci-lint run --out-format json 2>/dev/null || true\`
- \`gosec -fmt json ./... 2>/dev/null || true\`

**Rust:**
- \`cargo clippy --message-format json 2>/dev/null || true\`

**Universal SAST:**
- Check for \`.semgrep.yml\` or \`.semgrep/\` → \`semgrep scan --json 2>/dev/null || true\`
- Check for \`.gitleaks.toml\` → \`gitleaks detect --no-git --report-format json 2>/dev/null || true\`

### Scope to diff

When possible, scope tool runs to only files changed in the diff. This is faster
and avoids noise from pre-existing issues:

\`\`\`bash
CHANGED_FILES=$(git diff origin/<base> --name-only --diff-filter=ACMR)
\`\`\`

Pass \`$CHANGED_FILES\` to the tool instead of \`.\` when the tool supports file
arguments. If the tool doesn't support file arguments, run against the full project
but filter output to only changed files.

### Output handling

1. Parse JSON output from each tool
2. Deduplicate — if ESLint and Semgrep both flag the same file:line, keep the more specific one
3. Filter to files in the diff (ignore pre-existing issues in unchanged files)
4. Store findings as a structured list for use in Step 4

### Integration with LLM review

Present SAST findings at the top of the Step 4 output, BEFORE the LLM's own findings:

\`\`\`
STATIC ANALYSIS (deterministic):
  Tool          Findings (in diff)
  ─────         ──────────────────
  eslint        3 errors, 2 warnings
  semgrep       1 finding

  [eslint] src/api/handler.ts:42 — no-unused-vars: 'response' is defined but never used
  [eslint] src/api/handler.ts:88 — @typescript-eslint/no-explicit-any: Unexpected any
  [semgrep] src/api/handler.ts:55 — javascript.lang.security.audit.sqli: SQL injection risk
\`\`\`

The LLM review in Step 4 should:
- **NOT re-flag** issues already caught by SAST tools (no double-counting)
- **ADD context** to SAST findings where useful (e.g., "the semgrep SQLi finding at :55 is
  a real risk because the input comes from req.body without validation at :30")
- **Focus LLM review on what tools can't catch** — architectural issues, race conditions,
  business logic errors, scope drift, missing error handling patterns

If no tools are detected or all tools fail to run, note it briefly and proceed:
\`\`\`
STATIC ANALYSIS: No linters/SAST tools detected. Consider adding eslint, semgrep, or equivalent.
\`\`\`

Do NOT block the review if tools aren't available. The LLM review is the fallback.`;
}

export function generateSastScanCso(_ctx: TemplateContext): string {
  return `### Phase 3.5: Deterministic SAST Scan

Before the LLM-driven OWASP and STRIDE analysis, run whatever static analysis
and security scanning tools the project has available. These produce deterministic
findings that anchor the rest of the audit.

**Detection and execution:** Same tool detection as described above — check for
ESLint, Biome, ruff, bandit, Brakeman, gosec, cargo clippy, Semgrep, gitleaks.
Run every available tool against the full project (not scoped to diff, since /cso
audits the whole codebase).

**Integration with later phases:**
- Feed SAST findings into Phase 9 (OWASP) as confirmed evidence. A Semgrep SQLi finding
  in Phase 3.5 becomes a VERIFIED A03:Injection finding in Phase 9.
- Feed security-specific findings (bandit, brakeman, gosec, semgrep) into Phase 12
  as pre-verified — they skip the confidence gate since they're deterministic.
- Note which tools were available vs skipped in the final report under
  \`supply_chain_summary.tools_run\` and \`supply_chain_summary.tools_skipped\`.

If no security tools are detected, recommend specific tools for the detected stack
in the Phase 13 remediation roadmap:
- JS/TS → eslint-plugin-security + semgrep
- Python → bandit + ruff
- Ruby → brakeman
- Go → gosec + golangci-lint with security linters
- Rust → cargo-audit + cargo clippy
- Any stack → semgrep (language-agnostic rules)`;
}
