---
important: security
---
- **Tunnel-paired browse agents stay on web URLs and cannot read local files or choose where anything is written.** Over the `/pair-agent` tunnel, `goto` and `newtab` now accept only http(s) URLs, `screenshot` and `snapshot` refuse an output path (`screenshot --base64` returns the image instead; fixed-name captures still go to the temp dir), and `eval`, which runs a file from the daemon's disk, leaves the tunnel allowlist (now 25 commands). The tunnel's 403 hint names these limits. Local CLI, skill and extension clients behave exactly as before. (GST-1747)
