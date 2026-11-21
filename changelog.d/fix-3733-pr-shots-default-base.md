PR before/after comparisons now use the real branch fork point when local
`origin/HEAD` points at the feature branch, so committed changes no longer appear
identical and block the comparison. Explicit base overrides and local-only
repositories still work. Contributed by @szsunyuan.
