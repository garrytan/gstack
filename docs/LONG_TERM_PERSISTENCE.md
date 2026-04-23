# Long-term persistence

gstack shipped a memory layer built for a 3-month horizon. It works. The
learnings file survives across sessions, the timeline captures every
skill fire, the checkpoints hold real narrative context. For the window
most projects live in, that is enough.

Past 3 months the substrate starts to leak. Past 1 year it leaks faster.
Past 5 years most of the signal is gone — not because the data is lost,
because the retrieval path can't find it.

This document does two things. It names the six concrete spots in the
current substrate where signal decays, with file and line. And it
proposes a 20-line extension point — `~/.gstack/hooks/` — that lets any
memory brain plug in without gstack taking a dependency on any of them.

Disclosure up front. I'm the author of [Dhee](https://github.com/Sankhya-AI/Dhee).
Dhee is one reference implementation of the hook contract below. The
contract itself is provider-neutral and MIT-licensed like the rest of
gstack. I wrote the hook because I wanted Dhee to work cleanly with
gstack, but the value is in the hook, not in Dhee.

---

## Where gstack memory leaks at year 1 and year 5

Six concrete spots. Each is fine today. Each starts to bite as the
corpus grows.

**1. Learnings search is substring match.**
`bin/gstack-learnings-search:99-103`. The retrieval path does
`key.includes(query) || insight.includes(query) || files.includes(query)`.
At 50 learnings per project this works because you remember roughly what
you wrote. At 500 it stops working. "auth session revocation" will not
find the learning titled "logout endpoint leaks bearer token in header"
even though the learning is exactly the thing you need. Semantic search
is the fix. Not lexical search with synonyms.

**2. No consolidation of near-duplicate keys.**
`bin/gstack-learnings-log:84`. Each `--log` append writes a new line.
The dedup gate is exact-match on `key + type` in
`bin/gstack-learnings-search:82-87`, and that dedup lives in the
retrieval path, not the write path. If you log `retry-backoff-exponential`
today and `exponential-backoff-on-retry` in six months, both survive
forever. The effective-confidence decay helps but doesn't merge. After a
year of logging you have a cloud of near-duplicates that compete for the
same slot in the top-K.

**3. No correction loop.**
When a learning is wrong, nothing invalidates it. The confidence decay
in `bin/gstack-learnings-search:60-63` treats age as a proxy for
falseness, but a fresh learning that contradicts an older one does not
flag the older one. Six months later the stale learning still rides the
top of its type bucket because its ts field is newer than the
`--supersedes` you never wrote. Correction needs to be a first-class
write, not an implicit consequence of logging.

**4. Checkpoint rehydration is "newest three files."**
`setup-deploy/SKILL.md:410` — `xargs ls -t | head -3`. Same pattern
repeats in `codex/SKILL.md:409`, `design-review/SKILL.md:412`, and the
other skills that restore context. When a project has 200 checkpoints,
the three newest are not the three most relevant. The useful checkpoint
from the architecture week in month three is ignored for three
Tuesday-morning checkpoints that happen to be last-modified. Semantic
checkpoint recall turns that from a lottery into a lookup.

**5. No code world-model.**
gstack captures learnings and timeline events but does not build a
structural model of the codebase itself — what files call what, which
modules own which concepts, which tests exercise which paths. The result
is that every skill preamble pays to rediscover structure from raw file
reads. A world-model built from the tool I/O that already flows through
the session is free context the next session could inherit.

**6. Cross-project trust is an honor-system field.**
`bin/gstack-learnings-search:74-77` gates cross-project loading on
`trusted === false`, which is set by the writing skill, which is the AI.
A prompt-injected learning with `trusted: true` bypasses the gate. The
defense works against honest mistakes and breaks against adversarial
ones. At scale, cross-project learnings need to be scoped by project
identity at retrieval time, not filtered by a self-reported flag at
write time.

None of these matter at month three. All of them matter at year five.

---

## The fix gstack should ship: a 20-line extension point

