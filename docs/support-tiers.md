# Support tiers

gstack has two support tiers. Full support gets the whole test suite, paid evals and new work. Minimal support means gstack is not totally broken, and nothing more. Garry Tan set this on 2026-11-01: "we don't want it to be totally broken, but we just don't need to invest that much into it."

## Full support

- **Operating systems:** macOS and Linux.
- **Models:** Claude and OpenAI models, both as the host agent and as a reviewer.
- **Testing:** the full free suite and the paid evals.

## Minimal support

- **Windows** (Git Bash or MSYS): with a default Git for Windows install, `./setup` installs, and the core skills start without errors. The core skills are `/ship`, `/review`, `/qa-only`, `/investigate` and `/browse` on gstack's own browser. One required CI job, `windows-smoke`, checks this on every pull request.
- **Gemini models:** the core workflows run to the end without errors when Gemini is the host agent or a reviewer. We check this by hand or with one cheap smoke run, not with an eval cell.

That is the whole promise. Other skills, optional parts such as `/cso`'s native helper, non-default shell settings and speed are not covered.

## What we stop doing

- No Windows-only or Gemini-only features, parity work, tuning or polish.
- No new Windows or Gemini CI jobs or eval cells. Windows CI tuning stops.
- A Windows-only or Gemini-only report that doesn't break install, startup or a core workflow closes as won't fix ([triage rules](triage.md#closing-an-issue)), with a link to this page. A report that does break one of them gets a small fix.

## Windows CI

- `windows-smoke` is a required check on pull requests.
- The six-shard Windows free suite (the `Windows Free Tests` workflow) runs nightly on main, or when someone starts it by hand, and never blocks a pull request. A red nightly run gets a fix only when it shows an install, startup or core-workflow break.

## What doesn't change

These tiers don't change which models gstack's own evals test, or which cross-family review voice gstack uses.
