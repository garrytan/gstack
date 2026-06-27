# KERNEL.md — charter for the cstack coordination kernel

The kernel is the small, deterministic, privileged layer of the autonomous loop:
`kernel/task` plus the semantics of `ledger/*.task` files. Agents never touch
ledger state directly — they make "syscalls" through the task tool, which
arbitrates claims, enforces column ownership, resolves dependencies, and
applies leases and circuit breakers. The model decides WHAT; the kernel
executes HOW.

## The kernel earns trust by being boring
Its quality metric is the absence of surprise, not capability. A feature
refused is a feature that cannot break claiming.

## In scope
- Ledger state transitions (claim, complete, fail, release, create)
- Eligibility logic: dependencies, domain/repo matching, failure_count
  circuit breaker, per-task lease expiry, role-specific status rules
- Claim arbitration (git push as the lock, post-push race verification)
- Exclusive resource locks (`locks:` + `lock_state:`): at most one `held` task per
  named resource, held from claim until the branch MERGES to main (not merely `done`,
  since a human merges the PR hours later), with a post-push tie-break and an explicit
  `lock-release`. Canonical use is `migrations` — it stops two feature agents minting
  colliding migration numbers off the same main.
- Column ownership enforcement per role

## Out of scope (belongs in user space — agents, skills, behaviour)
- Judgment, code generation, content of any kind
- Anything probabilistic or requiring an LLM
- Verification itself (running tests is the agent's job; the kernel only
  records outcomes)

## Change rules
1. Kernel changes are HUMAN-authored only. Agents are forbidden from editing
   `kernel/` (enforced in AGENT_BASE Hard Rules).
2. Every change ships with a test in `kernel/tests/`. Run
   `kernel/tests/test_lifecycle.sh` before pushing any kernel change.
3. Smaller is better. New subcommands and fields need a reason that
   "the agents can do it in user space" fails to answer.
4. The kernel hot-swaps (it lives in the control repo and agents pull each
   iteration) — so a broken kernel push breaks ALL agents at once. Test first.

## Interface (stable contract)
```
task eligible --role R --domain D [--repo X]   # ids best-first | NO_ELIGIBLE_TASKS (exit 3)
task show <id>
task claim <id> --agent A --role R              # exit 2 = lost race, pick another
task complete <id> --agent A --role R [--verdict v]
task fail <id> --agent A --role R [--needs-human | --awaiting-info]
                                                  # --awaiting-info: park (status=awaiting_info),
                                                  # no failure_count hit — agent-to-agent question
task resume <id> --agent A --role R              # AGENT-PERMITTED. awaiting_info -> open.
task release <id> --agent A --role R
task lock-release <id> [--agent A] [--abandon]  # free an exclusive lock post-merge.
                                                  # supervisor merge-reaper calls it; humans
                                                  # use --abandon for a closed/superseded PR.
task unblock <id> --agent A --reason "..."      # HUMAN ONLY. needs_human -> open. Required reason.
task sync                                        # batch-create ledger entries from tasks/*.md
                                                  # frontmatter (ready: true). One commit, any N.
task create <id> --repo X --domain D --desc "..." [--blocked-by ..] [--locks migrations] [--spec ..] [--done-check ..] [--e2e-check ..] [--lease-hours N]
```

`--locks <resource>` reserves a named exclusive lock. The holder takes it at first claim
(`lock_state: held`) and keeps it through the WHOLE lifecycle — including after `done` —
until the work merges to main. While held, the kernel withholds every other task sharing
the name from `eligible` and refuses their `claim` (exit 2). Two agents that race the same
lock through concurrent pushes are resolved by a post-push tie-break: earliest `claimed_at`
wins, ties broken by id; the loser yields and releases. The lock is freed by `lock-release`,
which the supervisor's merge-reaper (`supervisor/lock-reaper.sh`) calls automatically when the
task's `feat/<id>-*` branch becomes an ancestor of `origin/main`. A QA-bounced holder reverts
to `open` but STAYS held — its unmerged migration still exists. Canonical value: `migrations`.
Exit codes: 0 ok · 1 error (sync: also means >=1 spec had a frontmatter error — see output) · 2 lost claim race · 3 nothing eligible.

`unblock` is the ONLY sanctioned reversal of `needs_human` — it refuses any other status,
requires a non-empty `--reason` (recorded in the commit), and deliberately leaves
`failure_count` untouched as history. AGENT_BASE forbids agents from calling it; it exists
so a human decision never requires a manual ledger edit.

`sync` is the preferred way to register tasks at any scale: write `tasks/<ID>.md` with the
frontmatter block from `tasks/TASK_TEMPLATE.md` (typically via the `/req-spec` skill), set
`ready: true` once every AC is mapped, then `kernel/task sync`. Specs with `ready: false`,
missing frontmatter (legacy specs), or already-registered IDs are skipped and reported —
never silently re-processed. `task create` remains for one-off/manual registration.
