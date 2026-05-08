# Browser-Skills v1 — codifying repeated browser flows

**Status:** Phase 1 shipped on `garrytan/browserharness`. Phases 2-4 enumerated below.
**Last updated:** 2026-04-26
**Authors:** garrytan (with /plan-eng-review and /codex outside-voice review)

## What this is

Browser-skills are per-task directories that codify a repeated browser flow
into a deterministic Playwright script. Each skill has:

```
browser-skills/<name>/
├── SKILL.md                        # frontmatter + prose contract
├── script.ts                       # deterministic logic
├── _lib/browse-client.ts           # vendored copy of the SDK
├── fixtures/<host>-<date>.html     # captured page for tests
└── script.test.ts                  # parser tests against the fixture
```

A user (or, in Phase 2, an agent that just got a flow right) creates a skill
once. Future invocations run the script, returning JSON in 200ms instead of
the 30 seconds an agent would burn re-exploring via `$B` primitives.

The shipped reference is `hackernews-frontpage`: scrapes the HN front page,
returns 30 stories as JSON. Try `$B skill list` and `$B skill run hackernews-frontpage`.

## Why this is different from domain-skills (v1.8.0.0)

- **Domain-skills** = "agent remembers facts about a site." JSONL notes keyed
  by hostname, injected into prompts at session start. State machine handles
  quarantine → active → global promotion.
- **Browser-skills** = "agent codifies procedures into deterministic scripts."
  Per-task directories, executed via `$B skill run`, scoped tokens at the
  daemon for per-spawn capability isolation.

Both use the same mental model (per-host, three-tier scoping). The procedure
layer is where the bigger productivity gain lives because it pushes scraping
and form automation out of latent space and into reproducible code.

## Why this is not the existing P1 ("self-authoring `$B` commands")

The original P1 was blocked on Codex's T1 objection: agent-authored TypeScript
cannot run safely *inside* the daemon (ambient globals, constructor gadgets,
top-level-await TOCTOU between approval and execution). The right design was
"out-of-process worker isolation with capability-passing IPC." That's a hard
project that may never ship.

Browser-skills sidestep the entire problem by running scripts *outside* the
daemon as standalone Bun processes. The daemon never imports or evals skill
code. Skills talk to the daemon over loopback HTTP — same wire format any
external client would use.

The plan as approved replaces the existing P1.

---

## Phasing

| Phase | Branch | Scope |
|-------|--------|-------|
| **1** | `garrytan/browserharness` | SDK, storage, `$B skill list/run/show/test/rm` subcommands, scoped-token model, bundled `hackernews-frontpage` reference. **Shipped (v1.19.0.0, consolidated with Phase 2a).** |
| **2a** | `garrytan/browserharness` (continues) | `/scrape <intent>` (read-only, single entry point with match/prototype paths) + `/skillify` (codifies prototype into permanent skill). Adds `browse/src/browser-skill-write.ts` D3 atomic-write helper. **Shipping v1.19.0.0.** |
| **2b** | new (`browser-skills-automate`) | `/automate` skill template (mutating-flow sibling of `/scrape`). Reuses `/skillify` and the D3 helper. Per-mutating-step confirmation gate when running non-codified. P0 in TODOS. |
| **3** | new (`browser-skills-resolver`) | Resolver injection at session start (per-host browser-skill discovery). Mirrors domain-skill injection. `gstack-config browser_skillify_prompts` knob. |
| **4** | new | Eval test infrastructure (LLM-judge), fixture-staleness detection, periodic re-validation against live pages, OS-level FS sandbox for untrusted spawns. |

---

## Phase 1 architecture

### Decisions locked (13)

1. **Phase 1 = full storage + SDK + subcommands + bundled reference.** No agent
   authoring yet. Phase 2 lands `/scrape` and `/automate`.
2. **Two verbs in Phase 2: `/scrape` (read-only) and `/automate` (mutating).**
   They share skillify approval-gate machinery but live as separate skill
   templates.
3. **Replaces the existing self-authoring-`$B` P1 in TODOS.md.** Same
   user-visible goal, no in-daemon isolation problem.
4. **SDK distribution: sibling file inside each skill (Option E).** The
   canonical SDK lives at `browse/src/browse-client.ts` (~250 LOC). Each skill
   ships a copy at `<skill>/_lib/browse-client.ts`. Phase 2's generator copies
   the current SDK alongside every generated script. Each skill is fully
   self-contained: copy the directory anywhere, it runs. Version drift
   impossible (the SDK is frozen at the version the skill was authored
   against). Disk cost: ~3KB per skill.
