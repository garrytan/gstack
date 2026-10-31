**A partial `gstack-post pr-body` post keeps the PR's intro.** Since GST-412, any body file with a `## ` section replaced the text above the PR's first heading, so a lane that posted only `## Screenshots` deleted a human intro or a `Review-loop exception:` line under the receipt (GStack Minder: "a partial pr-body post must keep the human intro").

### Fixed
- **Only a full post owns the text above the first heading.** A file with a receipt block above its first `## ` section, as /ship composes it, still replaces stale lead text and stale notes under the receipt. Any other file keeps them; its own lead text still replaces the PR's lead text.

### Tests
- `test/gstack-post.test.ts`: a partial post keeps the intro and the note under the receipt, even with a caption of its own or a receipt further down; the full-post cases now carry a receipt, as /ship's body does.
