<!-- AUTO-GENERATED from transcript-gate.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
After memory sync is wired (Step 7) but before persisting the CLAUDE.md
config (Step 8), offer to bring this Mac's coding-agent transcripts +
curated `~/.gstack/` artifacts into gbrain so the retrieval surface
(per-skill manifests, salience block) has data to surface.

Run the probe to size the operation:
```bash
bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --probe
```

Read the output. If `Total files in window: 0`, skip — there's nothing
to ingest. Set `gstack-config set transcript_ingest_mode incremental`
silently and continue to Step 8.

If `New (never ingested)` is < 200 AND total bytes are < 100MB: silent
bulk via `bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --bulk --quiet`. Set
`transcript_ingest_mode=incremental` and continue.

Otherwise (the "many transcripts on disk" path): AskUserQuestion with
the exact counts AND the value promise. Default scope is **current repo
only, last 90 days**:

> "Found <N_repo> transcripts in THIS repo (<repo-slug>) over the last
> 90 days, plus <N_other> across other repos on this machine (<bytes>
> total if all ingested). Ingest THIS repo's transcripts into gbrain?
>
> What you get after this: every gstack skill auto-loads recent salience
> from your past sessions in this repo, so the agent finds your prior
> work without you describing it. You can query 'what was I doing on
> day X' and get a real answer. Per-session pages are searchable,
> taggable, and deletable. Secret scanning runs before any push.
>
> What stays the same: nothing leaves your machine unless gbrain sync
> is enabled (Step 7). Per-repo trust policies still apply.
>
> Multi-Mac note: if you HAVE enabled brain sync (Step 7), these
> transcript pages will sync across your Macs. Caveat: deleting a
> transcript page later removes it from gbrain but git history retains
> it in prior commits. Use `gstack-transcript-prune` to delete in bulk;
> use `git filter-repo` on the brain remote for hard-delete from
> history."

Options:
- A) Yes — this repo, last 90 days (recommended; ~est min)
- B) Yes — this repo, ALL history
- C) Yes — this repo + other repos on this machine
- D) Skip historical, track new from now (`transcript_ingest_mode=incremental`)
- E) Never ingest transcripts (`transcript_ingest_mode=off`)

After answer:
```bash
~/.claude/skills/gstack/bin/gstack-config set transcript_ingest_mode <choice>
bun run ~/.claude/skills/gstack/bin/gstack-gbrain-sync.ts --full --no-brain-sync
```
(`--no-brain-sync` because Step 7 already wired that path; this just
runs the code import + memory ingest stages. Brain-sync will run on the
next preamble hook.)

If A/D/E, ingest is incremental from this point on; preamble-boundary
hook runs `bun run ~/.claude/skills/gstack/bin/gstack-gbrain-sync.ts --incremental --quiet` on every skill
start (cheap mtime fast-path).

Reference doc for users: `setup-gbrain/memory.md` (linked from CLAUDE.md
Step 8).
