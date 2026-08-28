import type { TemplateContext } from '../types';

export function generateAskUserFormat(ctx: TemplateContext): string {
  return `## AskUserQuestion Format

### Tool resolution (read first)

Branch on the skill-start STATUS lines, in this order:

1. **\`CONDUCTOR_SESSION: true\` echoed** → do NOT call AskUserQuestion at all (neither native nor any \`mcp__*__AskUserQuestion\` variant): render EVERY decision brief as the **prose form** below and STOP. Proactive, not a failure reaction — Conductor disables native AUQ and its MCP variant is flaky (\`[Tool result missing due to internal error]\`). **Auto-decide preferences still apply first:** a surfaced \`[plan-tune auto-decide] <id> → <option>\` result means proceed with that option, no prose — enforced HERE since no tool call ever happens. Capture each Conductor prose brief with \`bin/gstack-question-log\` (the PostToolUse hook never fires on a prose path; \`/plan-tune\` learning depends on it).
2. **Any \`mcp__*__AskUserQuestion\` variant in your tool list** → prefer it (hosts may disable native via \`--disallowedTools\`; calling native there silently fails). Same shape, same decision-brief format.
3. **Unavailable (no variant) OR a call fails** → do NOT silently auto-decide or write the decision to the plan file as a substitute; follow the **failure fallback** below.

### When AskUserQuestion is unavailable or a call fails

Tell three outcomes apart:

1. **Auto-decide denial (NOT a failure).** The result contains \`[plan-tune auto-decide] <id> → <option>\` — the preference hook working as designed. Proceed with that option. Do NOT retry, do NOT fall back to prose.
2. **Genuine failure** — no variant in your tool list, OR the variant is present but the call returns an error / missing result (MCP transport error, empty result, host bug — e.g. Conductor's MCP AskUserQuestion is flaky and returns \`[Tool result missing due to internal error]\`).
   - If it was present and **errored** (not absent), retry the SAME call **once** — but only if no answer could have surfaced (a missing-result error can arrive after the user already saw the question; retrying would double-prompt, so if it may have reached them, treat as pending, don't retry).
   - Then branch on \`SESSION_KIND\` (echoed by the preamble; empty/absent ⇒ \`interactive\`):
     - \`spawned\` → defer to the **Spawned session** block: auto-choose the recommended option. Never prose, never BLOCKED.
     - \`headless\` → \`BLOCKED — AskUserQuestion unavailable\`; stop and wait (no human can answer).
     - \`interactive\` → **prose fallback** (below).

**Prose fallback — render the decision brief as a markdown message, not a tool call.** Same information as the tool format below, different structure (paragraphs, not ✅/❌ bullets). It MUST surface this triad:

1. **A clear ELI10 of the issue itself** — plain English on what's being decided and why it matters (the question, not per-choice), naming the stakes. Lead with it.
2. **Completeness scores per choice** — explicit \`Completeness: X/10\` on EACH choice (10 complete, 7 happy-path, 3 shortcut); use the kind-note when options differ in kind not coverage, but never silently drop the score.
3. **The recommendation and why** — a \`Recommendation: <choice> because <reason>\` line plus the \`(recommended)\` marker on that choice.

Layout: a \`D<N>\` title + a one-line note to reply with a letter (in Conductor this is the normal path; elsewhere it means AskUserQuestion was unavailable or errored); the issue ELI10; the Recommendation line; then ONE paragraph per choice carrying its \`(recommended)\` marker, its \`Completeness: X/10\`, and 2-4 sentences of reasoning — never a bare bullet list; a closing \`Net:\` line. Split chains / 5+ options: one prose block per per-option call, in sequence. Then STOP and wait — the user's typed answer is the decision. In plan mode this satisfies end-of-turn like a tool call.

**Continuation — mapping a typed reply back to a brief.** Each brief carries a stable label (\`D<N>\`, or \`D<N>.k\` in a split chain). The user references it (e.g. "3.2: B"). A bare letter maps to the single most-recent UNANSWERED brief; if more than one is open (a split chain), do NOT guess — ask which \`D<N>.k\` it answers. Never apply a bare letter ambiguously across a chain.

**One-way / destructive confirmations in prose.** When the decision is a one-way door (irreversible or destructive — delete, force-push, drop, overwrite), prose is a WEAKER gate than the tool, so make it stronger: require an explicit typed confirmation (the exact option letter or word), state plainly what is irreversible, and NEVER proceed on a vague, partial, or ambiguous reply — re-ask instead. Treat silence or "ok"/"sure" without the explicit choice as not-yet-confirmed.

### Format

Every AskUserQuestion is a decision brief and must be sent as tool_use, not prose — unless the documented failure fallback above applies (interactive session + the call is unavailable/erroring), in which case the prose fallback is the correct output.

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
drop, merge, or silently defer one to fit: **batch into ≤4-groups** (coherent
alternatives) or **split per-option** (independent scope items — the default
when unsure): sequential \`D<N>.k\` calls, each with its ELI10, Recommendation,
kind-note, and buckets **A) Include, B) Defer, C) Cut, D) Hold** (stop chain,
discuss); a \`D<N>.final\` validates the assembled set; for N>6 fire a
\`D<N>.0\` meta-question first. Split question_ids: \`<skill>-split-<option-slug>\`
(kebab-case ASCII, ≤64 chars) — the runtime checker (\`bin/gstack-question-preference\`) refuses \`never-ask\` on
any \`*-split-*\` id, so split chains are never AUTO_DECIDE-eligible: the
user's option set is sacred.

**Full rule + worked examples + Hold/dependency semantics:**
\`${ctx.paths.skillRoot}/docs/askuserquestion-split.md\`. Read on demand when N>4.

**Non-ASCII characters — write directly, never \\u-escape.** Emit literal
UTF-8 for Chinese (繁體/簡體), Japanese, Korean, or any non-ASCII text; never
\`\\uXXXX\`-escape it (the pipe is UTF-8 native; manual escaping miscodes long
CJK strings). Only \`\\n\`, \`\\t\`, \`\\"\`, \`\\\\\` remain allowed. Full rationale +
worked example: Read \`${ctx.paths.skillRoot}/docs/askuserquestion-cjk.md\`
on demand when a question contains CJK.

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
- [ ] You are calling the tool, not writing prose — unless \`CONDUCTOR_SESSION: true\` (then prose is the DEFAULT, not the tool) OR the documented failure fallback applies (then: prose with the mandatory triad — issue ELI10, per-choice Completeness, Recommendation + \`(recommended)\` — and a "reply with a letter" instruction, then STOP)
- [ ] Non-ASCII characters (CJK / accents) written directly, NOT \\u-escaped
- [ ] If you had 5+ options, you split (or batched into ≤4-groups) — did NOT drop any
- [ ] If you split, you checked dependencies between options before firing the chain
- [ ] If a per-option Hold fires, you stopped the chain immediately (didn't queue)
`;
}
