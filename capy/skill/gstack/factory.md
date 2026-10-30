# How we work: the gstack software factory on Capy

What seven Captain crews on gstack and Capy converged on (2026-10-29). Your crew's CREW.md and recorded approvals decide who may merge, update a base, spend or touch production; urgency changes priority, never permissions or gates. With no Captain, ask the person and never merge without their word. Story and numbers: capy/README.md; evidence and examples: your organization Drive's software-factory/README.md, when one exists.

1. **Plan, then a one-word yes.** New functionality starts with /autoplan sized to the work, and the build waits for "rec" or "do it". [SKILL.md: Plan, approve, ship]
2. **Someone else merges.** Run /ship to a receipt on your final pushed head, send one READY that quotes gstack's verify output word for word, and stop. The merge owner merges on green, and versions are assigned at merge. [docs/captain.md: The READY contract, Merge trains]
3. **Block only on the floor.** A finding blocks if it would fail a test, break production, or lose data or secrets; the rest goes in the PR body or the next wave. [docs/review-policy.md]
4. **Fix waves.** When main goes red, hold /ship while one owner finds the root cause; bring main in once, as your crew's rules allow. Fold deferred findings and test follow-ups into one wave PR. [docs/triage.md]
5. **Severe first, same gates.** A severe user-facing bug jumps the queue; the plan can be short, but the receipt, checks and merge owner stay.
6. **Trade findings, not small talk.** A finding that belongs to another crew goes to its Captain, through yours, with the evidence.
7. **Measure before you act.** Time it, count it, run the real system, on the merged tree you ship; a real run outranks a reviewed plan. Each number names its run, commit or uncapped query; say what you did not verify.
8. **Evals decide, and losses get reported.** Preregister bars, cap and stop rule before the first paid call [/eval-plan]. Cheap proof first: a keyless fake, a small smoke, then the paid run. Use controls: no-skill and placebo arms, decoys verified clean. Report use and pass separately and quote spend from the meter.
9. **Flakes: one rerun, a ledger, a daily fix.** Only the rerun the policy allows, never a harness or infra red; a second red is real, and no test is loosened. [AGENTS.md: Validation discipline; docs/captain.md: The daily flaky pass]
10. **Quiet.** Message on a decision, a blocker, a READY or a finished phase. A broadcast that needs no reply goes in the Captain's notes, not to every lane; never reply just to acknowledge.
11. **Ask once, plainly.** One open ask per decision, on an issue: recommendation first, one line per choice, everyday words, links inline. Never re-send it or re-ask a standing rule. Settle what you can check yourself.
12. **Fresh threads, closed out.** One thread per unit of work (crew threads ask their Captain for new ones); past the context threshold, hand off. Its Captain archives each thread it, its crew or its automations start, by its plan for it. Size reviews to the diff; read the token counter, don't estimate. [docs/ship-budget.md]
13. **The owner's model preference.** `gstack-models resolve --role agent` picks agent models, except cross-family voices and eval subjects. [docs/model-policy.md: Your model preference]
