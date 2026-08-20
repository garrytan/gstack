/**
 * redact-doc — resolvers for the shared redaction docs + invocation bash.
 *
 *   {{REDACT_TAXONOMY_TABLE}}            → markdown table of the 3-tier taxonomy,
 *                                          derived from lib/redact-patterns so /spec
 *                                          and /cso never drift from the engine.
 *   {{REDACT_INVOCATION_BLOCK:<sink>}}   → the canonical scan-at-sink bash + prose
 *                                          for one enforcement point. <sink> is a
 *                                          hyphenated label: pre-codex, pre-issue,
 *                                          pre-archive, pre-pr-body, pre-pr-title,
 *                                          pre-commit.
 *
 * DRY: every skill writes one placeholder per enforcement point; UX/threshold
 * changes land here once. test/redact-doc-resolver.test.ts golden-pins the output.
 */
import type { TemplateContext } from './types';

interface SinkSpec {
  /** What is being scanned, for the prose. */
  noun: string;
  /** What HIGH blocks, in this skill's verbs. */
  blockVerb: string;
}

const SINKS: Record<string, SinkSpec> = {
  'pre-codex': { noun: 'the spec body', blockVerb: 'dispatch to codex' },
  'pre-issue': { noun: "the issue body you're about to file", blockVerb: 'file the issue' },
  'pre-archive': { noun: 'the body about to be archived', blockVerb: 'write the archive' },
  'pre-pr-body': { noun: 'the composed PR body', blockVerb: 'create/edit the PR' },
  'pre-pr-title': { noun: 'the PR title', blockVerb: 'set the PR title' },
  'pre-commit': { noun: 'the generated docs about to be committed', blockVerb: 'commit' },
};

export function generateRedactInvocationBlock(ctx: TemplateContext, args?: string[]): string {
  const sinkLabel = args?.[0] ?? 'pre-issue';
  const brief = args?.[1] === 'brief';
  const sink = SINKS[sinkLabel] ?? SINKS['pre-issue'];
  const bin = `${ctx.paths.binDir}/gstack-redact`;

  // Brief variant: a compact pointer for repeat sinks, so the full ~40-line
  // procedure ships once per skill, not once per enforcement point.
  if (brief) {
    return `#### Redaction scan — ${sinkLabel} (${sink.noun})

Run the SAME scan-at-sink procedure shown above (resolve \`$REDACT_VIS\` once and
reuse it; write the exact bytes to \`$REDACT_FILE\`; \`${bin} --from-file "$REDACT_FILE"
--repo-visibility "$REDACT_VIS" --json\`), now on ${sink.noun}. Apply the same
exit-3/2/0 handling. On exit 3, do NOT ${sink.blockVerb}; HIGH has no skip. Pass the
same \`$REDACT_FILE\` downstream so the bytes scanned are the bytes sent.`;
  }

  return `#### Redaction scan — ${sinkLabel} (${sink.noun})

Scan-at-sink on the EXACT bytes that will be sent: write to a temp file, scan that
file, pass the SAME file downstream. Never scan a string then re-render it.

\`\`\`bash
command -v bun >/dev/null 2>&1 || echo "redaction scan skipped — bun not on PATH"
# Resolve visibility once; cache + reuse. Order: local config (~/.gstack, never
# committed) → gh → glab → unknown(=public-strict).
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null | tr 'A-Z' 'a-z')
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(glab repo view -F json 2>/dev/null | grep -o '"visibility":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//' | tr 'A-Z' 'a-z')
REDACT_VIS="\${REDACT_VIS:-unknown}"
REDACT_FILE=$(mktemp)
cat > "$REDACT_FILE" <<'REDACT_BODY_EOF'
<the exact ${sink.noun} goes here>
REDACT_BODY_EOF
REDACT_JSON=$(${bin} --from-file "$REDACT_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json)
REDACT_CODE=$?
\`\`\`

Branch on \`$REDACT_CODE\`:

1. **Exit 3 (HIGH)** — print findings; do NOT ${sink.blockVerb}; tell the user to
   rotate + redact at source, then re-run. No skip flag for HIGH. Do not persist
   ${sink.noun} anywhere.
2. **Exit 2 (MEDIUM)** — AskUserQuestion per finding (cluster identical ids; PUBLIC
   repos get sterner wording, no batch-acknowledge, no silent-proceed). PII subset
   (\`pii.email\`/\`pii.phone.e164\`/\`pii.ssn\`/\`pii.cc\`) gets **Auto-redact** (re-run
   with \`--auto-redact <ids>\` → use the printed sanitized body) / **Edit** / **Cancel**;
   non-PII MEDIUM gets **Proceed (acknowledged)** / **Edit** / **Cancel** (no auto-redact).
3. **Exit 0 (clean)** — proceed; surface \`WARN\` (tool-fence degrades) + \`LOW\` as a
   one-line FYI (never blocks).

\`\`\`bash
rm -f "$REDACT_FILE"
\`\`\`

Guardrail, not airtight enforcement — direct \`gh\`/\`git\` bypass it; it catches accidents.`;
}
