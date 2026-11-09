---
important: security
---
- **A daemon launched with `BROWSE_TUNNEL=1` no longer opens a second ngrok tunnel when `/tunnel/start` arrives during its own start.** The earlier fix made overlapping `/tunnel/start` calls share one start, but the daemon's own startup tunnel skipped that lock. A `/tunnel/start` that arrived while the startup tunnel was still opening saw the tunnel off and opened its own ngrok session, and the daemon kept only one of the two. The other stayed public on your ngrok account until the daemon exited, and closing the tunnel didn't reach it. Now every tunnel start, from the route or from startup, goes through one shared lock and gets the same URL, so there is only ever one session.
