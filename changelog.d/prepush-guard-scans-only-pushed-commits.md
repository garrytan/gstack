---
important: blocker
---
**The pre-push credential guard no longer scans your whole repository when the remote branch moved since your last fetch.** It now scans only the commits after the last copy of that branch you fetched (or your default branch), so it stops reporting credentials that are already on the remote as part of your push, and stops failing with ENOBUFS on large repositories. A secret in a commit you push still blocks, and a range too large to read still blocks, now with a message that says to run `git fetch` first. Reported by @ajrmooreuk in #4790.
