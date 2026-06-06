import type { TemplateContext } from '../types';

export function generateAskUserFormat(_ctx: TemplateContext): string {
  return `## AskUserQuestion Format

### Tool resolution (read first)

"AskUserQuestion" can resolve to two tools at runtime: the **host MCP variant** (e.g. \`mcp__conductor__AskUserQuestion\` — appears in your tool list when the host registers it) or the **native** Claude Code tool.

**Rule:** if any \`mcp__*__AskUserQuestion\` variant is in your tool list, prefer it. Hosts may disable native AUQ via \`--disallowedTools AskUserQuestion\` (Conductor does, by default) and route through their MCP variant; calling native there silently fails. Same questions/options shape; same decision-brief format applies.

**If no AskUserQuestion variant appears in your tool list, this skill is BLOCKED.** Stop, report \`BLOCKED — AskUserQuestion unavailable\`, and wait for the user. Do not write decisions to the plan file as a substitute, do not emit them as prose and stop, and do not silently auto-decide (only \`/plan-tune\` AUTO_DECIDE opt-ins authorize auto-picking).

### Format

Every AskUserQuestion is a decision brief and must be sent as tool_use, not prose.

\`\`\`
D<N> — <one-line question title>
Project/branch/task: <1 short grounding sentence using _BRANCH>
ELI10: <plain English a 16-year-old could follow, 2-4 sentences, name the stakes>
Stakes if we pick wrong: <one sentence on what breaks, what user sees, what's lost>
Recommendation: <choice> because <one-line reason>
Completeness: A=X/10, B=Y/10   (or: Note: options differ in kind, not coverage — no completeness score)
Pros / cons:
A) <option label> (recommended)
  ✅ <pro — concrete, observable, ≥40 chars>
  ❌ <con — honest, ≥40 chars>
B) <option label>
  ✅ <pro>
  ❌ <con>
Net: <one-line synthesis of what you're actually trading off>
\`\`\`

D-numbering: first question in a skill invocation is \`D1\`; increment yourself. This is a model-level instruction, not a runtime counter.

ELI10 is always present, in plain English, not function names. Recommendation is ALWAYS present. Keep the \`(recommended)\` label; AUTO_DECIDE depends on it.

Completeness: use \`Completeness: N/10\` only when options differ in coverage. 10 = complete, 7 = happy path, 3 = shortcut. If options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\`

Pros / cons: use ✅ and ❌. Minimum 2 pros and 1 con per option when the choice is real; Minimum 40 characters per bullet. Hard-stop escape for one-way/destructive confirmations: \`✅ No cons — this is a hard-stop choice\`.

Neutral posture: \`Recommendation: <default> — this is a taste call, no strong preference either way\`; \`(recommended)\` STAYS on the default option for AUTO_DECIDE.

Effort both-scales: when an option involves effort, label both human-team and CC+gstack time, e.g. \`(human: ~2 days / CC: ~15 min)\`. Makes AI compression visible at decision time.

Net line closes the tradeoff. Per-skill instructions may add stricter rules.

### Handling 5+ options — split, never drop

AskUserQuestion caps every call at **4 options**. With 5+ real options, NEVER
drop, merge, or silently defer one to fit. Pick a compliant shape:

- **Batch into ≤4-groups** — for coherent alternatives (e.g. version bumps,
  layout variants). One call, 5th surfaced only if first 4 don't fit.
- **Split per-option** — for independent scope items (e.g. "ship E1..E6?").
  Fire N sequential calls, one per option. Default to this when unsure.

Per-option call shape: \`D<N>.k\` header (e.g. D3.1..D3.5), ELI10 per option,
Recommendation, kind-note (no completeness score — Include/Defer/Cut/Hold are
decision actions), and 4 buckets:
**A) Include**, **B) Defer**, **C) Cut**, **D) Hold** (stop chain, discuss).

After the chain, fire \`D<N>.final\` to validate the assembled set (reprompt
dependency conflicts) and confirm shipping it. Use \`D<N>.revise-<k>\` to
revise one option without re-running the chain.

For N>6, fire a \`D<N>.0\` meta-AskUserQuestion first (proceed / narrow / batch).

question_ids for split chains: \`<skill>-split-<option-slug>\` (kebab-case ASCII,
≤64 chars, \`-2\`/\`-3\` suffix on collision). The runtime checker
(\`bin/gstack-question-preference\`) refuses \`never-ask\` on any \`*-split-*\` id,
so split chains are never AUTO_DECIDE-eligible — the user's option set is sacred.

**Full rule + worked examples + Hold/dependency semantics:** see
\`docs/askuserquestion-split.md\` in the gstack repo. Read on demand when N>4.

**Non-ASCII characters — write directly, never \\u-escape.** When any string
field contains Chinese (繁體/簡體), Japanese, Korean, or other non-ASCII text,
emit the literal UTF-8 characters; never escape them as \`\\uXXXX\` (the pipe is
UTF-8 native, and manual escaping miscodes long CJK strings). Only \`\\n\`,
\`\\t\`, \`\\"\`, \`\\\\\` remain allowed. Full rationale + worked example: see
\`docs/askuserquestion-cjk.md\`. Read on demand when a question contains CJK.

### Self-check before emitting

Before calling AskUserQuestion, verify:
- [ ] D<N> header present
- [ ] ELI10 paragraph present (stakes line too)
- [ ] Recommendation line present with concrete reason
- [ ] Completeness scored (coverage) OR kind-note present (kind)
- [ ] Every option has ≥2 ✅ and ≥1 ❌, each ≥40 chars (or hard-stop escape)
- [ ] (recommended) label on one option (even for neutral-posture)
- [ ] Dual-scale effort labels on effort-bearing options (human / CC)
- [ ] Net line closes the decision
- [ ] You are calling the tool, not writing prose
- [ ] Non-ASCII characters (CJK / accents) written directly, NOT \\u-escaped
- [ ] If you had 5+ options, you split (or batched into ≤4-groups) — did NOT drop any
- [ ] If you split, you checked dependencies between options before firing the chain
- [ ] If a per-option Hold fires, you stopped the chain immediately (didn't queue)
`;
}
