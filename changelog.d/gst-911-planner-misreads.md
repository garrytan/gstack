### Fixed

- **/ship no longer reviews a results write-up as if it were gate code.** Three planner misreads on gstack-evals#132 (GST-911) pushed a docs PR to the five-reader full panel. A chart SVG made of drawing elements now counts as data, like the same chart as a PNG; an SVG with a script, `foreignObject`, event handler or `javascript:` URL stays code and now gets the security class. A data file named for sessions (`recovered-sessions.jsonl`) no longer sets the auth scope, so it adds no auth reader and no gate class; session code and session config still do.
- **`gstack-diff-scope` and the receipt depth read `origin/<base>` by its full ref name (GST-884).** A local `main` behind `origin/main` no longer adds upstream files to the scope, and a tag named `main` or `origin/main` can no longer stand in for the branch.

### Tests

- `test/review-planner-misreads.test.ts`: a 600-point matplotlib-style chart plans docs, light, runtime 0 (before: code, 636 runtime lines); six ways an SVG can run script keep it code with the security class, and six other non-drawing constructs keep it code; session data files leave `SCOPE_AUTH` false while session code and config set it; a stale local `main` and tags named `main` or `origin/main` leave the scope and the receipt base unchanged.
