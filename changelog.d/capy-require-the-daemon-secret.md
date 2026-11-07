---
important: security
---
- **The design board daemon and the iOS QA daemon now serve only local clients that address them directly.** The design daemon keeps a per-daemon secret in its private (0600) state file and serves every route except `/health` under that secret, so board URLs from `$D compare --serve` now look like `http://127.0.0.1:N/<secret>/boards/<id>/`. The board page, feedback, progress polling and `BOARD_URL`-based reloads keep working unchanged, and `$D daemon stop` reads the secret from the state file. Both daemons refuse requests whose Host is not a loopback address for their port, and requests whose Origin is another site. The iOS QA tailnet listener is unchanged. (GST-1747)
