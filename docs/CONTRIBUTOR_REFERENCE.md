# Contributor reference

Contributor-only detail moved verbatim from CLAUDE.md, which Claude Code
loads into every session and caps at 40,000 characters (#2096,
`test/claude-md-size.test.ts`). CLAUDE.md keeps a one-line pointer to each
section here.

## Skill size budgets

**Token ceiling:** Generated SKILL.md files trip a warning above 160KB (~40K tokens).
This is a "watch for feature bloat" guardrail, not a hard gate. Modern flagship
models have 200K-1M context windows, so 40K is 4-20% of window, and prompt caching
makes the marginal cost of larger skills small. The ceiling exists to catch runaway
preamble/resolver growth, not to force compression on carefully-tuned big skills
(`ship`, `plan-ceo-review`, `office-hours` legitimately pack 25-35K tokens of
behavior). If you blow past 40K, the right fix is usually: (1) look at WHAT grew,
(2) if one resolver added 10K+ in a single PR, question whether it belongs inline
or as a reference doc, (3) only compress carefully-tuned prose as a last resort —
cuts to the coverage audit, review army, or voice directive have real quality cost.

A second, harder ceiling guards the DISCOVERY surface: `test/catalog-budget.test.ts`
caps the aggregate frontmatter `name` + `description` across all skills at
`CATALOG_BUDGET_TOKEN_EQUIVALENTS` (1,194 today; each new skill ratchets it)
token-equivalents (260-byte per-skill sub-cap), counted through the shared census
in `test/helpers/skill-census.ts`. This one is enforced, not a warning — every
host loads the full catalog every session, so growth here taxes every
conversation. The failure message carries the re-measure + ratchet protocol.
`bin/gstack-context-bill` shows the full token bill-of-materials for a skills
tree (always-on vs per-invocation, `--diff`, `--budget`; `--exact` opts into the
real tokenizer and POSTs file text to api.anthropic.com with an egress receipt).

The context-budget ratchet (`test/context-budget-ratchet.test.ts`, free, runs
in `bun run test`) pins ABSOLUTE ceilings on two more ledgers: the always-on
FULL-frontmatter aggregate (catalog-budget counts only name+description) and
each skill's per-invocation eager tokens (SKILL.md + forced-read references —
size floors and parity ratios guard these relatively, not absolutely), graded
against `test/fixtures/context-budget.json`. A skill that grows past its
ceiling fails; a new skill fails until it's consciously budgeted. For
legitimate growth or a landed reduction, re-run
`bun test/helpers/capture-context-budget.ts` and commit the refreshed fixture
in the same commit, so ceilings ratchet down and every win is locked.

## Egress receipts

