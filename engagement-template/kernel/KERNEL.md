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
task fail <id> --agent A --role R [--needs-human]
task release <id> --agent A --role R
task create <id> --repo X --domain D --desc "..." [--blocked-by ..] [--spec ..] [--done-check ..] [--e2e-check ..] [--lease-hours N]
```
Exit codes: 0 ok · 1 error · 2 lost claim race · 3 nothing eligible.
