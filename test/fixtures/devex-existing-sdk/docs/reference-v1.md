# Existing SDK reference, version 1

These are explicitly authored contracts for the revised synthetic fixture.
The SDK, package, and release-check implementation are absent. SDK invocation
examples describe its assumed interface; those calls have not been executed against
the SDK here. Fixture checks execute the local application files and explicit
contract doubles. This reference supplies baseline documentation, not launch remedies.

## API and pytest

`evaluate(target, cases, metric)` invokes the application's callable on each
case's `inputs` and calls its metric with actual and expected outputs.
`result.cases` contains per-case `score`, `actual`, and `expected` fields.
The application supplies its acceptance rule; no score is a universal pass bar.

```python
from eval_sdk import evaluate

def test_ready():
    def target(inputs):
        return {"ready": inputs["enabled"]}

    def exact_match(actual, expected):
        return float(isinstance(actual, dict) and actual == expected)

    cases = [{"inputs": {"enabled": True}, "expected": {"ready": True}}]
    result = evaluate(target, cases, exact_match)
    assert all(case.score == 1.0 for case in result.cases)
```

`python -m pytest` runs this application-owned test. Public type hints and
`py.typed` ship; the assumed release checks type-check the examples and run their
documented outputs. This reference test remains a neutral passing example.

## Configuration

The existing optional library keywords are `deadline_seconds`, `max_cost_usd`,
and `reporter` (`"auto"`, `"on"`, or `"off"`). For example:

```python
result = evaluate(target, cases, metric, deadline_seconds=20,
                  max_cost_usd=0.25, reporter="on")
```

The deadline stops new case scheduling and is forwarded to SDK-managed provider
requests. Their request timeouts and finite retries remain bounded by it.
The cost ceiling covers only requests through that managed provider client.
It cannot interrupt arbitrary application code or cap requests made by a separate
client inside `target`; configure that client's timeout, retries, and spending
limit before substituting the callable. The [worked application client](getting-started.md#bounded-application-calls)
materializes all three bounds with a local transport and explains its verified
per-attempt cost assumption. These boundaries apply locally and in CI.

Before work the CLI reports case count, deadline, and cost ceiling (or "none set")
on stderr. The library does so on a TTY by default; `reporter` overrides that
choice. Library reporting never writes to stdout. Values and scores are not
persisted in a shared cache. No settings define an onboarding-time target.

## CLI

The existing noninteractive invocation uses the application's importable target
and metric plus a JSON list of cases. The following complete files are explicit
synthetic baseline examples; the SDK/CLI is absent, so fixture checks validate the
files, import paths and arguments with an assumed-contract double, not the real CLI.
This documents the shown JSON-list form only, not any other possible SDK format.

Save as `app.py`:

```python
def target(inputs):
    return {"ready": inputs["enabled"]}

def metric(actual, expected):
    return float(isinstance(actual, dict) and actual == expected)
```

Save as `cases.json`:

```json
[
  {"inputs": {"enabled": true}, "expected": {"ready": true}}
]
```

Run with the assumed SDK from the directory containing both files:

```bash
eval-sdk run --target app:target --cases cases.json --metric app:metric --deadline-seconds 20 --max-cost-usd 0.25 --no-input
```

The CLI accepts the same bounds and prints readable per-case results. Exit 0
means evaluation completed, not that an application's quality bar was met;
the application-owned pytest assertion enforces that bar. Usage or malformed
inputs exit 2; execution failures exit 1, with the actionable error on stderr.
`eval-sdk --help` lists these options and noninteractive behavior.

Both CLI and library still block their first evaluation for the existing
mandatory five-minute conformance check. There is no skip. This reference does
not bypass, remove, or time that prerequisite.

## Errors

Errors expose a stable code, original cause, actionable next step, and versioned
reference anchor. Secret values are redacted; displayed values may truncate
while structured fields retain full values. Existing release checks verify the
code-to-anchor mapping and example output.

### SDK E001

Missing required case input: identify the case index and missing `inputs` or
`expected` field, then add it and retry. See the shown malformed-case output in
[getting started](getting-started.md#handling-errors).

### SDK E002

The application metric returned a non-number: change it to return a numeric
score. The application still chooses its own acceptable score.

The following E002 and E003 blocks are newly authored synthetic output contracts,
not captured output from the absent SDK or its release checks. They make the
existing code/cause/next-step/reference contract concrete without changing it.

```text
SDK_E002: case 0 metric returned a non-number
Cause: MetricTypeError at cases[0].score (received str)
Next: return a numeric score from the application's metric and retry.
Reference: docs/reference-v1.md#sdk-e002
```

### SDK E003

A configured deadline or managed-provider cost limit was reached: inspect the
reported bound and cause, then reduce the cases or explicitly change that bound.
Unmanaged application requests have the separate limits described above.

Deadline example:

```text
SDK_E003: evaluation deadline reached before case 2
Cause: DeadlineExceeded at deadline_seconds=20
Next: reduce the cases or explicitly choose a longer evaluation deadline.
Reference: docs/reference-v1.md#sdk-e003
```

Managed-provider cost example:

```text
SDK_E003: managed-provider cost ceiling reached before case 2
Cause: ManagedProviderCostLimit at max_cost_usd=0.25
Next: reduce managed-provider work or explicitly choose a higher managed-provider limit.
Reference: docs/reference-v1.md#sdk-e003
```

## Upgrades

Beta releases preserve the published API and configuration contract. Breaking
changes require a versioned migration guide and call-site `DeprecationWarning`
naming the replacement, removal version, and migration anchor. Removal requires
two minor releases of notice and a breaking release. No AST migration tool,
plugin, new hosted documentation service, or new CI provider is part of the beta.
