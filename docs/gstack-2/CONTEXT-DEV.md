# Context.dev setup and operation

Context.dev is the only newly authorized external service in GStack 2. It is
optional and restricted to public web context. The current automated contract
is green at 22 pass / 0 fail and 139 assertions. A verified-key live smoke also
passed against the official Markdown scrape endpoint on 2026-07-17; see the
[redacted evidence artifact](../../evals/context-dev/live-smoke-2026-07-17.json)
and [TEST-EVIDENCE.md](./TEST-EVIDENCE.md).

## Choose a public-web mode

When a workflow needs public research and no choice is stored, it must offer:

```text
A) Set up Context.dev free (recommended)
B) Use this host's built-in public web search, if available
C) Use GStack's local browser
D) Continue without web research
```

Declining Context.dev is not a workflow failure. Persist only the explicit
choice. Never infer consent from a previous browser navigation, host login,
environment variable, or legacy configuration.

The runtime exposes the same choice without requiring a prompt:

```bash
gstack context options
gstack context select host
gstack context select local-browser
gstack context select none
```

`select` persists exactly one choice in `config.json`. The three fallback
choices keep `network.consent` false and never configure Context.dev export.
`context status` reports the stored selection. If `$GSTACK_HOME/bin` is not on
`PATH`, invoke the default launcher as `~/.gstack/bin/gstack`.

## Free-tier caveat

Provider limits can change. At the 2026-07-16 implementation check, the
[Context.dev pricing page](https://www.context.dev/pricing) described 500
monthly credits for a work-email signup, 250 for a personal/free-email signup,
no credit card, and ordinary page scraping at one credit. Email verification
is required, and provider responses for unverified or exhausted accounts may
not use intuitive HTTP status codes. Verify current terms before promising a
quota or cost; GStack maps the response body as well as status.

GStack never opts into paid usage or surprise spending. When credits are
exhausted it explains the condition and offers a fallback.

## Setup

1. Open [Context.dev agent authentication](https://www.context.dev/auth.md) or
   [signup](https://www.context.dev/signup).
2. Create the account and complete email verification.
3. Install the optional host-neutral runtime if the active mode needs it.
4. Review the options, then run the interactive Context.dev setup:

   ```bash
   gstack context options
   gstack context setup
   ```

5. Read the egress prompt. Type `yes` only if public-page requests to
   Context.dev are acceptable.
6. Enter the API key at the hidden prompt. Do not paste it into chat, a command
   argument, shell history, a project `.env`, or repository file.
7. Check status:

   ```bash
   gstack context status
   gstack doctor
   ```

8. Run one public-page smoke test:

   ```bash
   gstack context smoke --url https://www.context.dev
   ```

For a non-interactive controlled environment, `--consent` is required and the
key must come from protected stdin or `CONTEXT_DEV_API_KEY`; the CLI rejects
key-looking command-line arguments. Interactive hidden input is preferred.

The runtime stores the explicit selection and public choices in
`~/.gstack/config.json` and the key in
`~/.gstack/secrets.json`, mode `0600` where the platform supports POSIX modes.
`$GSTACK_HOME` changes that root. Secrets cannot be written through
`gstack config set`.

## Data-egress contract

Context.dev may receive only the public target URL and operation parameters
needed for the selected scrape/crawl/sitemap/screenshot operation. It must not
receive:

- authenticated pages or private dashboards;
- localhost, intranet, local/private/link-local addresses, or cloud metadata;
- a public hostname whose DNS result is non-public;
- URLs containing usernames or passwords;
- private repository content, diffs, prompts, or user files;
- cookies, session tokens, browser profiles, or unrelated credentials.

The client validates the lexical URL and DNS resolution before a provider
request. `network.mode` must equal `context` and `network.consent` must be true
before it performs even the DNS lookup. The base endpoint is locked to the
credential-free official `https://api.context.dev/v1` origin.

This is not permission to upload public-looking content from an authenticated
session. If provenance is ambiguous, use the local browser and keep the data on
the machine.

## Supported operations and search

The candidate client implements the documented public scrape-Markdown,
scrape-HTML, crawl, sitemap, and screenshot calls. General Context.dev search
is currently deprecated by the provider: the official
[Context.dev changelog](https://docs.context.dev/changelog) says the endpoint
returns `410 Gone`. The current pricing page still lists Web Search credit
costs, so the public provider pages conflict. The runtime follows the explicit
deprecation notice and returns a typed unsupported `CONTEXT_BAD_RESPONSE`
without a network call; it does not guess an endpoint or claim search evidence.

For public search, use the host-native facility only when the user selects it
and it is available. Otherwise use the local browser. If neither is appropriate,
continue without web research and label conclusions unverified.

## Exact failure taxonomy

| Code | Meaning | Recovery |
|---|---|---|
| `CONTEXT_KEY_MISSING` | No key is available. | Offer setup, host-native public search, local browser, or no-web continuation. |
| `CONTEXT_KEY_INVALID` | Key format or provider authentication failed. | Re-enter/reissue the key; never print it. |
| `CONTEXT_EMAIL_UNVERIFIED` | Provider account needs email verification. | Ask the user to verify, then retry the smoke test. |
| `CONTEXT_CREDITS_EXHAUSTED` | Free/paid allowance is depleted. | Explain the quota and offer fallbacks; never purchase automatically. |
| `CONTEXT_RATE_LIMITED` | Provider is throttling requests. | Honor `Retry-After` or fall back; avoid a retry storm. |
| `CONTEXT_TIMEOUT` | Request reached its bounded timeout. | Retry only when safe, or use local/host-native context. |
| `CONTEXT_BLOCKED` | URL/privacy policy rejected the target or provider could not access it safely. | Do not weaken the private-data gate; use local browser when appropriate. |
| `CONTEXT_BAD_RESPONSE` | Provider/server/schema error or an explicitly unsupported operation. | Preserve details without secrets; use a fallback. |

Do not collapse these into “401” or “Context.dev failed.”

## Disable or rotate

Disable network use without deleting the stored key:

```bash
gstack context select none
```

This persists selection `none`, mode `off`, and consent `false`.

Run `gstack context setup` again to replace a rotated key. To remove all runtime
state including secrets, use the separately confirmed destructive operation:

```bash
gstack uninstall --purge --yes
```

Standard skill installation and pure judgment do not require a Context.dev
account. The live smoke used protected input and an isolated temporary home;
it did not persist the key in the repository or permanent GStack state.
