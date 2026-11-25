---
important: data-loss
---
**`gbrain repair ghost-pages` no longer soft-deletes a page whose file moved to another page, and `gbrain repair moved-pages` folds a file that was renamed and edited in one commit.**

### Fixed
- `gbrain repair ghost-pages` approved a page whose file a commit deleted for soft-delete even when Git shows the file moved to another live page, so the old page's links, facts and timeline were purged 72 hours later instead of carried over. The preview now lists such a page apart as `moved_to`, names the fold (`gbrain repair moved-pages --source <id> --slug <slug>`, which previews first and applies only with `--apply --expect <hash> --yes`) and never approves it. A page whose path Git renamed, or whose last committed content a file in HEAD still holds, but whose fold is not proven to lose nothing, is kept as `move_unproven`.
- A `database_ahead_of_file` ghost now carries move evidence in the preview: `matched` when a moved page holds every line of it, database edit included, with the fold to run, and `unmatched` otherwise, naming any file that looks like where it went.
- `gbrain repair moved-pages` folded only a move that kept the file byte for byte. It now also folds a file the deleting commit renamed (or the one live file with the same name that Git first added after the old file and no later than its deletion) when the moved page holds every line of the old page's body and timeline in order, its type, its tags and its frontmatter, and a strict move whose old page was edited in the database when the moved page holds that edit. A move whose lines changed stays held as before.
- `gbrain extract --stale` crashed with `TypeError: undefined is not an object` on a page stored in segments (over 1 MiB) whose saved timeline derivation named a segment the page no longer holds. The incremental timeline read now falls back to the full pass, and saved timeline derivations are re-derived once.
- Correction to the v0.60.769.0 note on `file_drift` holds: it said a plain `gbrain sync` never re-checks a hold an earlier release wrote. That release adds no automatic re-check of its own, but a hold written before screen version 3 is still re-checked by every sync, as earlier releases already did.

<!-- behavior-change: ghost_pages_moved_kept_gst3623 -->
