# Model policy

Use a frontier model to challenge a plan, then a smart model to build it.
These are curated recommendations, not a claim that one model wins every task.
User choices take precedence, and a recommendation never switches the running
session or edits the host's native configuration.

| Tier | Default job | Anthropic | OpenAI |
| --- | --- | --- | --- |
| `frontier` | Independent plan review | `claude-fable-5-1` | `gpt-6-astra` |
| `smart` | Implementation recommendation | `claude-opus-5-5` | `gpt-6.1-sol` |

## Inspect and change your policy

This quickstart assumes gstack is installed. It uses no network, credentials or
paid model calls. Run it from the project's repository root in Bash, Git Bash or MSYS:
automated outside reviews use that directory. Inspection from a subdirectory
reflects that subdirectory's native settings and may differ. If your install is vendored
or elsewhere, set `GSTACK_ROOT` to that installed gstack runtime instead.

```bash
if [ -x "$HOME/.claude/skills/gstack/bin/gstack-models" ]; then
  GSTACK_ROOT="$HOME/.claude/skills/gstack"
elif [ -x "${CODEX_HOME:-$HOME/.codex}/skills/gstack/bin/gstack-models" ]; then
  GSTACK_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/gstack"
else
  printf '%s\n' 'Upgrade the gstack install for your host, then rerun this quickstart.' >&2
  exit 1
fi
"$GSTACK_ROOT/bin/gstack-models" list
"$GSTACK_ROOT/bin/gstack-models" resolve --role plan-review --provider openai
```

The output explains the selected model and which setting won. It also shows
catalog verification metadata. Offline selection does **not** prove that a CLI
is installed, that your account can use the model, or that a vendor's current
catalog has been checked.

Choose the less expensive review tier, then inspect the effective result:

```bash
"$GSTACK_ROOT/bin/gstack-config" set plan_review_tier smart
"$GSTACK_ROOT/bin/gstack-models" resolve --role plan-review --provider openai
```

Pin a provider's model within a tier, or reset a pin to the shipped default:

```bash
"$GSTACK_ROOT/bin/gstack-config" set model_frontier_openai gpt-6-astra
"$GSTACK_ROOT/bin/gstack-config" set model_frontier_claude claude-fable-5-1
"$GSTACK_ROOT/bin/gstack-config" unset model_frontier_openai
"$GSTACK_ROOT/bin/gstack-config" unset plan_review_tier
```

To keep using native CLI model settings for plan reviews:

```bash
"$GSTACK_ROOT/bin/gstack-config" set plan_review_tier host
```

Settings apply to the next invocation without rerendering skills. An invocation
already being checked keeps its selected model through execution. Configuration
uses the existing [gstack state root](state-root.md), not a new per-repository
settings file. Invalid writes are rejected and leave the previous value intact;
use `unset`, not an empty value, to restore a default.

A malformed known setting (for example `plan_review_tier = smart`) stops
selection rather than acting as an absent key. Correct or remove the named line
in the reported config file; `unset` only removes correctly spelled `key:` records.

Codex plan-review readiness and dispatch share one deadline. Readiness is
budgeted half the remaining time, with the existing termination grace. A slow
preflight leaves less time for the review instead of extending the caller's
limit. An expired deadline starts no new command and means missing review
coverage, not a completed review.

## Settings and precedence

