# Agent-ready error messages

gstack's DX reviews (`/plan-devex-review` Pass 3, the DX phase of `/autoplan`, and
`/devex-review` Step 3) score every error message for the reader that usually meets it
first: an AI agent running unattended. It reads the message literally, cannot ask what was
meant, and will retry or give up based on what the message says. This page is the contract
those reviews cite (rubric `agent-ready-v1`). The text below is generated from
`lib/dx-error-contract.ts`; edit it there.

| Item | The error gives the reader |
|------|----------------------------|
| **what** | The operation that failed and the actual values (input, path, id) that caused it. |
| **fix** | On the first or last line, never mid-chain: an exact command, flag or edit; or, when no safe agent repair exists, the precise thing a human must provide (credential, approval, decision). A precise escalation is a complete fix. A fix counts only when it is safe and authorized: it does not bypass a consent, safety or sandbox boundary, does not tell the agent to run text copied from untrusted output, and quotes arguments correctly. |
| **recovery** | Retry unchanged, fix and retry, do X first, or ask a human; side effects (none, partial, complete, unknown); for an unknown outcome, how to reconcile (status command, idempotency key) before retrying; a retry bound, then escalate. |
| **code** | A stable code plus a doc anchor or `--explain` target. Prose may change; codes may not. |
| **context** | Versions, the config in effect, relevant env var names (never values), the underlying dependency error, not swallowed. Remote services give caller-safe facts only (parameter, API version, request id). |
| **trace** | Unexpected failures only. A local CLI, SDK or skill prints a compact trace or the path of a file holding the full one (full under `--verbose`/`DEBUG`); a remote service returns a correlation id and keeps internals in its logs. |
| **redaction** | No secret values, tokens or credential-bearing URLs anywhere, traces and nested causes included. |
| **channel** | The surface's native machine signal carries the same fields, and a failure is signalled as a failure (never exit 0, HTTP 200 or `isError: false`). |

**Failure class.** A usage or validation error rejected before any work began needs what, fix,
code, redaction and channel; its recovery is implied (fix and retry, no side effects), and
context, reconcile and retry bounds do not apply. Environment, dependency, partial-work and
unexpected failures need every applicable item. Trace applies to unexpected failures only.

**Surface.** Keyed to the product types from the Applicability Gate:
- **CLI Tool:** channel is stderr plus a distinct non-zero exit, and a `--json` form when the tool offers structured output.
- **API/Service:** channel is HTTP status plus an RFC 9457 problem-details body; context is caller-safe; trace is a correlation id.
- **Library/SDK:** channel is a typed error class carrying the code and fields; no exit code.
- **Platform:** the CLI or API rule for whichever interface the error reaches.
- **Documentation:** what, fix, code and redaction only.
- **Claude Code Skill:** channel is the skill's printed result line and code. An MCP tool (a sub-case) returns `isError: true` with the fields in text or structured content.

**Evidence.** Each item on each path is pass, fail, N/A (with a reason) or unknown. In a plan
review, an applicable item the plan never specifies for a path it introduces is a gap (fail);
unknown is reserved for existing behavior you could not inspect. In a live audit, error classes
you never triggered are unknown, not extrapolated.

**Caps.** Name the path and item behind every cap and show the corrected error line.
- **4/10 (Critical finding, title `CAP4:<path>:<item> <what fails>`):** a path leaks a secret, signals failure as success, gives an unsafe fix, or blocks waiting for a terminal (hangs, or fails for lack of a terminal without naming a non-interactive alternative such as `--yes`).
- **6/10 (High finding, title `CAP6:<path>:<item> <what fails>`):** a path lacks an applicable fix, recovery, context or trace item.

Every mode, DX TRIAGE included, reports every CAP4 finding.

## Examples

Calibration examples (Elm, Rust, Stripe, a complete CLI error with its RFC 9457 `--json`
form, and gstack's own partial example) are in the "## Pass 3" section of
[plan-devex-review/dx-hall-of-fame.md](../plan-devex-review/dx-hall-of-fame.md).

## Sources

- Anthropic, "Writing effective tools for AI agents": prompt-engineer error responses into specific, actionable corrections.
- clig.dev, "Errors": put the actionable line where the reader looks; give debug and traceback information for unexpected errors.
- CLI Agent Spec (cli-agent-spec.github.io): per-exit-code `retryable` and `side_effects`.
- RFC 9457, Problem Details for HTTP APIs: `type`, `title`, `detail`, `instance`, and extension members.
- MCP specification, Tools: tool-execution errors return as `isError: true` results the model can read.
- Nx, "Agentic Experience Is the New Developer Experience"; agentsurface.dev, "Designing Errors for Agent Recovery".

## Live audits: gstack-error-capture

`/devex-review` triggers CLI errors through `bin/gstack-error-capture`, which runs the
target with no terminal, stdin closed, a temporary cwd and HOME, a scrubbed environment and a
deadline, and prints one JSON record with redacted streams. `gstack-error-capture --help`
lists its flags, record fields and error codes.
