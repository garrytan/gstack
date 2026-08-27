# Browser cookie import reliability

`cookie-import-browser` keeps the source browser database read-only and never
prints cookie values. The interactive picker receives the current target
hostname, recommends a profile containing that hostname, and uses a five-minute
one-time handoff code. Database/keychain contention is retried with a bounded
backoff; permanent decryption errors fail immediately.

For a direct, scoped import, use:

```text
cookie-import-browser chrome --domain app.example.test --profile Default
```

Append `--verify-auth` to reload the active page after importing. Verification
fails closed unless both `GSTACK_COOKIE_AUTH_SELECTOR` and
`GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY` are configured. It also rejects HTTP
401/403 responses and redirects to common authentication paths. Configure
those values for tenant/user verification in the process environment. The
expected identity is compared in memory and is never
returned or logged. The interactive picker performs the same page check when a
target hostname is available.