| Key | Default | Accepted value |
| --- | --- | --- |
| `plan_review_tier` | `frontier` | `frontier`, `smart`, `host` |
| `implementation_tier` | `smart` | `frontier`, `smart` |
| `model_frontier_claude` | Catalog's Anthropic frontier model | Explicit Anthropic model identifier |
| `model_frontier_openai` | Catalog's OpenAI frontier model | Explicit OpenAI model identifier |
| `model_smart_claude` | Catalog's Anthropic smart model | Explicit Anthropic model identifier |
| `model_smart_openai` | Catalog's OpenAI smart model | Explicit OpenAI model identifier |
| `agent_model` | unset (`host`) | `host`, a family or `<provider>/<model>`; see [your model preference](#your-model-preference) |

For plan reviews, a model named for that invocation wins over
`GSTACK_CLAUDE_MODEL` or `GSTACK_CODEX_MODEL`. That environment override wins over
the selected tier's configured model, which wins over the shipped catalog.
Generic coding-model settings do not silently select a cheaper plan reviewer;
choose `host` mode when that is the behavior you want.

In `host` mode, Codex keeps its existing native-config resolution, including
`CODEX_HOME`, active profiles and the `exec` versus native `review` distinction.
Claude can delegate model selection to its CLI without forcing `--model`; the
inspector reports that delegation rather than inventing an exact model ID.
Actual returned model usage remains separate from the requested model.

Implementation recommendations use a model explicitly requested for that job,
then the configured implementation tier and its provider override, then the
catalog. Outside-review environment overrides do not change implementation
recommendations. Known Claude Code and Codex hosts recommend their own provider;
an unknown or multi-provider host can show both choices.

Custom endpoints and partner platforms need an explicitly compatible model or
`host` mode. Gstack does not guess that public API IDs work with Bedrock, Vertex,
Foundry or a custom Codex provider. A model identifier passing syntax validation
is not proof of account availability. See [provider recovery](troubleshooting.md#model-policy-provider).

Detection is conservative, not a replacement for the CLI's settings engine.
Claude checks environment, user settings, project/shared/local settings, local
settings at the repository and worktree's main checkout, and local managed files.
Codex checks environment, user/active-profile settings and system configuration;
project-local Codex config is not inspected.
Any detected local custom-route signal requires an explicit model, even if
native trust or precedence rules might suppress it. Server-managed or MDM
policy and extra native CLI flags are not visible to this check; `--help` and
JSON output list these limits. Use an explicit compatible model for those cases,
or `host` mode for plan reviews. Implementation recommendations require an
explicit implementation model rather than delegating to a hidden native choice.

## Your model preference

gstack takes no position for or against any model. If you prefer one, gstack
remembers it and uses it whenever it picks a model for a working agent: a lane,
a subagent or a reviewer. When it is unset, every agent keeps its own model.

```bash
"$GSTACK_ROOT/bin/gstack-config" set agent_model opus
"$GSTACK_ROOT/bin/gstack-models" resolve --role agent
```

| Value | Meaning |
| --- | --- |
| `host` (the default) | keep the running agent's own model and leave the model field out |
| a family: `opus`, `fable`, `sonnet`, `haiku`, `astra`, `sol`, `luna`, `terra` | today's model in that family (`opus` is `anthropic/claude-opus-5-5`); it moves when gstack's family table moves |
| `<provider>/<model>` | that exact model, for example `anthropic/claude-opus-5-5` |

The first match wins: a request for one job (`resolve --role agent --request sol`,
never saved), then `agent_model` in this machine's config.yaml, then
`agent_model` in the file `GSTACK_PREFERENCES_FILE` names, then `host`. The
output names the winner and shows both stored values; `--json` prints the
provider, model, provider-qualified `id` and source.

Two cases ignore the preference on purpose: a cross-family outside voice (the
`plan-review` role picks the other provider) and a model under test in an eval
(`eval-arms` and `/eval-plan` arms).

A value gstack can't use stops only the agent role, naming the file and the fix.
`plan-review`, `implementation` and `eval-arms` keep resolving, and
`gstack-models list` shows the problem in its agent block.

**On Capy.** Each cloud machine starts fresh, so config.yaml does not carry
over. Keep the preference in `preferences.yaml` next to the gstack skill's
SKILL.md in your Drive: one `agent_model: <value>` line, with `#` comments
allowed (any other key is ignored with a warning). The session start puts the
file's path in the launch file as `GSTACK_PREFERENCES_FILE` and gstack reads it
where it is: nothing is copied, and `--check` never writes the skill folder. Agents write that
file only when you ask them to remember a preference. To change or clear it for
good, edit or delete that line; `gstack-config unset agent_model` clears this
machine only. Copying a newer `capy/skill/gstack/` over the skill folder leaves
`preferences.yaml` alone, because the shipped folder has no such file.

A Capy session with no gstack checkout (a Captain or coordinator that runs
`install.sh --check --for none`) can't run the resolver, so the skill tells it
to read the `agent_model` line itself. There a family means the newest model of
that family the host lists, while the resolver maps each family to the id in
its table (today they agree: `opus` is `anthropic/claude-opus-5-5`). Anything
it can't use means the session keeps its own model and says so.

## Reasoning effort

Codex calls carry a `model_reasoning_effort`. It follows the same shape as the
model: a per-request flag on `/codex`, a per-run environment override, then a
stored setting, then the default each gate ships with.

| Order | Source | Set it with |
| --- | --- | --- |
| 0 | `/codex ... --effort <level>` (this request only; `/codex` alone) | `/codex review --effort medium` |
| 1 | `GSTACK_CODEX_EFFORT` (this shell, this run) | `export GSTACK_CODEX_EFFORT=max` |
| 2 | `codex_effort` in config.yaml | `gstack-config set codex_effort low` (`unset` restores the defaults) |
| 3 | the gate's default | nothing: `high` for reviews, plan reviews and `/codex` review and challenge; `medium` for `/codex` consult and design direction |

Levels: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Support is
model-dependent, so an unsupported level for your model fails at request time
through the usual model error. An invalid value never reaches Codex:
`gstack-config set` rejects it, and `gstack-codex-probe run-with-timeout --effort
<default>` (which resolves the order above and appends the flag) stops the call
before anything is sent, naming the source to fix. `gstack-codex-probe
check-effort <default>` prints the same resolution without a call.

For one request, `/codex review --effort medium` (or `--effort=<level>`; `--xhigh` is
shorthand for `--effort xhigh`) outranks the other three, including an exported
`GSTACK_CODEX_EFFORT`, and changes nothing that persists. The flag counts only
directly after `/codex` or its mode word, among the leading flags (`-m`/`--model`,
`--role`, in any order) and before the prompt text; a later `--effort` is part of the
prompt, and `/codex` says so. A Consult follow-up resolves its effort afresh. `/codex` passes the level to the probe as `--request-effort`,
so an unknown level stops before any Codex call, naming the flag.

`/spec`'s quality gate keeps `medium` inside its 120-second budget whatever you
set, because a higher effort would spend the time the gate is sized for.
`gstack-models list` prints the effective effort and where it came from
(`--json`: `codexEffort`). The Claude Code runner takes no effort setting.

### Review effort tiers

The core checklist, the Red Team, the native adversarial pass and the
fix-check run at `full` effort, the lane's reasoning. Specialists run at
`medium`, reasoning medium on the same model (GSTA-167 part 3: the no-loss
controls C and C2 ran them there); light's batched specialist carries the Red
Team prompt and stays `full`. `gstack-review-plan` names each dispatch's effort, and `host` for the outside voice (its provider and
`codex_effort` above). Only work that cannot block runs `light`, the same
model at a medium or low setting and never a cheaper model family: the coverage,
plan-completion and docs audits, decision-trail reviewers and watchers
(`AUDIT_EFFORT:` in the plan's output). A paid replay showed why the fix-check stays
at full: a medium-effort fix-check missed a fail-open in gate code that the same
check at full effort caught. A host that cannot set a subagent's effort runs it
at its default. `gstack-config set review_effort_tiers off` (default `on`)
runs the specialists, audits and watchers at the host default too
([review-policy.md](review-policy.md#review-depth)).

## Which workflows use the tiers?

The plan-review role applies to autoplan's CEO, design, DX and engineering
outside voices; standalone CEO, engineering, developer-experience and design
plan reviews; and the spec quality gate. Existing reasoning effort, access
restrictions, timeouts, review gates and `codex_reviews` consent remain in force.

The host selects the opposing provider independently from the tier. Claude Code
uses the Codex wrapper; Codex uses the Claude Code wrapper. A model's name does
not establish which harness is running.

Manual opposing-model wrappers can opt into `--role plan-review`. Ordinary
code reviews, live design reviews, design consultation, office-hours second
opinions and documentation reviews retain their existing model-selection
behavior. Historical no-role defaults, eval actors/judges, cheap helper models
and setup-time behavioral overlays do not follow this catalog.

Before the first affected paid plan review after upgrade, gstack explains the
independent frontier default and the winning source, with `smart` and `host`
alternatives. Inspection does not mark that notice as seen. Disabled outside
reviews stay disabled; an unavailable model is reported, never silently replaced.

## First completed outside review

Policy setup and a completed review are different milestones. Install and
authenticate the opposing CLI using the [host setup instructions](../README.md#install--about-30-seconds)
before invoking a paid review. From Claude Code, use `/codex consult --role
plan-review`. From Codex, use `/claude-code consult --role plan-review` (or its
installed namespaced name). Ask it to challenge the plan and supply the full plan
text. Consult is prompt-driven and works before there is a repository diff;
Challenge mode is for reviewing code changes.

Confirm the announced selection, the provider's actual result and the coverage
status. A resolved model, a successful availability probe or a native fallback
is not a completed outside review. An unusable explicit choice needs a repair
at the source named in the error; changing a lower-priority tier cannot override
an environment pin. See [selection recovery](troubleshooting.md#model-policy-selection).

## Machine-readable inspection

`gstack-models` with no arguments is `list`. Both `list` and `resolve` accept
`--json`. Plan-review resolution requires `--provider anthropic|openai`;
implementation resolution can omit the provider to return both recommendations.
Agent resolution (`--role agent`) takes no `--provider`; its JSON carries an
`agent` object instead of `selections`, and `list --json` adds the same
top-level `agent` key.

```bash
"$GSTACK_ROOT/bin/gstack-models" resolve --role plan-review --provider anthropic --json
"$GSTACK_ROOT/bin/gstack-models" resolve --role implementation --json
```

JSON output is one document with `schemaVersion: 1`, a `selections` array and
structured errors on failure. Human diagnostics go to stderr. Exit `0` means
valid resolution, including host delegation; `1` means configuration or
selection failure; `2` means invalid usage. Neither inspection nor resolution
writes notice markers, probes a model or fetches vendor sources.

## Keeping shipped recommendations current

The model-policy freshness workflow runs weekly and supports manual dispatch.
It checks official Anthropic and OpenAI recommendation and deprecation sources,
without provider credentials or paid model calls. Normal PR checks use offline
fixtures; a vendor outage does not make unrelated PRs fail.

In GitHub Actions, select **Model-policy freshness** to run it manually. From a
gstack checkout, `bun scripts/model-policy-freshness.ts` performs the same public
source check without changing an issue; unlike `gstack-models`, it uses the
network. The workflow's guarded `--publish` path owns issue updates. Its JSON
report and job summary retain the source evidence.

The report's primary status distinguishes `current`, `update-candidate` and
`unknown/source-unavailable`. Its separate `evidenceStatus` marks retained
successful evidence `stale` after thirty days; a failed fetch remains unknown
in the headline even when that retained evidence is stale.
Newer or newly recommended models are candidates,
not automatic replacements. A support promise such as “not sooner than” is not
a scheduled retirement, and an incidental model mention is not a new default.
This evidence covers public API recommendations, not partner-platform entitlement.

One Actions-bot-owned tracking issue preserves the successful check's catalog/source/
parser identity and any unresolved lifecycle findings. Healthy state remains
readable when the issue is closed. A failed or partial check cannot erase a known
retirement, borrow a success from an older catalog, or pretend its evidence is
fresh. A catalog rollback reopens historical findings for a model put back in
use. Only current default-branch runs may update that issue; copied markers in
user-owned issues are not trusted state.

A documented retain decision preserves the current default, but does not make a
vendor mismatch `current`: the advisory issue stays open, or reopens, while that
candidate remains. Record retain rationales in issue comments, which the workflow
never edits, rather than racing a scheduled update to the issue body.

Thirty-day staleness means an absence of trustworthy freshness evidence, not
that a model was released thirty days ago. An unchanged recommendation does not
require a date-only catalog commit or a monthly paid benchmark. The recorded
next-check due date helps maintenance, but a workflow that never runs cannot
alert on its own absence.

### Maintainer update checklist

1. Check the latest freshness run and its due date. Resolve missing, corrupt or
   source-unavailable evidence before declaring the catalog current.
2. Verify the official recommendation and lifecycle evidence. Triage announced
   retirement/removal within one working day, stale/unavailable evidence within
   seven days and discretionary update candidates within thirty days.
3. Open a catalog change with the source URLs, exact model IDs and qualification
   evidence, or record why the current default should remain. Never edit users'
   personal pins or silently substitute another provider.
4. Confirm CLI model/profile support and tool/reasoning compatibility. Keep the
   pinned test runtimes and benchmark rulers stable. A required CLI upgrade is a
   separate reviewed change, not an automatic side effect of discovery.
5. Predeclare any budgeted baseline/candidate comparison using existing eval
   machinery, fixed prompts/panels and unchanged thresholds. Keep every attempt,
   measure useful and unsupported findings, latency and available usage, and do
   not treat vendor marketing or a creation timestamp as quality evidence.
6. Pass the affected free checks and selected workflow evaluations, review the
   change, and ship it through the normal release process. Only unpinned
   role-bearing defaults follow the new shipped catalog.

The workflow does not open an automatic model-upgrade PR, merge changes, switch
active sessions, alter benchmark models or schedule paid evaluations.
