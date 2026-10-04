# Codex sandbox fixtures (B1)

Captured from codex-cli 0.160.0 (musl x86_64 vendor binary). They pin what
`lib/outside-review-result.ts` and `_gstack_codex_sandbox_preflight` classify.

| File | Capture | Exit |
|---|---|---|
| `sandbox-userns-denied.stderr` | `codex sandbox -c 'sandbox_mode="read-only"' true` in Docker `ubuntu:24.04`, default seccomp profile, apt `bubblewrap` installed | 1 |
| `sandbox-bwrap-missing.stderr` | same command without `bubblewrap` installed (Rust panic) | 101 |
| `exec-json-userns-denied.jsonl` | `echo "Run cat a.txt and tell me its content in one word. If the command fails, say exactly what failed." \| codex exec - -s read-only -c 'model="gpt-5.4-mini"' -c skills.include_instructions=false --json` in the same container (stderr empty) | 0 |
| `review-userns-denied.stdout` / `.stderr` | `codex review --base master -c 'model="gpt-5.4-mini"' -c 'review_model="gpt-5.4-mini"' -c 'sandbox_mode="read-only"' </dev/null` in the same container, on a branch with one changed line | 0 |
| `review-healthy.stdout` / `.stderr` | the same review on a host with user namespaces enabled | 0 |
| `exec-json-healthy.jsonl` | `echo 'Run \`cat a.txt\` and tell me its content in one word.' \| codex exec - -s read-only ... --json` on the same host | 0 |
| `review-mentions-sandbox.txt` | constructed: a real review that discusses bwrap, namespaces, landlock and seccomp (must still pass) | - |

Both failing runs exit 0 and the review's own text concludes "there are no
findings to report", which is why execution evidence (stderr transcript,
`--json` command events) decides before any review text is trusted.

Reproduce the container captures:

```bash
docker run --rm -v <codex vendor bin dir>:/cx:ro -v "$CODEX_HOME":/codexhome -e CODEX_HOME=/codexhome ubuntu:24.04 sh -c \
  'apt-get update -qq && apt-get install -y -qq bubblewrap git; PATH=/cx:$PATH codex sandbox -c "sandbox_mode=\"read-only\"" true; echo $?'
```

Omit `bubblewrap` from the install for the exit-101 capture. Host paths in the
healthy captures are normalized to `/repo`, and lines written by the capture
machine's git wrapper are removed.
