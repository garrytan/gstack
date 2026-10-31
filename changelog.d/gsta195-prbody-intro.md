**A partial `gstack-post pr-body` post keeps the PR's intro.** Since GST-412, any body file with a `## ` section replaced the text above the PR's first heading, so a lane that posted only `## Screenshots` deleted a human intro or a `Review-loop exception:` line under the receipt (GStack Minder: "a partial pr-body post must keep the human intro").

### Fixed
- **Only a full post owns the text above the first heading.** A file with a `## ` section and a receipt block or its own lead text, as /ship composes it, still replaces stale lead text and stale notes under the receipt. A file with `## ` sections only keeps them.

### Tests
- `test/gstack-post.test.ts`: a partial post keeps the intro and the note under the receipt; the full-post cases now carry a receipt, as /ship's body does.
