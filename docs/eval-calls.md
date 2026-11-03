# Eval call plans: pricing a paid gate without running it

A paid gate (a benchmark, an eval smoke, any command that calls a model
provider for money) is priced before anyone approves it. gstack does not run
the gate, or any other repository command, to learn its cost. The repository
commits a **call-plan file**: plain data that names the exact gate command, the
commit and inputs it was computed from, and one line per call purpose with its
model and token counts. `gstack-eval-plan price-gate` reads that file, checks
that it still describes what is being approved, prices it from
`lib/pricing.ts`, and writes a receipt. Plan: field wave CD2
(`docs/designs/GSTACK_FIELD_WAVE_2026_10_12.md`, gate decision d5b as amended).

```bash
gstack-eval-plan price-gate --gate-file <file> --cap-usd 20 [--smoke-cap-usd 2] [--plan-file <file>]
```

`--gate-file` reads the exact gate command from a file (one trailing newline is
dropped), so a command with quotes or `$` never passes through a shell string;
`--gate "<command>"` takes it inline. Give one of the two.

## Where the file comes from

1. `--plan-file <file>`: an operator-given file, read from disk.
2. Otherwise `price_file` in `.gstack/pregate.json` as committed on
   `origin/<base>` (`--base`, default origin/HEAD's branch unless that is the
   checked-out branch, then the PR's base, `main` or `master`): a repo-relative
   path whose bytes are read from the **HEAD commit** (`git show HEAD:<path>`),
   never from the working tree.

Nothing in the file is executed: not the gate command, not a precondition,
not an input path. The file is parsed as text.

## File format, wire version v1

```
# gstack eval call plan, wire format v1 (docs/eval-calls.md); priced by `gstack-eval-plan price-gate`, never executed
GSTACK_EVAL_GATE v1: bun run eval:synopsis --questions 50 --arms opus,sol
GSTACK_EVAL_HEAD v1: 0123456789abcdef0123456789abcdef01234567
GSTACK_EVAL_INPUT v1: sha256=<64 hex> path=evals/synopsis/questions.jsonl
GSTACK_EVAL_PRECONDITION: ANTHROPIC_API_KEY and OPENAI_API_KEY set at run time
GSTACK_EVAL_CALLS v1: purpose=answer model=anthropic/claude-opus-5-5 calls=100 in_tokens=400000 out_tokens=200000 max_out_tokens=8192 scope=full
GSTACK_EVAL_CALLS v1: purpose=judge model=gpt-6.1-sol calls=100 in_tokens=300000 out_tokens=50000 max_out_tokens=2048 scope=full
GSTACK_EVAL_CALLS v1 end: lines=2
```

| Line | Count | Meaning |
|---|---|---|
| `GSTACK_EVAL_GATE v1: <command>` | exactly 1 | the exact gate command this plan prices; compared to `--gate` by string equality |
| `GSTACK_EVAL_HEAD v1: <sha>` | exactly 1 | the full commit sha the plan was computed at |
| `GSTACK_EVAL_INPUT v1: sha256=<hex> path=<path>` | 0 or more | each input the counts came from (rows, datasets, prompts), repo-relative, no `..` |
| `GSTACK_EVAL_PRECONDITION: <text>` | 0 or more | what must hold at run time; every one is echoed as `GATE_PRECONDITION:` |
| `GSTACK_EVAL_CALLS v1: …` | 0 or more | one line per call purpose (unique `purpose` + `model`) |
| `GSTACK_EVAL_CALLS v1 end: lines=<n>` | exactly 1, last | `n` = the number of call lines; a missing or miscounted end line means a partial producer and refuses |

Blank lines and lines starting with `#` are ignored. Every other line must be
one of the above; an unknown kind, an unknown version (`v2`), a missing or
extra key, a duplicate key, a non-integer count, `calls=0`, or any content
after the end line refuses with `EVAL_DRY_RUN_FAILED`, naming the line.

### Call line keys

| Key | Meaning |
|---|---|
| `purpose` | name of the call purpose (`[A-Za-z0-9._:-]+`), for example `answer`, `judge`, `embed` |
| `model` | model id; a provider prefix (`anthropic/`, `openai:`, `voyage:`) is accepted |
| `calls` | number of calls for this purpose (at least 1) |
| `in_tokens` | **aggregate** input tokens across all of this purpose's calls |
| `out_tokens` | **aggregate** expected output tokens across all of this purpose's calls |
| `max_out_tokens` | the **per-call** output reservation (the `max_tokens` the call sends) |
| `scope` | `full` (the counted run) or `smoke` (a small pre-run check) |

The aggregate totals are what the purpose is expected to cost:
`usd = price(in_tokens, out_tokens)`. The per-call reservation is what one call
can cost at most, which is what a provider or a spend ledger reserves:
`reservation_usd = price(ceil(in_tokens / calls), max_out_tokens)`.

## Binding checks (`EVAL_PLAN_STALE`)

The plan refuses, with no receipt, when it no longer describes what is being
approved:

- the `GSTACK_EVAL_GATE` command differs from `--gate` by even one character;
- the `GSTACK_EVAL_HEAD` commit is not HEAD and any file other than the plan
  file itself changed between them (a committed plan file sits one commit on
  top of the head it was computed at, so its own commit is allowed);
- an input's sha256 of its bytes in the HEAD commit differs from its
  `GSTACK_EVAL_INPUT` line, or the input is not in HEAD;
- the base policy declares a `price_file` that is not in the HEAD commit.

`--allow-unpriced` never overrides these: only a gate with no plan declared at
all, or a plan with zero call lines, is unpriced.

## Pricing outcomes

```
GATE_PLAN: file=evals/gate.calls source=price_file sha256=<hex> head=<sha12> inputs=1 verified
GATE_PRECONDITION: ANTHROPIC_API_KEY and OPENAI_API_KEY set at run time
GATE_CALLS: purpose=answer model=anthropic/claude-opus-5-5 calls=100 usd=5.6 reservation_usd=0.17984 scope=full
GATE_CALLS: purpose=judge model=gpt-6.1-sol calls=100 usd=1.1 reservation_usd=0.02648 scope=full
CHECK: reservation-fits-cap ok (largest one-call reservation $0.1798)
GATE_PRICE: total=6.7 calls=200 purposes=answer,judge receipt=.gstack/tmp/price-gate/price-gate-<gate12>-<head12>.json
```

| Outcome | Exit | Code |
|---|---|---|
| priced, under the caps | 0 | — |
| a model with no row in `lib/pricing.ts`: that row and the total print `unknown`, never zero | 1 | `EVAL_PRICE_MISSING` |
| total above `--cap-usd` | 1 | `EVAL_GATE_OVER_CAP` |
| one call's reservation above `--cap-usd`, or above `--smoke-cap-usd` for a `scope=smoke` row (`CHECK: reservation-fits-cap exceeds (…)`) | 1 | `EVAL_GATE_OVER_CAP` |
| no plan declared (no `--plan-file` and no `price_file` key) or a file with zero call lines | 1 | `EVAL_GATE_UNPRICED` |
| the same with `--allow-unpriced "<reason>"` | 0 | prints `GATE_UNPRICED_OVERRIDE: <reason> (owner-authorized override; not authorization to spend)` and records it |
| malformed or partial file | 1 | `EVAL_DRY_RUN_FAILED` |
| stale binding, or a declared `price_file` missing from HEAD (not overridable) | 1 | `EVAL_PLAN_STALE` |
| `origin/<base>` unresolvable while reading `price_file` | 3 | `POLICY_SOURCE_UNAVAILABLE` |
| `.gstack/pregate.json` on the base is invalid | 3 | `PREGATE_CONFIG_INVALID` |
| unknown flag or missing `--gate` | 2 | usage |

The price is an estimate: the table prices standard text tokens and excludes
the billing categories listed in `lib/pricing.ts` (cache writes, tool fees,
service tiers and long-context surcharges, media tokens, seat-metered runs).

## Receipt

Every outcome past the binding checks writes a JSON receipt to `--out`
(default `<repo>/.gstack/tmp/price-gate/`), named
`price-gate-<gate sha256 12>-<head 12>.json`, and prints its path on the
`GATE_PRICE:` line. `--json` prints the receipt (plus `receipt_path`) instead
of the lines.

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `kind` | `gstack-eval-price-gate` |
| `created_at`, `gstack_revision` | when, and which gstack (VERSION and commit) priced it |
| `gate_command`, `gate_sha256` | the approved command and its sha256 |
| `head_sha` | HEAD when priced |
| `plan` | `file`, `source` (`flag`, `price_file`, `none`), `sha256` of the plan file bytes, `declared_head` |
| `inputs` | each `{ path, sha256 }`, verified at HEAD |
| `preconditions` | every precondition line |
| `rows` | each call line plus `usd` and `reservation_usd` (`null` when unpriced) |
| `total_usd`, `calls`, `purposes` | the totals; `total_usd` is `null` when unknown |
| `cap_usd`, `smoke_cap_usd` | the caps passed, or `null` |
| `result`, `code` | `priced`, `price_missing`, `over_cap`, `unpriced`, `unpriced_override`, and the result code |
| `unpriced_reason`, `unpriced_override` | why the gate is unpriced, and the owner's override reason |
| `excluded_billing` | the billing categories the estimate leaves out |

## Reference emitter

A consuming repo writes the file from the same code that builds its calls, so
the counts cannot drift from the run. `formatEvalCalls` in `lib/eval-plan.ts`
is the reference; copy it:

```ts
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const KEYS = ['purpose', 'model', 'calls', 'in_tokens', 'out_tokens', 'max_out_tokens', 'scope'] as const;
type Row = { purpose: string; model: string; calls: number; in_tokens: number; out_tokens: number; max_out_tokens: number; scope: 'full' | 'smoke' };

export function formatEvalCalls(p: { gate: string; head: string; inputs: { path: string; sha256: string }[]; preconditions: string[]; rows: Row[] }): string {
  return [
    '# gstack eval call plan, wire format v1 (docs/eval-calls.md); priced by `gstack-eval-plan price-gate`, never executed',
    `GSTACK_EVAL_GATE v1: ${p.gate}`,
    `GSTACK_EVAL_HEAD v1: ${p.head}`,
    ...p.inputs.map(i => `GSTACK_EVAL_INPUT v1: sha256=${i.sha256} path=${i.path}`),
    ...p.preconditions.map(t => `GSTACK_EVAL_PRECONDITION: ${t}`),
    ...p.rows.map(r => `GSTACK_EVAL_CALLS v1: ${KEYS.map(k => `${k}=${r[k]}`).join(' ')}`),
    `GSTACK_EVAL_CALLS v1 end: lines=${p.rows.length}`,
  ].join('\n') + '\n';
}

// Count tokens the way the run will, without calling a provider, then:
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const input = 'evals/synopsis/questions.jsonl';
const sha256 = createHash('sha256').update(readFileSync(input)).digest('hex');
// writeFileSync('evals/gate.calls', formatEvalCalls({ gate, head, inputs: [{ path: input, sha256 }], preconditions, rows }));
```

Hash the inputs as committed (the file at HEAD), produce the plan at a clean
HEAD, commit the plan file on its own commit, and set
`"price_file": "evals/gate.calls"` in `.gstack/pregate.json`.

## Related

- `gstack-eval-plan dry-run --cap <usd>` runs the same reservation-fits-cap
  check for an eval's arms: one call (the largest row's input plus the output
  budget), priced, must fit under the cap.
- Result codes: [EVAL_GATE_UNPRICED](troubleshooting.md#eval-gate-unpriced),
  [EVAL_GATE_OVER_CAP](troubleshooting.md#eval-gate-over-cap),
  [EVAL_PLAN_STALE](troubleshooting.md#eval-plan-stale),
  [EVAL_PRICE_MISSING](troubleshooting.md#eval-price-missing),
  [EVAL_DRY_RUN_FAILED](troubleshooting.md#eval-dry-run-failed).
