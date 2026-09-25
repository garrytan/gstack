<!-- AUTO-GENERATED from transcript-gate.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
After memory sync is wired (Step 7), offer transcript enrollment separately
from curated artifact sync. Transcript ingestion defaults to **off**. Missing
or unknown settings never grant permission. Do not enable it silently, even
for a small corpus. An empty corpus may be reported without changing settings.

Run the read-only candidate probe:
```bash
bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --probe --sources transcript
```

Report the candidate count, bytes and policy-eligible count as distinct values.
The probe neither imports nor changes state. Candidate counts are not a promise
that every page can be imported: remote trust, enrollment scope and scanning
still apply. If there are no candidates, offer enrollment for future sessions
or continue to Step 8 with transcript settings unchanged.

AskUserQuestion before any enrollment or transcript import, regardless of size:

> "Found <N> transcript candidates (<bytes>) on this machine. Would you like
> gbrain to remember coding sessions? Searchable session pages can help later
> skills find your earlier work. Choose the scope below; the default is off
> until you choose. Curated artifact sync remains a separate setting.
>
> Enabled transcripts go to your configured gbrain database, which may be
> remote. With remote-HTTP gbrain they enter the artifact Git publication queue.
> Exact rendered pages are scanned before import and again at publication.
> HIGH findings block; MEDIUM findings wait for review. Scan errors and pages
> over 1 MiB are held, not sent or silently redacted. Remote deny/read-only
> policies still apply.
>
> Turning this off stops the next batch, but cannot recall bytes already handed
> to an importer or erase earlier database pages or Git history. Manual cleanup
> of existing data is separate and needs your approval."

- A) This repository, sessions started in the last 90 days and future sessions.
- B) This repository, all history and future sessions.
- C) All repositories on this machine, last 90 days and future sessions.
- D) This repository, only sessions started from now; do not import history.
- E) Never ingest transcripts; keep or set off.

Use the native question tool's option limit: first offer A, B, C and
"No historical import (choose D/E)"; if the last option is selected, ask D or E.
Choosing that group is not consent. An empty-corpus question may offer D/E
directly. Remember the final letter, not a generic approval of setup.

After an explicit A–E answer, run the matching enrollment command. It stores
the actual repository filter and fixed cutoff in owned ingestion state, sets
the consent switch, and does **not** import anything. A/B/D require a resolvable
current repository remote; if enrollment fails, stop this stage and explain it.
```bash
bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --enroll <A-E>
```

Only after A, B or C succeeds, import the selected transcript scope:
```bash
bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --bulk --sources transcript
```

For D, do not run a historical import. Future incremental passes enforce the
enrollment timestamp even if an older session file is modified later. For E,
do not import transcripts and never reset its mode to incremental. Continue
to Step 8; curated artifacts retain their independent policy in every branch.

Future skill-start hooks may run `bun run ~/.claude/skills/gstack/bin/gstack-gbrain-sync.ts --incremental --quiet`;
each transcript batch still checks current consent and the saved scope.

Report disabled, empty, held, partially written or successful accurately from
the command result. Held/failed pages remain retryable; unsupported or unsafe
checkpoints are retained for review, never silently replaced or renumbered.
Do not bypass the scanner or automatically acknowledge findings. If a privacy
regression requires rollback, keep transcript ingestion off and publication
held until a verified repair and explicit re-enrollment; do not delete history.

Reference: `setup-gbrain/memory.md` (linked from CLAUDE.md Step 8).
