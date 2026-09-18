# eval-sdk

Synthetic product documentation for this review fixture. The eval-sdk implementation
is not included or installed here; the commands below describe its assumed existing
interface. They are not claims that this fixture can execute an SDK evaluation.

Evaluate an application's outputs against caller-supplied cases. Python 3.10 or
later; install the assumed package with `pip install eval-sdk`. The library is
`eval_sdk`; the companion command is `eval-sdk`.

Confirm the installed package version with `python -m pip show eval-sdk` and
the interpreter with `python --version`; neither command starts an evaluation.

During beta the published API and configuration contract remain compatible.
Breaking changes need a versioned migration guide and deprecation notice for two
minor releases before removal in a breaking release. See [upgrades](docs/reference-v1.md#upgrades).

## Quick start

This neutral example is mirrored in the getting-started guide. The existing
product's offline release checks verify both copies and their output contract.
The fixture does not run those product checks.

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

The application supplies the metric and decides what scores are acceptable;
the SDK has no default quality bar. Fixture checks reproduce this text with an
explicit assumed-contract double; they do not execute the absent SDK.

To use this same example in pytest, put it inside `test_ready()` in a `test_*.py`
file and add the application's own assertion:

```python
assert all(case.score == 1.0 for case in result.cases)
```

This assertion is the application's exact-match acceptance rule, not an SDK
default. See the [API and pytest reference](docs/reference-v1.md#api-and-pytest).
The example remains one ordinary passing case; it has no staged regression.

Before substituting a real callable, read [deadlines and provider costs](docs/reference-v1.md#configuration).
The SDK cannot cap spending by arbitrary application code; that code must use a
bounded provider client or enforce its own limits. The [worked application client](docs/getting-started.md#bounded-application-calls)
shows separate request timeouts, retry limits and cost reservations; the reference
distinguishes these from SDK-managed configuration.

**Current first-run requirement:** both the library and CLI block the first eval
for the mandatory five-minute compatibility/conformance check. There is no skip.
The diagnostic report is not consumed by evaluation. No first-run duration has
been measured, and no time-to-hello-world promise is made here.

[Getting started and free-text example](docs/getting-started.md).
[Stuck while getting started?](docs/feedback.md).
[CLI, configuration, errors, and upgrades](docs/reference-v1.md).

This is ordinary documentation, with no interactive demo or designed aha sequence.
The beta launch still has no selected primary developer persona or peer-DX study.
