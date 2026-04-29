# Vertical Intelligence Flywheel

The Vertical Intelligence Flywheel helps GStack and OpenClaw users turn repeated,
human-approved work into compact context, evals, and redacted training-ready
artifacts.

This PR does not train a model. It creates the local harness that makes future
retrieval, evals, prompt shrinking, and optional open-weight SLM or adapter work
possible.

```text
approved run
  -> redacted trace
  -> compressed context card
  -> eval case
  -> training-ready JSONL
  -> optional future SLM/adapter
```

## Why This Exists

Many GStack and OpenClaw users build vertical businesses: real estate, legal
ops, local services, healthcare admin, insurance, finance ops, and similar
domains. Their repeated workflows are valuable because they encode domain
judgment, tone, compliance constraints, and operational preferences.

The flywheel gives those users a way to capture approved work locally and opt in
to stronger reuse over time:

- Compact repeated prompts into Context Cards.
- Convert accepted runs into redacted TraceRecords.
- Turn failure modes into eval cases.
- Export sanitized TrainingExample JSONL when ready.
- Track which workflows are becoming repeatable enough for cheaper routing or
  future SLM experiments.

## Relationship To /learn And GBrain

This does not replace `/learn` or GBrain.

`/learn` manages project-specific patterns, preferences, and pitfalls. GBrain is
the memory and retrieval layer for durable source-of-truth knowledge. The
Vertical Intelligence Flywheel gives both systems better artifacts to learn
from:

- traces
- context cards
- evals
- training examples
- workflow metrics

Think of `/learn` as institutional memory, GBrain as retrieval, and the flywheel
as a private corpus builder for approved vertical workflows.

## Privacy Model

The default posture is local-first, opt-in, and redacted by default.

- Store private artifacts under `.gstack/flywheel/`, which is already gitignored.
- Do not store raw PII.
- Keep `raw_input_stored: false` unless the user explicitly provides a sanitized
  fixture.
- Require human review before a trace can become `trainable: true`.
- Treat client-facing messages, pricing advice, regulated domains, and
  compliance-sensitive copy as approval-gated.
- Commit only sanitized examples that are intentionally public.

No telemetry, background sync, external model calls, or training runtime are part
of this flywheel.

## Core Artifacts

### TraceRecord

A TraceRecord summarizes a completed run without preserving raw sensitive input.
It records the workflow, summaries, redaction status, human review outcome,
failure modes, target use, and optional model target metadata.

Typical target path:

```text
.gstack/flywheel/traces/<domain>/<workflow>/<trace_id>.json
```

### ContextCard

A Context Card compresses repeated workflow context into a compact artifact:
goal, stable rules, tool/data contracts, approval gates, eval references, and a
token budget.

Typical target path:

```text
.gstack/flywheel/context-cards/<domain>/<workflow>.md
```

### EvalCase

An EvalCase turns a known success or failure into a holdout check. It should use
redacted input, expected behavior, forbidden behavior, rubric, tags, and source
trace references.

Typical target path:

```text
.gstack/flywheel/evals/<domain>/<workflow>.yaml
```

### TrainingExample

A TrainingExample is a JSONL-ready record with instruction, context, redacted
input, human-approved output, and metadata. It is only a candidate for future
training, not a training command.

Typical target path:

```text
.gstack/flywheel/training/<domain>/<workflow>.jsonl
```

### FlywheelMetrics

Flywheel metrics track whether a workflow is becoming repeatable:

```json
{
  "domain": "real_estate",
  "total_traces": 820,
  "accepted_traces": 641,
  "trainable_traces": 488,
  "redaction_pass_rate": 0.94,
  "avg_context_tokens_before": 3900,
  "avg_context_tokens_after": 850,
  "context_reduction_pct": 78,
  "workflows": {
    "lead_intake": {
      "traces": 210,
      "trainable": 155,
      "eval_cases": 45,
      "acceptance_rate": 0.87,
      "slm_candidate": true
    }
  }
}
```

## Success Metrics

1. **Context shrinkage**
   Reduce repeated prompt/context tokens by 50-80% without reducing eval quality.

2. **Human acceptance**
   Track how often outputs are accepted, edited, or rejected.

3. **Training readiness**
   Count clean, redacted, human-approved examples per workflow.

4. **Eval coverage**
   Track how many workflows have holdout evals and known failure cases.

5. **Inference routing readiness**
   Identify tasks simple enough to route to a cheaper SLM later.

6. **Safety**
   Require PII redaction, human approval gates, and domain-specific checks.

## Practical Data Thresholds

These are planning thresholds, not scientific cutoffs:

| Approved examples | What it is usually enough for |
|---:|---|
| 10-25 | Write a useful first Context Card |
| 25-100 | Create a first eval set and identify repeated failure modes |
| 100-300 | Measure context compression, acceptance rate, and routing categories |
| 500-1,500 | Consider a narrow LoRA/QLoRA experiment for extraction, formatting, classification, or repetitive drafting |
| 2,000-10,000+ | Consider a broader workflow-family adapter experiment |
| 10,000+ plus negative cases | Build a serious proprietary vertical intelligence corpus |

## Model Stance

The flywheel is model-agnostic by design. It should support any future
open-weight SLM or adapter target.

Example model target families:

```yaml
model_targets:
  - family: gemma
    status: example_default
  - family: qwen
    status: supported_by_schema
  - family: llama
    status: supported_by_schema
  - family: mistral
    status: supported_by_schema
  - family: deepseek
    status: supported_by_schema
  - family: custom
    status: supported_by_schema
```

Gemma, Qwen, Llama, Mistral, DeepSeek, and custom models are examples, not
hard-coded dependencies.

## Frontier Models vs Small Models

Use frontier models when the workflow requires ambiguity handling, broad
judgment, complex compliance reasoning, or high-stakes synthesis.

Consider future SLM routing only after the workflow is narrow, repetitive,
well-evaluated, and supported by enough clean examples. Good early candidates
are extraction, formatting, classification, normalization, and highly repetitive
drafting.

## Worked Vertical: Real Estate

Real estate is one illustrative vertical, not the scope of the PR. Good narrow
workflow candidates include:

- lead intake extraction
- CRM field normalization
- listing-copy compliance flags
- showing-intent classification
- follow-up tone/style drafting
- CMA narrative formatting
- transaction-next-action tagging

These are better candidates than "be a full real estate agent." The useful moat
is approved vertical work becoming reusable intelligence.

Example approval-gated workflows:

- Lead intake
- Showing coordination
- CMA notes
- Listing-copy QA
- CRM follow-up
- Transaction checklists
- Market commentary

See `examples/vertical-packs/realtor/` for a sanitized illustrative pack.