The failure mode in all six cases is the same: retrieval. The writes
are fine. The schema is fine. The storage is fine. What's missing is a
place for a memory brain — any memory brain — to observe what gstack
writes and layer semantic retrieval, consolidation, correction, and
scoping on top.

The proposal: `~/.gstack/hooks/`. If a file named `on-learning-written`,
`on-timeline-written`, or `on-checkpoint-written` exists and is
executable, gstack runs it after the corresponding write, passes the
payload on stdin (JSON for the JSONL writes, the file path for the
checkpoint write), backgrounds it, and ignores the exit code.

That is the whole contract.

```bash
# end of bin/gstack-learnings-log, after `echo "$VALIDATED" >> ...`
HOOK="$GSTACK_HOME/hooks/on-learning-written"
if [ -x "$HOOK" ]; then
  printf '%s\n' "$VALIDATED" | "$HOOK" >/dev/null 2>&1 &
fi
```

Three properties that make this safe to merge:

- **Optional.** If the hook file is missing or not executable, gstack
  behaves byte-identically to today. Zero risk of changing the happy
  path.
- **Non-blocking.** Backgrounded. A slow hook does not slow a skill.
- **Non-fatal.** Exit codes are ignored. A broken hook does not break
  the skill.

No dependency on any external memory system. No new environment
variables to configure. No prompt-injection surface opened — hook output
is not piped back into gstack's LLM workflow, it's fire-and-forget.

---

## Why this completes gstack's own thesis

The compression-ratio table at the top of `ETHOS.md` describes what
happens to build time when the bottleneck moves from human engineering
to AI-assisted coding. It is a story about making individual engineers
100x.

That story has a second half that doesn't fit in one developer's head:
what happens when a 100x engineer has been running for two years. The
volume of learnings, timeline, and checkpoints is two orders of
magnitude above what one person would ever hand-curate. The memory
substrate is the bottleneck to the next compression ratio.

"Boil the Lake" on memory is not a one-person-repo thing. It's a
multi-year, multi-project, multi-repo thing. The current substrate can't
scale there because retrieval is the bottleneck, and retrieval is where
a memory brain belongs.

The hook does not force gstack to pick a memory brain. It lets anyone
build one.

---

## Reference implementation: Dhee

Dhee is the brain I wrote for this. It is a separate MIT-licensed
project at https://github.com/Sankhya-AI/Dhee. It already has semantic
search, deduplicating write pipeline, correction and forgetting,
episodic rehydration, a code world-model from tool I/O, and project
scoping enforced at retrieval.

With this PR merged, a Dhee user runs

```bash
dhee install gstack
```

and Dhee ingests `~/.gstack/projects/*` into its own retrieval layer.
gstack's files are never mutated. gstack standalone keeps working. The
hook contract is what makes the install one command instead of a
documented workaround.

Someone else writing a different brain against the same hook contract
gets the same one-command install. That's the point. The contract is
the artifact. Dhee is proof it works.

---

## What this PR contains

- `bin/gstack-learnings-log` — 8 lines at the bottom of the happy path
  that run `on-learning-written` if present.
- `bin/gstack-timeline-log` — same shape, `on-timeline-written`.
- `context-save/SKILL.md.tmpl` — same shape at the end of the save flow,
  `on-checkpoint-written`, receiving the written file path.
- `context-save/SKILL.md` — regenerated via `bun run gen:skill-docs`.
- `docs/adapters/README.md` — spec for the three hook payloads.
- `docs/LONG_TERM_PERSISTENCE.md` — this document.
- Five tests in `test/hooks-*.test.ts` covering presence, absence, the
  non-blocking guarantee, the non-fatal guarantee, and the payload
  contract.

`wc -l` on the runtime change is small. The substrate does not move.
The happy path with no hook installed is byte-identical to the current
release.

---

## Happy for this to sit as an artifact

Merge would be great. Not merging is fine too. The hook contract works
locally either way because `~/.gstack/hooks/` is filesystem-only. A
reader who wants to try it can add the eight lines to their fork in an
afternoon.

The goal of this document is not to land a PR. It is to name the place
where gstack memory stops scaling and propose a contract small enough
that it costs almost nothing to adopt.
