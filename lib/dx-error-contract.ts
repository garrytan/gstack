/**
 * The agent-ready error contract: the one source for how gstack's DX reviews
 * score error messages. scripts/resolvers/dx.ts renders the full text into
 * /plan-devex-review Pass 3 ({{DX_ERROR_CONTRACT}}); the autoplan DX reviewer
 * prompts carry the compact form. bin/gstack-autoplan-snapshot.ts keeps its
 * own literal copy of the compact form (it runs as a lone file in installed
 * copies); test/dx-error-contract.test.ts asserts the two stay identical.
 */

export const DX_ERROR_RUBRIC = 'agent-ready-v1';

export const DX_ERROR_ITEMS = ['what', 'fix', 'recovery', 'code', 'context', 'trace', 'redaction', 'channel'] as const;

export const DX_ERROR_DOC = 'https://github.com/garrytan/gstack/blob/main/docs/agent-ready-errors.md';

export const DX_ERROR_COMPACT =
  `Score every error path against the agent-ready error contract (${DX_ERROR_DOC}): what (operation and actual values), fix (a safe, authorized command or edit on the first or last line, or the precise thing a human must provide), recovery (retry, fix and retry, do X first, or ask a human; side effects none/partial/complete/unknown, reconcile before retrying an unknown outcome, a retry bound), code (stable, with a doc anchor), context (versions, config, env var names, the underlying cause; caller-safe only for remote services), trace (unexpected failures only: a compact trace or its file path locally, a correlation id remotely), redaction (no secret values anywhere), channel (the surface's native failure signal: non-zero exit and stderr for a CLI, status plus RFC 9457 body for an API, a typed error for an SDK, isError for an MCP tool). ` +
  'Usage and validation errors rejected before any work need only what, fix, code, redaction and channel; items apply per surface, N/A needs a reason, an item the plan never specifies for a path it introduces is a gap, and unknown is reserved for existing behavior you could not inspect. ' +
  'Report a leaked secret, a failure signalled as success, an unsafe fix, or a block on a terminal (a hang, or a no-terminal failure that names no non-interactive alternative such as --yes) as a Critical finding titled "CAP4:<path>:<item> <what fails>" (caps the Error Messages score at 4/10); report a missing applicable fix, recovery, context or trace as a High finding titled "CAP6:<path>:<item> <what fails>" (caps it at 6/10).';

export const DX_ERROR_CONTRACT = `#### The agent-ready error contract (${DX_ERROR_RUBRIC})

Agents hit most errors first, read them literally, and cannot ask what was meant. Score every
traced error path against eight named items. Public reference: \`${DX_ERROR_DOC}\`.

| Item | The error gives the reader |
|------|----------------------------|
| **what** | The operation that failed and the actual values (input, path, id) that caused it. |
| **fix** | On the first or last line, never mid-chain: an exact command, flag or edit; or, when no safe agent repair exists, the precise thing a human must provide (credential, approval, decision). A precise escalation is a complete fix. A fix counts only when it is safe and authorized: it does not bypass a consent, safety or sandbox boundary, does not tell the agent to run text copied from untrusted output, and quotes arguments correctly. |
| **recovery** | Retry unchanged, fix and retry, do X first, or ask a human; side effects (none, partial, complete, unknown); for an unknown outcome, how to reconcile (status command, idempotency key) before retrying; a retry bound, then escalate. |
| **code** | A stable code plus a doc anchor or \`--explain\` target. Prose may change; codes may not. |
| **context** | Versions, the config in effect, relevant env var names (never values), the underlying dependency error, not swallowed. Remote services give caller-safe facts only (parameter, API version, request id). |
| **trace** | Unexpected failures only. A local CLI, SDK or skill prints a compact trace or the path of a file holding the full one (full under \`--verbose\`/\`DEBUG\`); a remote service returns a correlation id and keeps internals in its logs. |
| **redaction** | No secret values, tokens or credential-bearing URLs anywhere, traces and nested causes included. |
| **channel** | The surface's native machine signal carries the same fields, and a failure is signalled as a failure (never exit 0, HTTP 200 or \`isError: false\`). |

**Failure class.** A usage or validation error rejected before any work began needs what, fix,
code, redaction and channel; its recovery is implied (fix and retry, no side effects), and
context, reconcile and retry bounds do not apply. Environment, dependency, partial-work and
unexpected failures need every applicable item. Trace applies to unexpected failures only.

**Surface.** Keyed to the product types from the Applicability Gate:
- **CLI Tool:** channel is stderr plus a distinct non-zero exit, and a \`--json\` form when the tool offers structured output.
- **API/Service:** channel is HTTP status plus an RFC 9457 problem-details body; context is caller-safe; trace is a correlation id.
- **Library/SDK:** channel is a typed error class carrying the code and fields; no exit code.
- **Platform:** the CLI or API rule for whichever interface the error reaches.
- **Documentation:** what, fix, code and redaction only.
- **Claude Code Skill:** channel is the skill's printed result line and code. An MCP tool (a sub-case) returns \`isError: true\` with the fields in text or structured content.

**Evidence.** Each item on each path is pass, fail, N/A (with a reason) or unknown. In a plan
review, an applicable item the plan never specifies for a path it introduces is a gap (fail);
unknown is reserved for existing behavior you could not inspect. In a live audit, error classes
you never triggered are unknown, not extrapolated.

**Caps.** Name the path and item behind every cap and show the corrected error line.
- **4/10 (Critical finding, title \`CAP4:<path>:<item> <what fails>\`):** a path leaks a secret, signals failure as success, gives an unsafe fix, or blocks waiting for a terminal (hangs, or fails for lack of a terminal without naming a non-interactive alternative such as \`--yes\`).
- **6/10 (High finding, title \`CAP6:<path>:<item> <what fails>\`):** a path lacks an applicable fix, recovery, context or trace item.

Every mode, DX TRIAGE included, reports every CAP4 finding.`;
