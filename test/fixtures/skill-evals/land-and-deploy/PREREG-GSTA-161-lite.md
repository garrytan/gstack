# GSTA-161 preregistration: PR 1b confirmation (lite vs full vs no gstack) on land-and-deploy

Exploratory. Gates READY for PR 1b (Opus 5.5 lite loadout) and supports no public claim. Written and pushed before any paid session of this run.

## Question
Does the lite loadout PR 1b ships for Claude Opus 5.5 (full minus eleven coaching preamble pieces; upgrade-check and brain-sync kept) lose anything on land-and-deploy against full, and how do both compare with no gstack at all?

## Arms (gstack a1c38753de9f6b06861da3a28ad1609179f4aa72, branch gsta161/opus-lite-loadout on main a30530296)
| arm | render | image id |
|---|---|---|
| before (full) | `gstack-modules render --loadout full`, overlaid in place | sha256:72c7221901955649b95c83c76013176a91265934f41f4157481aed25f3afae5d |
| after (lite, as a Capy install serves it) | `gstack-modules render --modules lite --bind-model claude-opus-5-5 --full-root $HOME/gstack-full` (start lines carry the LOADOUT rule; an untouched full checkout sits at the full root) | sha256:182e2bd20c8f58773d071f72e5b42263ab1a69887a91c933820bb80f320dd6fd |
| none (no gstack) | land-and-deploy skill dropped, same sha | sha256:27cf8ad6f7fc5113e389a3021086e154327030ffc06460c4c52620d191ad76c0 |

Base image sha256:4488d15635cf692838b1d5aad88a2816224ba21f6fceb52eefc20e2dff58500f (Claude Code 2.1.312, Bun 1.4.4). Lock files: before a8bef99f…, after 04cad37c… (sha256 of loadout.lock.json). land-and-deploy SKILL.md + sections/preamble.md: before 54,932 bytes, after 44,199 (-19.5%).

## Tasks
test/fixtures/skill-evals/land-and-deploy at 9862822910ba4cb276a9530080ca13ac2a13cbf4 (10 tasks, gh stub, the suite's user simulator), unchanged from the land-and-deploy diet verdict.

## Runner
quick/lanea-quick at gstack-evals 1b68e637c07cea38f01c01120e02d184575da82c, unmodified, through the GSTA-161 adapter (local; suite ld-lite, adapter commit a3233eb). Grading, gates and analysis are the runner's own (analyze.ts).

## Stages, fixed before the run
- LDL: Opus 5.5, arms before/after, 10 tasks x 3 trials = 60 sessions.
- LDL-NONE: Opus 5.5, arm none, 10 tasks x 3 trials = 30 sessions.
No trials, arms or tasks are added after a result. One same-tree rerun of a red task per crew rule 16, recorded as flaky. No before2 panel: the noise floor quoted is the earlier land-and-deploy run's before2 - before (+6.7 pp, 95% CI [-13.3, +33.3], runs-v2), labelled as reused evidence from another tree.

## Reading
Primary: the runner's verdict for after vs before. No loss = verdict PASS with no loss signal and no SAFETY or REGRESSION task. Anything else is a loss: PR 1b then drops the models mapping and ships lite as opt-in only. With 10 tasks x 3 trials the run cannot rule out a loss smaller than about 15 pp; it is a guard against a visible regression, not proof of equivalence. The none arm is reported beside both (none - before, none - after). Secondary: cost per session, input tokens and loaded skill bytes, and how many after sessions read a file under $HOME/gstack-full (the LOADOUT rule's re-read).

## Spend
Line item gsta161-ldl-confirm, cap $75 (GSTA-36: "The three-arm $75 run still gates READY"; Garry's no-gstack rule, CREW.md). Estimate about $40 (60 x $0.60 + 30 x $0.12 from the earlier land-and-deploy run). The runner stops before a session that would pass the cap.
