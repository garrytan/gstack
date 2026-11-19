---
important: security
---
- **On Capy, /ship no longer edits or comments on pull requests as you.** On a Capy machine, `gh` is signed in as the machine owner's own GitHub account, so when /ship recorded its review rounds in a PR body (`gstack-ship-receipt stub`, `stop`, `claim` and `carry`) or posted a body, title, comment or new PR through `gstack-post`, the change showed up under the owner's name, even on someone else's PR. Under `GSTACK_CAPY=1` these commands now run every check they ran before, write the exact text they would have sent to a private file, and print a `HOST_PUBLISH:` line naming it, so the agent publishes it through Capy's own PR tool instead. Nothing changes outside Capy.
