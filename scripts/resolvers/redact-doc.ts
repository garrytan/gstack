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
import { PATTERNS, type Tier } from '../../lib/redact-patterns';

// Representative example/prefix per pattern for the human-readable table. Keeps
// lib/redact-patterns clean (no doc strings) while ensuring the recognizable
// prefixes (AKIA, ghp_, sk-ant-, sk-, BEGIN) appear in the generated docs.
const EXAMPLE: Record<string, string> = {
  'aws.access_key': 'AKIA…',
  'aws.secret_key': '40-char base64 near aws_secret_access_key',
  'github.pat': 'ghp_…',
  'github.oauth': 'gho_…',
  'github.server': 'ghs_…',
  'github.fine_grained': 'github_pat_…',
  'anthropic.key': 'sk-ant-…',
  'openai.key': 'sk-… / sk-proj-…',
  'sendgrid.key': 'SG.x.y',
  'stripe.secret': 'sk_live_…',
  'slack.token': 'xoxb-/xoxp-…',
  'slack.webhook': 'hooks.slack.com/services/…',
  'discord.webhook': 'discord.com/api/webhooks/…',
  'twilio.auth_token': '32-hex near an AC… SID',
  'pem.private_key': '-----BEGIN … PRIVATE KEY-----',
  'db.url_with_password': 'postgres://user:pw@host',
  'creds.basic_auth_url': 'https://user:pw@host',
  'stripe.publishable': 'pk_live_…',
  'google.api_key': 'AIza…',
  'jwt': 'eyJ….eyJ….sig',
  'env.kv': 'FOO_SECRET=<high-entropy>',
  'pii.email': 'name@host.tld',
  'pii.phone.e164': '+1 415 555 0123',
  'pii.ssn': '123-45-6789',
  'pii.cc': 'Luhn-valid 13-19 digits',
  'pii.ip_public': 'public IPv4',
  'pii.wallet': '0x… / bc1… / 1…',
  'internal.hostname': 'host.corp / host.internal',
  'internal.url_private': 'http://localhost:PORT/path',
  'legal.nda_marker': 'CONFIDENTIAL / UNDER NDA',
  'legal.named_criticism': 'negative judgment + a full name',
  'internal.user_path': '/Users/<name>/… , /home/<name>/…',
  'hygiene.todo': 'TODO(owner)',
};

const TIER_BLURB: Record<Tier, string> = {
  HIGH: 'HIGH — genuinely-secret credentials. Blocks dispatch/file/edit/commit.',
  MEDIUM:
    'MEDIUM — PII, legal/damaging, internal-leak, and high-FP credential-shaped ' +
    'patterns. AskUserQuestion to confirm (sterner on public repos); never auto-blocked.',
  LOW: 'LOW — surfaced as an FYI, never blocks.',
};

export function generateRedactTaxonomyTable(_ctx: TemplateContext, args?: string[]): string {
  // Compact mode: HIGH-tier rows only (the credentials that BLOCK), one line of
  // prose for MEDIUM/LOW. For skills that RUN redaction (e.g. /spec) but aren't
  // the security catalog — they need to know what blocks + where the full list
  // is, not inline all ~30 patterns. /cso renders the full table.
  const compact = args?.[0] === 'compact';
  const out: string[] = [];

  const tiers: Tier[] = compact ? ['HIGH'] : ['HIGH', 'MEDIUM', 'LOW'];
  for (const tier of tiers) {
    out.push(`**${TIER_BLURB[tier]}**`, '');
    out.push('| ID | Catches | Example |');
    out.push('|----|---------|---------|');
    for (const p of PATTERNS.filter((x) => x.tier === tier)) {
      out.push(`| \`${p.id}\` | ${p.description} | ${EXAMPLE[p.id] ?? '—'} |`);
    }
    out.push('');
  }

  if (compact) {
    out.push(
      'MEDIUM (PII / legal / internal + high-FP credential shapes like ' +
        '`pk_live_`/`AIza`/JWT/`*_KEY=`) confirms via AskUserQuestion; LOW surfaces ' +
        'as an FYI. Full taxonomy: `lib/redact-patterns.ts` (or `/cso`).',
    );
  } else {
    out.push(
      'Calibration: a gate that cries wolf gets ignored, so context-variable / ' +
        'high-FP credential shapes (Stripe publishable `pk_live_`, Google `AIza`, ' +
        'JWTs, env-style `*_KEY=`) sit at MEDIUM, not HIGH. The full taxonomy lives ' +
        'in `lib/redact-patterns.ts` and this table is generated from it.',
    );
  }
  return out.join('\n');
}

// ── Invocation block (scan-at-sink) ──────────────────────────────────────────

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
