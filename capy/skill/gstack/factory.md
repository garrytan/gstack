# How we work: the gstack software factory on Capy

What seven Captain crews converged on (2026-10-29). Your crew's CREW.md and recorded approvals decide who may merge, update a base, spend or touch production; urgency changes priority, never permissions or gates. With no Captain, ask the person and never merge without their word. Story: capy/README.md; examples: your org Drive's software-factory/README.md, if any.

1. **Plan, then a yes.** New functionality starts with /autoplan sized to the work; the build waits for "do it". [SKILL.md: Plan, approve, ship]
2. **Someone else merges.** Run /ship to a receipt on your final pushed head, send one READY quoting gstack's verify output verbatim, and stop. The merge owner merges on green and assigns versions. [docs/captain.md: The READY contract]
3. **Block only on the floor.** A finding blocks if it would fail a test, break production, or lose data or secrets; the rest goes in the PR body or next wave. [docs/review-policy.md]
4. **Fix waves.** When main goes red, hold /ship while one owner finds the root cause; bring main in once, as your rules allow. Fold deferred findings and test follow-ups into one PR. [docs/triage.md]
5. **Severe first, same gates.** A severe user-facing bug jumps the queue; the plan can be short; receipt, checks and merge owner stay.
6. **Trade findings, not small talk.** Another crew's finding goes to its Captain, through yours, with the evidence.
7. **Measure before you act.** Run the real system on the merged tree you ship; a real run outranks a reviewed plan. Each number names its run, commit or uncapped query; say what you did not verify.
8. **Evals decide, and losses get reported.** Preregister bars, cap and stop rule before paying [/eval-plan]. Cheap proof (a keyless fake, a smoke) before the paid run. Use controls (no-skill and placebo arms, clean decoys). Report use and pass apart; quote spend from the meter.
9. **Flakes: one rerun, a ledger, a daily fix.** Only the rerun the policy allows, never a harness or infra red; a second red is real; no test is loosened. [docs/captain.md: The daily flaky pass]
10. **Quiet.** Message on a decision, a blocker, a READY or a finished phase. A broadcast needing no reply goes in the Captain's notes; never reply just to acknowledge.
11. **Ask once, plainly.** One ask per decision, explained like the owner is five: your Captain's name, then a lettered line each: "A: <code> hit problem p, which happens when h. We could do 1) x, 2) y or 3) z. Recommendation x because why. A1 to take recommendation." "do it" takes every recommendation; "A2" takes option 2. Owner tasks: the exact link (in Capy: path and field), numbered simple steps, the reply word. Never re-ask a standing rule; check what you can yourself. [docs/captain.md: The ask format]
12. **Fresh threads, closed out.** One thread per unit of work (crew threads ask their Captain); past the context limit, hand off. Its Captain archives only its crew's threads; threads outside every crew are the owner's, even its automation's. Size reviews to the diff; read the token counter. [docs/ship-budget.md]
13. **The owner's model preference.** `gstack-models resolve --role agent` picks agent models, except cross-family voices and eval subjects. [docs/model-policy.md: Your model preference]
