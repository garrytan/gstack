# Getting started

These are documentation examples for the assumed existing SDK. The SDK source,
package and release-check implementation are absent from this review fixture.
Do not run an install or infer a successful execution from these documents.

Install the assumed Python package with `pip install eval-sdk`. The mandatory
five-minute first-run compatibility check applies to both CLI and library evals,
including these examples, with no skip. It is not needed by the evaluator itself.

## Neutral first evaluation

```python
from eval_sdk import evaluate
import json

def target(inputs):
    return {"ready": inputs["enabled"]}

def exact_match(actual, expected):
    # This application's structured-output rule.
    if not isinstance(actual, dict):
        return 0.0
    return float(actual == expected)

cases = [{"inputs": {"enabled": True}, "expected": {"ready": True}}]
result = evaluate(target, cases, exact_match)
print(json.dumps([{"score": case.score, "actual": case.actual, "expected": case.expected}
                  for case in result.cases], sort_keys=True))
```

Shown application output (JSON from the documented structured fields, not SDK repr):

```text
[{"actual": {"ready": true}, "expected": {"ready": true}, "score": 1.0}]
```

Fixture checks reproduce this text with an explicit assumed-contract double and
keep the README copy synchronized. They do not run the absent SDK or measure
onboarding duration.

## Caller-owned metric for free text

This separate reference example supplies a real callable, cases and metric. The
simple whitespace-insensitive metric demonstrates the API; applications choose
their own metric and acceptance rule. It is not a production quality threshold.

```python
from eval_sdk import evaluate
import json

def text_metric(actual, expected):
    return float(" ".join(actual.split()) == " ".join(expected.split()))

def prose_target(inputs):
    return inputs["reply"]

cases = [
    {"inputs": {"reply": "The lamp is green."}, "expected": "The lamp is green."},
]
result = evaluate(prose_target, cases, text_metric)
print(json.dumps([{"score": case.score, "actual": case.actual, "expected": case.expected}
                  for case in result.cases], sort_keys=True))
```

Shown free-text application output (the same explicit field projection):

```text
[{"actual": "The lamp is green.", "expected": "The lamp is green.", "score": 1.0}]
```

The public example returns one normal matching result with score 1.0. Fixture
checks reproduce this text with the contract double, not the absent SDK. Separately,
the existing product's offline checks exercise this complete callable/metric path
with matching and mismatching prose and verify scores 1.0 and 0.0 plus the latter
case's expected/actual failure summary.
Structured result fields retain full values; displayed summaries may truncate.
This reference check already exists in the revised synthetic baseline. It adds
no launch gate, evaluator default, telemetry or designed onboarding delight beat.
No executable SDK or assertion of its execution is supplied in this fixture.

## Bounded application calls

This is a complete **application-owned** example, separate from the SDK. The
local transport below is free and makes no network requests. To substitute a
paid transport, first establish a **verified upper bound** on its charge per
invocation; this example reserves two cents per attempt. A provider without such
a bound cannot use that reservation as a spending guarantee.

Save as `fixture_transport.py`:

```python
import json
import sys

inputs = json.load(sys.stdin)
print(json.dumps({"ready": inputs["enabled"]}))
```

Save as `bounded_client.py`:

```python
import json
import math
import subprocess
import threading

class BoundedClient:
    def __init__(self, command, *, timeout_seconds, max_attempts,
                 total_cents, attempt_cents):
        if (not math.isfinite(timeout_seconds) or timeout_seconds <= 0
                or any(type(n) is not int for n in (max_attempts, total_cents, attempt_cents))
                or max_attempts < 1 or total_cents < 0 or attempt_cents < 1):
            raise ValueError("Use a positive timeout, finite attempts and integer-cent bounds")
        self.command = list(command)
        self.timeout_seconds, self.max_attempts = timeout_seconds, max_attempts
        self.total_cents, self.attempt_cents = total_cents, attempt_cents
        self.reserved_cents = 0
        self.lock = threading.Lock()

    def __call__(self, inputs):
        for attempt in range(self.max_attempts):
            with self.lock:
                if self.reserved_cents + self.attempt_cents > self.total_cents:
                    raise RuntimeError("Application spending limit reached before request")
                self.reserved_cents += self.attempt_cents
            try:
                response = subprocess.run(self.command, input=json.dumps(inputs),
                    text=True, capture_output=True, check=True, timeout=self.timeout_seconds)
                return json.loads(response.stdout)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
                if isinstance(error, subprocess.CalledProcessError) and error.returncode != 75:
                    raise  # Only the application's explicit temporary-failure status retries.
                if attempt + 1 == self.max_attempts:
                    raise RuntimeError("Application attempt limit reached") from error
```

Each transport process gets a per-attempt timeout and at most two attempts below.
`subprocess.run` kills and waits for a timed-out direct child. This local transport
starts no descendant processes. Killing it **does not prove that a remote provider cancelled**
a request: its reservation is **not refunded**, even on timeout or failure. The
shared counter refuses an attempt before the six-cent total would be exceeded;
concurrent calls in this process share that counter. Separate application processes
would need a shared external spending limit.

Use the application client in the callable (save these files together):

```python
import sys
from eval_sdk import evaluate
from bounded_client import BoundedClient

client = BoundedClient([sys.executable, "fixture_transport.py"],
    timeout_seconds=2, max_attempts=2, total_cents=6, attempt_cents=2)

def target(inputs):
    return client(inputs)

def metric(actual, expected):
    return float(isinstance(actual, dict) and actual == expected)

cases = [{"inputs": {"enabled": True}, "expected": {"ready": True}}]
result = evaluate(target, cases, metric, deadline_seconds=20, max_cost_usd=0.25)
```

The client's timeout, attempts and reservation govern its own transport. The
`evaluate` keywords still govern only SDK-managed scheduling/provider requests;
they neither interrupt this application client nor add to its six-cent allowance.
The local client/files run in fixture checks, including timeouts, retries and
refusal before overspending. The `evaluate` call is checked with an explicit
contract double because the SDK is absent. This is reference safety code, not a
new metric default, launch gate, first-run benchmark or onboarding delight step.

## Handling errors

The assumed SDK's existing release checks produce this malformed-case example:

```text
SDK_E001: case 0 is missing 'expected'
Cause: CaseValidationError at cases[0].expected
Next: add the expected output for this case and retry.
Reference: docs/reference-v1.md#sdk-e001
```

This is an authored synthetic output contract, not output obtained by executing
the SDK here. Error codes, originating causes, actionable next steps, secret
redaction, and versioned reference anchors are existing contracts.

## Next steps

- Use the same callable and cases in [pytest](reference-v1.md#api-and-pytest), with
  the application's own acceptance assertion.
- Before substituting a provider-backed callable, configure [deadlines and cost
  limits](reference-v1.md#configuration). Arbitrary application requests require
  their own bounds; SDK-managed limits do not intercept them.
- Run the [noninteractive CLI](reference-v1.md#cli) locally or in CI; the same
  invocation and exit codes apply to both.
- Find [error codes](reference-v1.md#errors), the [beta upgrade contract](reference-v1.md#upgrades),
  and the existing [support path](feedback.md).