**Egress receipts at every off-machine sink** (v1.63.0.0+). Every gstack-initiated
send off the machine MUST write a hash-chained receipt to
`~/.gstack/security/egress.jsonl` BEFORE the send: TypeScript callers use
`writeReceipt` from `lib/egress-receipt.ts`; shell scripts source
`bin/gstack-egress-lib.sh` and use `_receipted_curl` / `_receipted_git`. Failure
polarity is per-class: fail-closed for sensitive sinks (brain-sync, memory-ingest,
gbrain-sync, telemetry, ngrok tunnels, mcp-verify, supabase-provision, and the
Memorable bridge's per-prompt memorable-recall hand-off), fail-open
+ stderr warning for user-facing ones (design OpenAI calls, update-check,
dashboards, git-class ops). The new-sink scanner in
`test/egress-receipt-wiring.test.ts` fails CI on an unreceipted `curl` /
`git push` / `fetch` to a non-loopback host unless the file carries a reasoned
entry in its `SCANNER_EXEMPT` list (user-directed page fetches, reachability
probes, instruction strings, skill prose) — if you add a new off-machine sink,
wire it through the helpers and add it to the enumerated sink list. `aside exec`
(a gstack-composed prompt sent to Aside's agent) is a fail-open user-facing
sink: skills call it through the `_aside_exec` wrapper that
`scripts/resolvers/aside.ts` renders, never bare. Inspect with
`bin/gstack-egress` (`list` | `verify`, exit 3 on tamper | `grants`). Threat
model: forensic observability of ATTEMPTED egress, not an exfiltration control.

## Skill linking and ownership

**Prefix setting:** Setup creates real directories (not symlinks) at the top level
with a SKILL.md symlink inside (e.g., `qa/SKILL.md -> gstack/qa/SKILL.md`), plus
links to each skill's runtime assets (sections/, templates, checklists — everything
except SKILL.md, tests, build output, and `.tmpl` sources). Alias skills
(`_gstack-command`, `connect-chrome`) install as rewritten copies, never symlinks.
This ensures Claude discovers them as top-level skills, not nested under `gstack/`.
Names are either short (`qa`) or namespaced (`gstack-qa`), controlled by
`skill_prefix` in `~/.gstack/config.yaml`. Pass `--no-prefix` or `--prefix` to
skip the interactive prompt.

**Ownership gate (#2119):** `setup` writes a `.gstack-owned` marker into every
skill directory it creates, and `setup` (the linker, the alias installer, both
prefix-flip cleanups, and the retired-skill prune) and `bin/gstack-relink` only
delete or link over an entry they can prove is gstack's. Strong proof (a
symlink resolving into gstack, or the marker) allows deleting or refreshing the
whole directory. Weak proof (a
real SKILL.md byte-identical to the source, or carrying gen-skill-docs' two-line
banner) covers only that one file, and a weakly-proven file that differs is
moved to `~/.gstack/backups/skills/<ts>/<skill>/SKILL.md` before gstack links
over it. Anything else is a foreign skill: skipped, and named in setup's final
summary. The rule lives in two copies (`setup` and `bin/gstack-relink`); keep
them in sync until the shared helper filed in TODOS.md lands. The retired-skill
prune (`_prune_stale_generated`) applies the same strong/weak split to renders
of skills that no longer exist, through its own gate
(`_owned_for_windows_refresh`: a real host directory is a candidate only when
its SKILL.md carries the generated banner; the marker and byte identity are not
consulted): it scans the render tree and every host skills dir,
deletes a real render directory, removes a host symlink only when it resolves
into gstack, cleans a bannered real directory through `_cleanup_weak_dir`,
never follows a symlink inside the render tree, and recognizes a skill renamed
through its frontmatter `name:`. Pinned by `test/setup-link-ownership.test.ts`,
`test/setup-cleanup-orphans.test.ts`, `test/setup-prune-stale-generated.test.ts`,
and `test/relink.test.ts`.

## Redaction guard

Shared redaction engine catches credentials, PII, and legal/damaging content
before it reaches an external sink (codex dispatch, GitHub issue/PR body, pushed
commit). It is a **guardrail, not airtight enforcement** — `git push --no-verify`,
direct `gh issue create`, and `GSTACK_REDACT_PREPUSH=skip` all bypass it. It
catches accidents and carelessness, the 99% case. Do not claim it stops a
determined leaker (a CHANGELOG line that does would fail a hostile screenshotter).

- **Engine + taxonomy:** `lib/redact-patterns.ts` (the single source of truth —
  3 tiers; HIGH = genuinely-secret credentials that block, MEDIUM = PII/legal/
  internal + high-FP credential shapes that confirm via AskUserQuestion, LOW =
  FYI) and `lib/redact-engine.ts` (pure `scan()` + `applyRedactions()`).
  Calibration matters: a gate that cries wolf gets ignored, so context-variable
  shapes (Stripe `pk_live_`, Google `AIza`, JWT, env `*_KEY=`) sit at MEDIUM.
- **CLI:** `bin/gstack-redact` (exit 0 clean / 2 MEDIUM / 3 HIGH; `--json`,
  `--auto-redact`, `--repo-visibility`, `--from-file`). `bin/gstack-redact-prepush`
  is the opt-in git hook.
- **Skill docs are generated** from `scripts/resolvers/redact-doc.ts`
  (`{{REDACT_INVOCATION_BLOCK:<sink>}}`) so /spec,
  /cso, /ship, /document-release, /document-generate never drift from the engine.
- **Scan-at-sink:** always scan the EXACT bytes that will be sent — write to a
  temp file, scan that file, pass the SAME file to `gh`/`git`. Never scan a string
  then re-render (that reopens a scan-vs-send gap).
- **Visibility (no tier promotion):** resolve once per run, order = local config
  (`gstack-config get redact_repo_visibility`, ~/.gstack so never committed) → gh
  → glab → unknown(=public-strict). Public repos get STERNER per-finding
  confirmation (no batch-acknowledge, no silent-proceed); MEDIUM is never
  auto-promoted to HIGH.
- **Tool-attributed fences:** wrap Codex/Greptile/eval output in ` ```codex-review `
  / ` ```greptile ` fences so example credentials those tools quote WARN-degrade
  instead of blocking. A live-format credential inside the fence still blocks.
- **Config keys:** `redact_repo_visibility` (public|private|unknown, local-only
  override for repos gh/glab can't read), `redact_prepush_hook` (true|false).
  There is intentionally NO key to disable HIGH blocking.
- **Committed allowlist:** `.gstack-redact-allowlist` at the root of the pushed commit lists
  exact matched spans reviewed as benign; the pre-push hook suppresses only a
  finding whose span equals an entry and lists every suppression on each push.
- **Audit:** the /spec semantic pass appends a content-free record (categories +
  body sha256, no spec text) to `~/.gstack/security/semantic-reviews.jsonl` (0600).

## Checking out PRs from garrytan-agents

When the user says "check out <PR link>" and the PR is from `garrytan-agents/gstack`
(or any other fork that is NOT a collaborator on `garrytan/gstack`), do NOT just
`gh pr checkout`. Fork PRs don't receive base-repo secrets (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, etc.), so the eval/E2E CI jobs fail with empty-env auth errors
regardless of what's set on the base repo.

**Workflow:** push the branch to `garrytan/gstack` (the base repo) and re-target
the PR from there.

Concretely, after `gh pr checkout <N>`:

1. Note the original PR number and head branch name.
2. Push the same branch to the base repo: `git push origin HEAD:<branch-name>`
   (origin = `garrytan/gstack`, since the worktree is set up with that remote).
3. Close the fork PR (`gh pr close <N> --comment "moving to base-repo branch for secret access"`).
4. Open a new PR from the base-repo branch: `gh pr create --base main --head <branch-name>`.
5. New PR's workflows will get secrets automatically.

Why not fix it on the fork side? `garrytan-agents` isn't a collaborator on
`garrytan/gstack`. Adding it as a collaborator (option A) or flipping the
repo-wide "send secrets to fork PRs" toggle (option B) would let secrets reach
fork PRs from anyone — broader blast radius than just moving this one branch.
Option C (this section) keeps secret-distribution scope tight.

If the user asks you to skip the move (e.g., "just leave it as a fork PR"),
respect that — eval CI will fail with empty-env auth, but check-freshness,
workflow-lint, and windows-tests will still pass on the fork PR.
