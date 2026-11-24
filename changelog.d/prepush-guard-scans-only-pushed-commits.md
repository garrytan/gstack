---
important: blocker
---
**When the branch you push moved on the remote since your last fetch, the pre-push credential guard now tells you to run `git fetch` instead of failing with ENOBUFS or telling you to rotate a credential that is already on the remote.** It scans the commits you are adding as your own, so a secret in them still blocks as before. The rest of what you push is still checked, because your clone's copy of the remote may be out of date; a credential there, or history too large to read, blocks with a message to fetch first, and after the fetch only your new commits are scanned. Reported by @ajrmooreuk in #4790.
