---
important: blocker
---
- **/ship's documentation audit no longer refuses Next.js and SvelteKit route files.** When the Step 14.5 docs audit listed a reviewed or updated file whose path has square brackets, such as `app/api/items/[id]/route.ts`, `[...slug]` or `[[...opt]]`, the result check read the brackets as a glob, refused the result with `DOCS_RESULT_INVALID` on both attempts, and stopped an unattended /ship at Blocked recovery even though the audit found nothing wrong (#4313). A listed path that holds `*`, `?`, `[` or `]` now counts as a file when that exact file exists from the repository root, so file-routed projects ship normally. A pattern such as `docs/*.md` or `docs/[ab].md`, or a bracketed path that names no file, is still refused as a glob.
