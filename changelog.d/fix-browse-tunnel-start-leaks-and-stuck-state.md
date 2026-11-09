---
important: security
---
- **Two quick `/tunnel/start` calls no longer leave a public ngrok tunnel you can't close.** When two callers asked the browse daemon to start its tunnel at the same moment, both saw it off and each opened its own ngrok session. The daemon kept only the second, so the first stayed public on your ngrok account until the daemon exited, and closing the tunnel didn't reach it. Now a start that arrives while another is running waits for it and gets the same URL, so there is only ever one session. Also, when a start failed after ngrok had opened (for example, the state file write failed), the daemon cleaned up the session but still believed a tunnel was live, so it never shut down on idle; it now resets its tunnel state on that failure too.
