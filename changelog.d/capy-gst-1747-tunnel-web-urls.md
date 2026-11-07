---
important: security
---
- **Tunnel-paired browse agents stay on web URLs, and nothing they do is written to the daemon's disk.** Over the `/pair-agent` tunnel, `goto` and `newtab` now accept only http(s) URLs, `screenshot` requires `--base64` (it returns the image) and refuses an output path, `snapshot` refuses `-a`, `-H` and `-o`, and `eval`, which runs a file from the daemon's disk, leaves the tunnel allowlist (now 25 commands). The tunnel's 403 hint names these limits. Local CLI, skill and extension clients behave exactly as before. (GST-1747)
