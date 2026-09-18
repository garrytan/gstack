# Overlay benchmark behavior contract v2

The paid overlay fixtures verify supported behavior, with comparative efficacy
reported separately as research evidence. A passing case does **not** establish
marginal overlay benefit or resource non-regression. This replaces the previous
blocking efficacy contract; historical failures retain their original verdicts.

The contract is defined by `OVERLAY_CONTRACT` in
`test/helpers/overlay-case-policy.ts`. Every new measurement and aggregate record
identifies version 2. Eval entry names include `contract-v2` so automated result
matching cannot silently compare the old and new contracts by the same name.
Selection IDs for the six retained paid cases stay unchanged.

## Blocking checks

Both arms use the real Claude Code preset; ON appends the resolved overlay and
OFF does not. Each retained fixture runs ten samples per arm, separately for
`claude-opus-4-7` and `claude-sonnet-4-6`. Each model keeps its own results.

Every planned sample in both arms must execute successfully, produce exactly
one successful native terminal result without an error flag, preserve workspace
scope, and yield a finite metric within the fixture's bounds. Missing reasoning
metadata, failed output validation, oracle process errors, partial sampling,
deadlines, cleanup failures, or recording failures keep the case failed. Missing
observations are never replaced with zero or discarded to obtain a passing arm.

| Fixture family | Exact task and scope contract | Additional ON requirement | Measurement |
| --- | --- | --- | --- |
| `claude-dedicated-tools-vs-bash` | Read-only workspace; native final JSON maps all five `src/` paths to their exact exported symbol names | Zero Bash calls in every ON sample | Total Bash tool calls |
| `opus-4-7-effort-match-trivial` | Read-only workspace; native final JSON contains the exact version string | Correct answer in every ON sample | Native `usage.output_tokens_details.thinking_tokens` |
| `opus-4-7-literal-interpretation` | Only `src/auth.ts`, `src/billing.ts`, and `src/notifications.ts` may change; public tests stay frozen; independent behavior checks run outside the writable fixture | All three target behaviors pass in every ON sample | Correct target behaviors, 0..3 |

Each family also has a `-sonnet` case. Output validation checks the native final
answer, so a correct word mentioned earlier cannot conceal a wrong final answer.
The read-only prompts explicitly request the JSON shape. These exact-answer
prompts are new in v2: compare ON/OFF within the same contract and fixture, not
across versions. In particular, never compare the current literal correctness
metric to historical counts of edited files.

OFF literal samples can validly complete 0..3 behaviors; that is the measured
control variable. OFF dedicated-tool samples can validly use Bash. ON must meet
the exact requirements above even when its comparison shows a large improvement.
Scope is checked again after the implementation oracle because importing a
repaired module can itself change files. Each oracle must emit its unique
completion marker after its assertions; an implementation exiting zero during
import cannot masquerade as a passing behavior.

## Comparative research results

The original numeric comparators remain unchanged: at least 20% fewer Bash calls
or reported reasoning tokens, and at least 20% more correct literal targets.
Their `criterionMet` values, means, and raw per-arm metrics remain in aggregate
artifacts. They do not decide the v2 behavior verdict.

| Comparison status | Meaning |
| --- | --- |
| `improved` | The original numeric criterion was met |
| `baseline_saturated` | Every OFF sample reached the metric's optimum; no demonstrated marginal benefit |
| `no_measured_improvement` | Complete measurements did not meet the original criterion |
| `regressed` | ON's mean was worse in the metric's declared direction |
| `unsupported_hypothesis` | The resolved overlay does not contain the claimed intervention |
| `incomplete` | Missing or invalid measurements; the behavior case also fails |

Equality at the optimum is behavior success with `criterionMet: false`, never a
percentage improvement. An effort case can pass correctness while its measured
reasoning-token comparison is `regressed`; that regression remains visible.
The product asks models to match effort to complexity and does not promise a
universal 20% token reduction. There is no calibrated resource ceiling,
non-inferiority margin, or powered sampling scheme in this contract. Any future
resource regression gate needs a separately agreed practical margin, baseline
distribution, sampling design, and decision rule before collecting new results.

## Retired fanout cases

The current resolved `model-overlays/opus-4-7.md` and its inherited `claude.md`
contain no fanout instruction. The paid cases `opus-4-7-fanout-toy`,
`opus-4-7-fanout-realistic`, and their `-sonnet` variants are retired, including
their paid wrappers and selection entries. They are not renamed successes.
Reintroducing a paid batching efficacy experiment requires an actual product
claim and a discriminating experiment.

Free regressions retain native first-message fragment grouping, tool-ID
deduplication, and the original fanout comparator. This metric measures message
batching and cannot establish wall-clock execution concurrency.

## Evidence and execution

Run directories and Bun/native attempt identities remain unique. Artifact files
use exclusive creation; retry attempts cannot overwrite earlier raw streams,
measurement records, workspace snapshots, or aggregate verdicts. Native events
are saved before yielding them, including streams that later throw. A validated
measurement records once; a separate aggregate records the case verdict with
zero additive cost and time. Failed writes retain partial evidence and fail the
case. Versioning never rewrites historical artifacts.

The paid runner executes one overlay wrapper per shard and one wrapper at a
time, disables Bun retries, and preserves native rate-limit retry evidence. At
finalization, workers must settle before workspace cleanup begins. Both share
the existing five-second grace; expiry fails the case and prevents late workers
from starting cleanup. Each fixture keeps its original turn cap, concurrency,
30-minute work budget, and recording grace. The six
wrappers remain periodic-tier cases; free tests exercise deterministic outcomes
without making model calls. A free pass validates the instrument, not live model
behavior or a positive efficacy claim.
