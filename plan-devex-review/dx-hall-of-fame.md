# DX Hall of Fame Reference

Read ONLY the section for the current review pass. Do NOT load the entire file.

## Pass 1: Getting Started

**Gold standards:**
- **Stripe**: 7 lines of code to charge a card. Docs pre-fill YOUR test API keys when logged in. Stripe Shell runs CLI inside docs page. No local install needed.
- **Vercel**: `git push` = live site on global CDN with HTTPS. Every PR gets preview URL. One CLI command: `vercel`.
- **Clerk**: `<SignIn />`, `<SignUp />`, `<UserButton />`. 3 JSX components, working auth with email, social, MFA out of the box.
- **Supabase**: Create a Postgres table, auto-generates REST API + Realtime + self-documenting docs instantly.
- **Firebase**: `onSnapshot()`. 3 lines for real-time sync across all clients with offline persistence built-in.
- **Twilio**: Virtual Phone in console. Send/receive SMS without buying a number, no credit card. Result: 62% improvement in activation.

**Anti-patterns:**
- Email verification before any value (breaks flow)
- Credit card required before sandbox
- "Choose your own adventure" with multiple paths (decision fatigue; one golden path wins)
- API keys hidden in settings (Stripe pre-fills them into code examples)
- Static code examples without language switching
- Separate docs site from dashboard (context switching)

## Pass 2: API/CLI/SDK Design

**Gold standards:**
- **Stripe prefixed IDs**: `ch_` for charges, `cus_` for customers. Self-documenting. Impossible to pass wrong ID type.
- **Stripe expandable objects**: Default returns ID strings. `expand[]` gets full objects inline. Nested expansion up to 4 levels.
- **Stripe idempotency keys**: Pass `Idempotency-Key` header on mutations. Safe retries. No "did I double-charge?" anxiety.
- **Stripe API versioning**: First call pins account to that day's version. Test new versions per-request via `Stripe-Version` header.
- **GitHub CLI**: Auto-detects terminal vs pipe. Human-readable in terminal, tab-delimited when piped. `gh pr <tab>` shows all PR actions.
- **SwiftUI progressive disclosure**: `Button("Save") { save() }` to full customization, same API at every level.
- **htmx**: HTML attributes replace JS. 14KB total. `hx-get="/search" hx-trigger="keyup changed delay:300ms"`. Zero build step.
- **shadcn/ui**: Copy source code into your project. You own every line. No dependency, no version conflicts.

**Anti-patterns:**
- Chatty API: requiring 5 calls for one user-visible action
- Inconsistent naming: `/users` (plural) vs `/user/123` (singular) vs `/create-order` (verb in URL)
- Implicit failure: 200 OK with error nested in response body
- God endpoint: 47 parameter combinations with different behavior per subset
- Documentation-required API: 3 pages of docs before first call = too much ceremony

## Pass 3: Error Messages & Debugging

#### The agent-ready error contract (agent-ready-v1)

Agents hit most errors first, read them literally, and cannot ask what was meant. Score every
traced error path against eight named items. Public reference: `https://github.com/garrytan/gstack/blob/main/docs/agent-ready-errors.md`.

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

**Calibration.** The first three examples show single items done well; none of them alone meets every item.

**Elm (what, fix, readable first line):**
```
-- TYPE MISMATCH ---- src/Main.elm
I cannot do addition with String values like this one:
42|   "hello" + 1
     ^^^^^^^
Hint: To put strings together, use the (++) operator instead.
```
First person, complete sentences, exact location, suggested fix.

**Rust (code, fix, `--explain`):**
```
error[E0308]: mismatched types
 --> src/main.rs:4:20
help: consider borrowing here
  |
4 |     let name: &str = &get_name();
  |                       +
```
A stable code with `rustc --explain E0308`, primary and secondary labels, and a help line
that shows the exact edit.

**Stripe API (code, doc anchor, structured channel):**
```json
{"error":{"type":"invalid_request_error","code":"resource_missing","message":"No such customer: 'cus_nonexistent'","param":"customer","doc_url":"https://stripe.com/docs/error-codes/resource-missing"}}
```

**Agent-ready CLI error (every applicable item).** stderr, exit 3:
```
deploy: push to registry.example.com/acme/api:1.4.2 failed: 401 unauthorized (REGISTRY_AUTH)
  cause: docker login token in ~/.docker/config.json expired; nothing was pushed (side effects: none)
  context: deploy 2.8.0, docker 27.1, config ./deploy.toml, env DEPLOY_REGISTRY set
  fix: run `deploy login --registry registry.example.com`, then rerun the same command (safe to retry once)
  docs: https://deploy.example.com/errors#REGISTRY_AUTH
```
and with `--json`, the same fields as an RFC 9457 problem-details object with extension members:
```json
{"type":"https://deploy.example.com/errors#REGISTRY_AUTH","title":"Registry push unauthorized",
 "detail":"push to registry.example.com/acme/api:1.4.2 failed: 401","instance":"req_7f3a",
 "code":"REGISTRY_AUTH","fix":"deploy login --registry registry.example.com",
 "recovery":{"action":"fix_and_retry","side_effects":"none","max_retries":1},
 "context":{"version":"2.8.0","config":"./deploy.toml","env":["DEPLOY_REGISTRY"]}}
```
An unexpected crash adds `trace: ~/.deploy/logs/crash-2026-10-16T18-02.log (rerun with
--verbose to print it)`. A remote API returns `instance` as its correlation id and keeps the
trace in its own logs. `recovery.action` is retry | fix_and_retry | do_first | ask_human;
`side_effects` is none | partial | complete | unknown, with `reconcile` (a status command)
whenever it is unknown. These member names are illustrative; score the meaning, not the spelling.