5. **Three-tier lookup: bundled → global → project.** Bundled skills ship
   read-only with the gstack install (`<gstack-install>/browser-skills/<name>/`).
   Global at `~/.gstack/browser-skills/<name>/`. Per-project at
   `<project>/.gstack/browser-skills/<name>/`. Lookup walks tiers in priority
   order project → global → bundled; first hit wins. **`$B skill list`
   prints the resolved tier alongside each skill name** so "why did it run
   that one?" is never a debugging mystery.
6. **Trust model: scoped tokens at spawn time, NOT env-scrub-as-sandbox.**
   See "Trust model" below. (Revised from original env-scrub plan after
   Codex flagged it as security theater.)
7. **Single source of truth: SKILL.md frontmatter only.** No `meta.json`.
   Frontmatter holds host, triggers, args, version, source, trusted.
   SHA256/staleness deferred to Phase 4 as a separate `.checksum` sidecar
   if it lands at all.
8. **No INDEX.json. Walk the directory.** `$B skill list` enumerates the
   three tiers and parses each SKILL.md frontmatter. ~5-10ms for 50 skills.
   Eliminates the entire "index drifted from disk" bug class.
9. **`$B skill run` output protocol.** stdout = JSON. stderr = streaming
   logs. Exit 0 / nonzero. Default 60s timeout, override via `--timeout=Ns`.
   Max stdout 1MB (truncate + nonzero exit if exceeded). Matches `gh` /
   `kubectl` / `docker` conventions.
10. **Fixture replay: two patterns for two test types.** SDK unit test
    stands up an in-test mock HTTP server. End-to-end skill tests parse
    bundled HTML fixtures via the script's exported parser function (no
    daemon required). Phase 1 fixture-only is adequate for `hackernews-frontpage`;
    Phase 2 `/automate` will need richer fixtures.
11. **Reference skill: `hackernews-frontpage`.** Scrapes HN front page
    (titles, points, comments). No auth, stable HTML, ideal fixture-test
    target.
12. **Token/port discovery: scoped-token env-only for spawned skills;
    state-file fallback for standalone debug runs.** When spawned via
    `$B skill run`, the SDK reads `GSTACK_PORT` + `GSTACK_SKILL_TOKEN` from
    env. For standalone `bun run script.ts`, the SDK falls back to
    `<project>/.gstack/browse.json` (the actual state-file path per
    `config.ts:50`).
13. **CHANGELOG honesty.** Phase 1 lead: humans can hand-write deterministic
    browser scripts that gstack runs. Phase 1 explicitly notes that agent
    authoring lands in next release. No fabricated perf numbers — Phase 1
    has no before/after.

### Trust model (decision #6 in detail)

Two orthogonal axes:

| Axis | Mechanism | Default |
|------|-----------|---------|
| **Daemon-side capability** | Per-spawn scoped token bound to `read+write` scope (the 17-cmd browser-driving surface, minus admin commands like `eval`/`js`/`cookies`/`storage`). Single-use clientId encodes skill name + spawn id. Revoked when the spawn exits. | Always scoped (never the daemon root token). |
| **Process-side env access** | SKILL.md frontmatter `trusted: true` passes `process.env` minus `GSTACK_TOKEN`. `trusted: false` (default) drops everything except a minimal allowlist (LANG, LC_ALL, TERM, TZ, locked PATH) and explicitly strips secret-pattern keys (TOKEN/KEY/SECRET/PASSWORD, AWS_*, AZURE_*, GCP_*, ANTHROPIC_*, OPENAI_*, GITHUB_*, etc.). | Untrusted (must opt in). |

`GSTACK_PORT` and `GSTACK_SKILL_TOKEN` are always injected last so a parent
process cannot override them by setting them in env.

**What this gets right:** the daemon-side scoped token is enforceable by the
daemon. A skill that tries to call `eval` (admin scope) gets a 403 even though
the SDK exposes it. The capability boundary is in the right place.

**What this does NOT close:** Bun has no built-in FS sandbox. An untrusted
skill can still `import 'fs'` and read whatever the OS user can read (e.g.
`~/.ssh/id_rsa`). The env scrub is hygiene, not a sandbox. OS-level isolation
(`sandbox-exec`, namespaces) is Phase 4 work and drops in cleanly behind the
existing trusted/untrusted contract.

The original plan called env-scrub a sandbox. Codex correctly flagged that as
theater. The revised plan calls it what it is: best-effort hygiene plus
defense-in-depth, with the real boundary at the daemon-side scoped token.

