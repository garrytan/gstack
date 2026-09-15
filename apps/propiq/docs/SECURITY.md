# Security

## Threat model

PropIQ holds three things worth protecting: a user's saved properties and
portfolio (financial position), uploaded legal documents (sale deeds, title
records), and the integrity of the scores themselves. The third matters
commercially — a measurement product whose scores can be influenced is worth
nothing.

## Authorization

**Postgres RLS is the boundary.** Every user-owned table has RLS enabled with
policies scoped to `auth.uid()`, for every verb. Application-level checks exist
too, but they are defence in depth — a bug in application code cannot widen
access past the database.

| Table | Policy |
|---|---|
| `buyer_profiles`, `watchlist`, `portfolio_assets`, `alerts`, `analysis_documents` | owner-only, all four verbs |
| `document_findings` | inherits its document's ownership |
| `admin_audit_log` | `using (false)` — service role only |

Verified two ways: `test/security.test.ts` fails CI if a user-owned table is
added without RLS or with a blanket policy; `supabase/verify-rls.sql` runs
against a live database and raises on any cross-user read.

## Clients and keys

| Client | Key | RLS |
|---|---|---|
| Browser (`lib/supabase-browser.ts`) | anon | enforced |
| Server (`server/supabase.ts` → `createServerClient`) | anon + user session | enforced |
| Admin (`createAdminClient`) | service role | **bypassed** |

The service-role key is read only through `getServerEnv()`, in modules marked
`server-only`, and is never called in response to unvalidated user input. It
exists for trusted ingestion jobs.

Identity is always resolved server-side. A client-supplied user id is never
trusted — `resolveUserId()` reads the session, never a parameter.

## Input validation

Zod at every boundary:

- **Env** — `src/lib/env.ts`, split into client and server schemas so a
  server secret cannot be pulled into a client bundle. Fails fast at startup.
- **Search params** — parsed with fallback to defaults, never trusted into a query.
- **Server actions** — every id validated against `/^[a-zA-Z0-9_-]+$/` before
  it reaches a repository.
- **Auth forms** — validated client-side for UX and server-side by Supabase.

## Document storage

- Private bucket `property-documents`. Never public.
- Objects live under a per-user folder prefix; storage policies enforce that
  the first path segment equals `auth.uid()`.
- Access is always via a short-lived signed URL.
- Uploads are validated for MIME type and size before they are accepted.

## Prompt injection

Untrusted text reaching a model — a user's question, an extracted document body,
a listing description — is wrapped by `fenceUntrusted()`, which strips nested
fence tags so content cannot escape its own block. The system prompt states
explicitly that fenced content is data and never instruction.

Model output is checked by `unsupportedNumericClaims()` before it is shown. An
answer asserting a figure absent from its context is marked ungrounded.

## Transport and headers

Set in `next.config.ts` so they apply to static assets too:

`Strict-Transport-Security` (2 years, preload) · `X-Content-Type-Options: nosniff` ·
`X-Frame-Options: DENY` · `Referrer-Policy: strict-origin-when-cross-origin` ·
`Permissions-Policy: camera=(), microphone=(), geolocation=(self)` ·
`poweredByHeader: false`.

## Score integrity

The commercial system and the scoring system do not read each other. This is
tested: `test/security.test.ts` asserts that no commercial field name appears
anywhere in `scoring/engine.ts`, `scoring/signals.ts` or `decision/engine.ts`.
Commercial status is disclosed on every property page, next to the evidence.

## Error handling

Error boundaries never surface a raw message to a user — query internals can
leak through them. The `digest` is shown so a report can be correlated with a
server log, and nothing else.

## Rate limiting

`AI_RATE_LIMIT_PER_MINUTE` is configured and validated. **Enforcement is not
built** — it lands with the Copilot endpoint, which is the first surface that
can be abused for cost. Tracked in `docs/IMPLEMENTATION_STATUS.md`.

## Audit

`admin_audit_log` records actor, action, subject and detail for administrative
operations. It is unreadable through client roles by policy.

## Known gaps

| Gap | Status |
|---|---|
| AI endpoint rate limiting | Configured, not enforced. Lands with the Copilot |
| CSP header | Not set. Needs a nonce strategy for Next's inline scripts |
| MFA | Not offered. Supabase supports it; not wired |
| Document virus scanning | Not built. Required before public upload |
| Live RLS verification in CI | Script exists; needs a CI database to run against |

These are listed rather than quietly omitted. None of them is load-bearing for
the current feature set, and each is blocking for a specific future one.