**A partial example, gstack's own workflow errors:**
```
findings.jsonl:12: severity must be one of Critical, High, Medium, Low, Informational (ARTIFACT_SCHEMA)
```
It covers what (file, line, the constraint), code (with a `docs/troubleshooting.md` anchor
that carries the `fix:`) and channel (exit 1). It lacks a fix on the line itself, a recovery
class and context. It would score CAP6:fix.

**Standards mapping.** CLI Agent Spec (cli-agent-spec.github.io): per-exit-code `retryable`
and `side_effects` → recovery. RFC 9457: `type` → code + doc anchor, `detail` → what,
`instance` → trace for remote services. Stripe: `code` + `doc_url` → code. MCP tools:
`isError: true` results the model can read → channel. clig.dev "Errors": the actionable line
where the reader looks, debug info for unexpected errors → fix, trace.

**Anti-patterns:** TypeScript buries "Did you mean?" mid-chain; put the fix on the first or
last line. `Error: operation failed` with exit 0. A prompt that hangs when no terminal is
attached. A stack trace that prints an API token.

## Pass 4: Documentation & Learning

**Gold standards:**
- **Stripe docs**: Three-column layout (nav / content / live code). API keys injected when logged in. Language switcher persists across ALL pages. Hover-to-highlight. Stripe Shell for in-browser API calls. Built and open-sourced Markdoc. Features don't ship until docs are finalized. Docs contributions affect performance reviews.
- 52% of developers blocked by lack of documentation (Postman 2023)
- Companies with world-class docs see 2.5x increase in adoption
- "Docs as product": ships with the feature or the feature doesn't ship

## Pass 5: Upgrade & Migration Path

**Gold standards:**
- **Next.js**: `npx @next/codemod upgrade major`. One command upgrades Next.js, React, React DOM, runs all relevant codemods.
- **AG Grid**: Every release from v31+ includes a codemod.
- **Stripe API versioning**: One codebase internally. Version pinning per account. Breaking changes never surprise you.
- **Martin Fowler's pipeline pattern**: Compose small, testable transformations rather than one monolithic codemod.
- 21.9% of breaking changes in Maven Central were undocumented (Ochoa et al., 2021)

## Pass 6: Developer Environment & Tooling

**Gold standards:**
- **Bun**: 100x faster than npm install, 4x faster than Node.js runtime. Speed IS DX.
- 87 interruptions per day average; 25 minutes to recover from each. Devs code only 2-4 hours/day.
- Each 1-point DXI improvement = 13 minutes saved per developer per week.
- **GitHub Copilot**: 55.8% faster task completion. PR time from 9.6 days to 2.4 days.

## Pass 7: Community & Ecosystem

- Dev tools require ~14 exposures before purchase (Matt Biilmann, Netlify). Incompatible with quarterly OKR cycles.
- 4-5x performance multiplier for teams with strong developer experience (DevEx framework).

## Pass 8: DX Measurement

**Three academic frameworks:**
1. **SPACE** (Microsoft Research, 2021): Satisfaction, Performance, Activity, Communication, Efficiency. Measure at least 3 dimensions.
2. **DevEx** (ACM Queue, 2023): Feedback Loops, Cognitive Load, Flow State. Combine perceptual + workflow data.
3. **Fagerholm & Munch** (IEEE, 2012): Cognition, Affect, Conation. The psychological "trilogy of mind."

## Claude Code Skill DX Checklist

Use when reviewing plans for Claude Code skills, MCP servers, or AI agent tools.

- [ ] **AskUserQuestion design**: One issue per call. Re-ground context (project, branch, task). Browser handoff for visual feedback.
- [ ] **State storage**: Global (~/.tool/) vs per-project ($SLUG/) vs per-session. Append-only JSONL for audit trails.
- [ ] **Progressive consent**: One-time prompts with marker files. Never re-ask. Reversible.
- [ ] **Auto-upgrade**: Version check with cache + snooze backoff. Migration scripts. Inline offer.
- [ ] **Skill composition**: Benefits-from chains. Review chaining. Inline invocation with section skipping.
- [ ] **Error recovery**: Resume from failure. Partial results preserved. Checkpoint-safe.
- [ ] **Agent-readable errors**: Every error meets the agent-ready error contract (Pass 3): a safe fix, recovery class, code, context, and a result line with a code.
- [ ] **Session continuity**: Timeline events. Compaction recovery. Cross-session learnings.
- [ ] **Bounded autonomy**: Clear operational limits. Mandatory escalation for destructive actions. Audit trails.

Reference implementations: gstack's design-shotgun loop, auto-upgrade flow, progressive consent, hierarchical storage.