### File layout

```
browse/src/
├── browse-client.ts                # canonical SDK (~250 LOC)
├── browser-skills.ts               # 3-tier walk + frontmatter parser + tombstones
├── browser-skill-commands.ts       # $B skill list/show/run/test/rm + spawnSkill
└── skill-token.ts                  # mintSkillToken / revokeSkillToken wrappers

browser-skills/
└── hackernews-frontpage/           # bundled reference skill
    ├── SKILL.md
    ├── script.ts
    ├── _lib/browse-client.ts        # byte-identical copy of canonical
    ├── fixtures/hn-2026-04-26.html
    └── script.test.ts

browse/test/
├── skill-token.test.ts              # mint/revoke lifecycle, scope assertions
├── browse-client.test.ts            # mock HTTP server, wire format, auth
├── browser-skills-storage.test.ts   # 3-tier walk, frontmatter, tombstones
└── browser-skill-commands.test.ts   # parseRunArgs, dispatch, env scrub, spawn

test/skill-validation.test.ts       # extended: bundled-skill contract checks
```

### What does NOT change

- Domain-skills storage, state machine, or injection. Untouched.
- Tunnel-surface allowlist (`server.ts:118-123`). Same 17 commands.
- L1-L6 security stack. Browser-skills don't inject text into prompts in
  Phase 1; Phase 3's resolver injection will ride the existing UNTRUSTED
  envelope.
- The `cli.ts` HTTP client at `sendCommand()`. The SDK is a separate module
  with a different concern (library vs CLI process).

---

## Codex outside-voice findings (post-review responses)

The /codex review flagged 8 findings. The plan addresses them as follows:

| # | Finding | Phase 1 response |
|---|---------|------------------|
| 1 | Trust model is fake without FS sandbox | **Closed** by decision #6 (scoped tokens) above. |
| 2 | Phase 1 is overbuilt for one bundled skill (lookup tiers, tombstones, etc.) | **Acknowledged but kept.** User chose full Phase 1 to lock the architecture before Phase 2 lands agent authoring. Each subsystem is small enough to remove cleanly if data later says it's unused. |
| 3 | Existing client pattern in `cli.ts:398` may make sibling SDK redundant | **Verified false.** Line 398 is the end of `extractTabId()` (a flag-parser). The actual HTTP client is `sendCommand()` at cli.ts:401-467, but it's CLI-coupled (`process.stdout.write`, `process.exit`, server-restart recovery). Not reusable as a library. The new `browse-client.ts` mirrors its wire format but is library-shaped. |
| 4 | "First hit wins" lookup is opaque | **Mitigated** by listing the resolved tier inline in `$B skill list` and `$B skill show`. Future: optional `--source bundled\|global\|project` flag if the tier override proves confusing. |
| 5 | Atomic skill packaging matters more than the index question; symlink defenses | **Closed for Phase 1**: bundled skills ship as part of the gstack install (no live writes; atomic by virtue of being read-only files in the install dir). Phase 2's `writeBrowserSkill` will write to a temp dir then rename, and use `realpath`/`lstat` discipline (existing `browse/src/path-security.ts`). |
| 6 | Phase 2 synthesis from activity feed is weak (lossy ring buffer) | **Open issue for Phase 2 design.** The activity feed is telemetry, not a replay IR. Phase 2 will need a structured recorder OR re-prompting the agent to write the script from scratch using its own context. Decide in Phase 2's design pass. |
| 7 | Bun runtime regression: skill scripts as standalone Bun reintroduce a Bun runtime requirement | **Open issue for Phase 2 distribution.** Phase 1 sidesteps this because the bundled reference skill ships inside the gstack install (which already builds with Bun). Phase 2 needs to decide between (a) shipping a Bun binary with each generated skill, (b) compiling skills to self-contained executables, or (c) using Node.js with `cli.ts`'s HTTP pattern. |
| 8 | `file://` fixtures don't prove timing/auth/navigation/lazy hydration | **Documented limit.** Adequate for `hackernews-frontpage`. Phase 2 `/automate` will need richer fixtures (mock daemon with timing, recorded HAR replay, etc.). |

---

## Phase 2a — `/scrape` + `/skillify` (shipping v1.19.0.0)

Two skill templates plus one helper module. `/scrape <intent>` is the single
entry point for pulling page data; first call on a new intent prototypes via
`$B` primitives and returns JSON, subsequent calls on a matching intent route
to a codified browser-skill in ~200ms. `/skillify` codifies the most recent
successful prototype into a permanent browser-skill on disk. Mutating-flow
sibling `/automate` deferred to Phase 2b (P0 in TODOS).

