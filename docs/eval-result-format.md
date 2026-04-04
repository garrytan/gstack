# Standard Eval Result Format

This document defines the JSON format that any language can produce and push into gstack's eval infrastructure via `gstack eval push <file>`.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `number` | Format version (currently `1`) |
| `version` | `string` | Version of the tool/system being evaluated |
| `git_branch` | `string` | Git branch name |
| `git_sha` | `string` | Git commit SHA (short or full) |
| `timestamp` | `string` | ISO 8601 timestamp |
| `tier` | `string` | Eval tier: `"e2e"`, `"llm-judge"`, or custom |
| `total` | `number` | Total number of test cases |
| `passed` | `number` | Number of passing test cases |
| `failed` | `number` | Number of failing test cases |
| `total_cost_usd` | `number` | Total estimated cost in USD |
| `duration_seconds` | `number` | Total wall-clock duration in seconds |
| `all_results` | `array` | Array of test result objects (see below) |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `hostname` | `string` | Machine hostname |
| `label` | `string` | Human-readable label for this run |
| `prompt_sha` | `string` | SHA of the prompt(s) used |
| `by_category` | `object` | `{ category: { passed, failed } }` breakdown |
| `costs` | `array` | Per-model cost entries (see below) |
| `comparison` | `array` | A/B comparison entries |
| `failures` | `array` | Structured failure details |
| `_partial` | `boolean` | `true` for incremental saves, absent in final |

## Test Result Entry (`all_results[]`)

Each entry in `all_results` must have:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique test name |
| `passed` | `boolean` | Yes | Whether this test passed |
| `suite` | `string` | No | Suite/group name |
| `tier` | `string` | No | Test tier |
| `duration_ms` | `number` | No | Duration in milliseconds |
| `cost_usd` | `number` | No | Cost for this test |
| `output` | `object` | No | Open-ended output data |
| `turns_used` | `number` | No | LLM conversation turns |
| `exit_reason` | `string` | No | `"success"`, `"timeout"`, `"error_max_turns"`, etc. |
| `detection_rate` | `number` | No | Bugs detected (for QA evals) |
| `judge_scores` | `object` | No | `{ dimension: score }` from LLM judge |
| `judge_reasoning` | `string` | No | LLM judge's reasoning |
| `error` | `string` | No | Error message if test failed |

## Cost Entry (`costs[]`)

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model ID (e.g., `"claude-sonnet-4-6"`) |
| `calls` | `number` | Number of API calls |
| `input_tokens` | `number` | Total input tokens |
| `output_tokens` | `number` | Total output tokens |

## Example

```json
{
  "schema_version": 1,
  "version": "0.3.3",
  "git_branch": "main",
  "git_sha": "abc1234",
  "timestamp": "2025-05-01T12:00:00Z",
  "hostname": "ci-runner-01",
  "tier": "e2e",
  "total": 2,
  "passed": 1,
  "failed": 1,
  "total_cost_usd": 1.50,
  "duration_seconds": 120,
  "all_results": [
    {
      "name": "login-flow",
      "suite": "auth",
      "passed": true,
      "duration_ms": 60000,
      "cost_usd": 0.75,
      "turns_used": 5
    },
    {
      "name": "checkout-flow",
      "suite": "commerce",
      "passed": false,
      "duration_ms": 60000,
      "cost_usd": 0.75,
      "error": "Timed out waiting for payment confirmation"
    }
  ],
  "costs": [
    {
      "model": "claude-sonnet-4-6",
      "calls": 10,
      "input_tokens": 500000,
      "output_tokens": 250000
    }
  ]
}
```

## Legacy Format

gstack's internal eval system uses a slightly different format (from `test/helpers/eval-store.ts`). The `normalizeFromLegacy()` and `normalizeToLegacy()` functions in `lib/eval-format.ts` handle conversion:

| Legacy field | Standard field |
|-------------|---------------|
| `branch` | `git_branch` |
| `total_tests` | `total` |
| `total_duration_ms` | `duration_seconds` (÷ 1000) |
| `tests` | `all_results` |

## Validation

Use `gstack eval push <file>` to validate and push a result file. Validation checks:
- All required fields present with correct types
- `all_results` is an array of objects
- Each entry has `name` (string) and `passed` (boolean)

## Pushing Results

```bash
# Validate + save locally + push to team Supabase (if configured)
gstack eval push my-eval-results.json

# From any language — just write JSON and push:
python run_evals.py --output results.json
gstack eval push results.json
```
