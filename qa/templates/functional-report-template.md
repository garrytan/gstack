# Functional QA Report: {TARGET}

| Field | Value |
|---|---|
| Date / branch / revision | {DATE / BRANCH / COMMIT AND WORKING-TREE INPUTS} |
| Caller / authority / depth | {qa-only, qa, review or ship; permitted writes; bound} |
| Surfaces / scope | {API, CLI, job, worker, webhook; changed and adjacent contracts} |
| Runtime / native tools | {VERSIONS AND REPOSITORY-SUPPORTED COMMANDS} |
| Fixture ownership / destinations | {ISOLATED ROOT, STORES, DOWNSTREAM TARGETS} |
| Probe budget / guarded command time / stop reason | {CONFIGURED LIMIT / SUM OF CAPTURE durationMs / COMPLETE OR BOUND/BLOCKER} |

## Contract outcomes

| Contract and source | Exact probe / evidence | Expected → observed | Outcome |
|---|---|---|---|
| {CONTRACT, DOC/TEST/USER SOURCE} | {COMMAND OR REQUEST, EVIDENCE PATH} | {OUTPUT AND DURABLE EFFECT} | pass / fail / blocked / not run / inconclusive / not applicable (reason) |

No visual score applies to this functional section. In a mixed report, keep the
browser section's score and evidence separate, and link both surfaces' replay
evidence and regression baselines. Do not combine their scores or outcomes.

## Findings

### ISSUE-NNN: {Reproduced defect or setup blocker}

- Classification / severity: {PRODUCT DEFECT / SETUP / INCONCLUSIVE; IMPACT}.
- Intended contract and source: {EXPECTED BEHAVIOR, NOT MERELY CURRENT IMPLEMENTATION}.
- Reproduction: {WORKING DIRECTORY; SAFE SETUP/RESET; ENVIRONMENT NAMES ONLY; EXACT COMMAND OR METHOD/PATH/HEADERS/BODY USING SYNTHETIC VALUES}.
- Observed: {EXIT/STATUS; STDOUT; STDERR; INITIAL/FINAL DURABLE STATE; REPLAY/RETRY ORDER}.
- Evidence: {EXACT SAFE OUTPUT AND STATE PATHS; REVISION/RUNTIME; REDACTION AND REPRODUCIBILITY LIMITS}.
- Diagnosis / next action: {CAUSAL EVIDENCE OR SPECIFIC PREREQUISITE; NO SPECULATIVE FIX}.

## Discoveries and permanent tests

Link each `exploration-NNN.json` checkpoint, saved before its next probe, in this report.
Each checkpoint receipt prints its `link`; `.qa-evidence/NNN` capture folders are not checkpoints.
Use one Markdown entry per checkpoint, for example:

- [checkpoint 001](exploration-001.json) — how this observation shaped the next probe.

Use the actual filename and a path relative to this report (or its owned absolute
path); plain or backticked filenames are not links.
Include superseded checkpoints as history, not current passing evidence.
Keep these original notes with the report.

| Hypothesis / discovery | Native test or proposed case | Red evidence before repair | Green + original + adjacent evidence | Parent disposition |
|---|---|---|---|---|
| {OBSERVATION THAT CHANGED THE NEXT PROBE} | {UNIT / INTEGRATION / E2E; PATH OR REPORT-ONLY PROPOSAL} | {EXACT DEFECT FAILURE OR HEALTHY CONTRACT} | {ACTUAL RESULTS OR NOT RUN} | {AUTHORIZED CHANGE / SUGGESTION / DEFERRED} |

## Coverage limits and cleanup

List unexecuted charters, unavailable prerequisites, denied effects, ambiguous contracts,
incomplete observations and remaining risk. Do not count them as passes. Name owned
processes/state cleaned and anything left behind. State whether later changes invalidated
evidence. Report-only must identify proposals separately from tests actually created.
