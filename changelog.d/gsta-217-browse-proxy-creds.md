**`browse` starts again when proxy credentials come from `BROWSE_PROXY_USER` and `BROWSE_PROXY_PASS`.** With those two variables set beside `--proxy`, `BROWSE_PROXY_URL` or a standard proxy variable such as `HTTPS_PROXY`, the daemon exited at startup with `proxy creds set in both env (BROWSE_PROXY_USER) and URL — pick one source`, and the CLI reported only `Server failed to start within 15s`. The CLI puts those credentials into the proxy URL it hands the daemon, and the daemon also inherited the two variables, so it saw the same credentials twice and refused them. The daemon now gets the variables blanked whenever the CLI passes it a resolved proxy URL, so it reads the credentials once, from the URL. Setting credentials both in the URL and in the variables is still refused, with the same message, before any daemon starts.

### Fixed
- **`browse/src/cli.ts`**: the daemon environment for a resolved proxy sets `BROWSE_PROXY_USER` and `BROWSE_PROXY_PASS` to empty. This covers a normal start, an auto-restart, a headed `connect` and its supervisor respawn, and the Windows launcher (#3457).

### Tests
- `browse/test/restart-env.test.ts`: for `--proxy`, `BROWSE_PROXY_URL` and `HTTPS_PROXY` with `BROWSE_PROXY_USER`/`PASS`, the restart and headed daemon environments parse the way `server.ts` parses them and yield the credentials once. All three failed before the fix with the "pick one source" error.
- `browse/test/proxy-env-daemon.test.ts`: an end-to-end start with `HTTP_PROXY` and `BROWSE_PROXY_USER`/`PASS` against a local proxy that demands Basic auth loads the page through the proxy. It timed out at the 15 s start limit before the fix.
- `browse/test/cli-supervisor.test.ts`: the expected headed respawn environment includes the two blanked variables.
