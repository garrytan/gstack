## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
$GSTACK_BIN/gstack-learnings-log '{"skill":"ship","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
```

**Types:** `pattern` (reusable approach), `pitfall` (what NOT to do), `preference`
(user stated), `architecture` (structural decision), `tool` (library/framework insight),
`operational` (project environment/CLI/workflow knowledge).

**Sources:** `observed` (you found this in the code), `user-stated` (user told you),
`inferred` (AI deduction), `cross-model` (both Claude and Codex agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.



### Refresh learnings for the headline feature on this branch

The top-of-skill learnings pull was keyed to "release ship" broadly. Before the VERSION/CHANGELOG step, re-pull learnings keyed to THIS branch's headline feature so any prior version-bump or CHANGELOG pitfalls for similar features surface.

Pick ONE keyword that names the headline feature you're shipping. The keyword should be a noun: the primary skill or module name, the central feature noun, or the binary you changed. The keyword MUST be alphanumeric or hyphen only — no quotes, slashes, dots, colons, or whitespace. If your candidate has any of those, simplify to just the alphanumeric stem.

Worked examples (ship-specific): good keywords are `learnings-search`, `pacing`, `worktree-ship`. Bad: `the branch headline`, `v1.31.1.0`, `feat: token-or search`.

```bash
$GSTACK_BIN/gstack-learnings-search --query "<your-keyword>" --limit 5 2>/dev/null || true
```

If any learnings come back, name which one applies to the version bump or CHANGELOG framing in one sentence. If none come back, continue without reference — the absence is itself useful information.
