---
important: security
---
- **Tunnel-paired browse agents stay on web URLs and off the daemon's disk.** Over the `/pair-agent` tunnel, `goto` and `newtab` now accept only http(s) URLs, `screenshot` and `snapshot` refuse an output path (`screenshot --base64` returns the image instead), and `eval`, which runs a file from the daemon's disk, leaves the tunnel allowlist (now 25 commands). The tunnel's 403 hint names these limits. Local CLI, skill and extension clients behave exactly as before. (GST-1747)