### Decisions locked during the v1.19.0.0 plan review (`/plan-eng-review`)

| ID | Decision | Locked behavior |
|----|----------|-----------------|
| **D1** | `/skillify` provenance guard | Walk back ≤10 agent turns looking for a clearly-bounded `/scrape` invocation (the prototype's intent line + its trailing JSON output). If not found, refuse with: *"No recent /scrape result found in this conversation. Run /scrape <intent> first, then say /skillify."* No silent fallback. |
| **D2** | Synthesis input slice | Template instructs the agent to extract ONLY the final-attempt `$B` calls that produced the JSON the user accepted, plus the user's stated intent string. Drop failed selector attempts, drop unrelated chat, drop earlier-session content. Closes Codex finding #6 by picking option (b) (re-prompt from agent's own context, not a structured recorder). |
| **D3** | Atomic write discipline | `/skillify` writes to `~/.gstack/.tmp/skillify-<spawnId>/`, runs `$B skill test` against the temp dir, and only renames into the final tier path on success + user approval. On test failure or approval rejection: `rm -rf` the temp dir entirely (no tombstone for never-approved skills). New module `browse/src/browser-skill-write.ts` (`stageSkill` / `commitSkill` / `discardStaged`) with `realpath`/`lstat` discipline per Codex finding #5. |
| **D4** | Test scope | 5 gate-tier E2E (scrape match, scrape prototype, skillify happy, skillify provenance refusal, approval-gate reject) + 1 unit test (atomic-write helper failure cleanup) + 1 hand-verified smoke (mutating-intent refusal). Registered in `test/helpers/touchfiles.ts`. |

### Carry-overs

- **Default tier: global.** Lean global for procedures, with per-project
  override at `/skillify` time (mirrors domain-skill scope). Phase 1 storage
  helpers support both lookup paths.
- **Bun runtime distribution.** Codex finding #7 stays open. Phase 2a assumes
  Bun is on PATH (gstack already requires it via `setup:6-15`). Documented
  in `/skillify` SKILL.md "Limits". Real fix lands in Phase 4.

## Phase 2b — `/automate` sketch

Mutating-flow sibling of `/scrape`. Same skillify pattern (reuses `/skillify`
and the D3 helper as-is). Difference: per-mutating-step UNTRUSTED-wrapped
summary + `AskUserQuestion` confirmation gate when run non-codified. After
codification, the skill runs unattended (the codified script enumerates exactly
which `$B click`/`fill`/`type` calls run). See P0 entry in `TODOS.md`.

## Phase 3 sketch

Resolver injection at session start. Mirror the domain-skill injection at
`server.ts:722-743`:

```ts
const browserSkillsBlock = await renderBrowserSkillsForHost(hostname, projectSlug);
if (browserSkillsBlock) {
  systemPrompt += `\n\n${browserSkillsBlock}`;
}
```

`renderBrowserSkillsForHost()` reads the 3 tiers, filters to skills whose
`host` field matches, and emits an UNTRUSTED-wrapped block listing them.

`gstack-config browser_skillify_prompts` (default off): when on, end-of-task
nudges in `/qa`, `/design-review`, etc. fire when activity feed shows ≥N
commands on a single host AND no skill exists yet for that host+intent.

## Phase 4 sketch

- LLM-judge eval ("did the agent reach for the skill instead of re-exploring?").
- Fixture-staleness detection — compare bundled fixture against live page.
- OS-level FS sandbox for untrusted spawns (`sandbox-exec` on macOS,
  namespaces / seccomp on Linux).
- `$B skill upgrade <name>` — regenerate the sibling SDK copy when the
  canonical SDK changes.

---

## Verification (Phase 1)

`bun test` passes the new test files:
- `browse/test/skill-token.test.ts` — 15 assertions
- `browse/test/browse-client.test.ts` — 26 assertions
- `browse/test/browser-skills-storage.test.ts` — 31 assertions
- `browse/test/browser-skill-commands.test.ts` — 29 assertions
- `browser-skills/hackernews-frontpage/script.test.ts` — 13 assertions
- `test/skill-validation.test.ts` — 7 new bundled-skill assertions

End-to-end with the daemon running:

```bash
$B skill list                            # shows hackernews-frontpage (bundled)
$B skill show hackernews-frontpage       # prints SKILL.md
$B skill run hackernews-frontpage        # returns JSON of 30 stories
$B skill test hackernews-frontpage       # runs script.test.ts
```
