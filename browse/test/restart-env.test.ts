import { describe, test, expect } from "bun:test";
import { buildHeadedServerEnv, buildRestartEnv, extractGlobalFlags } from "../src/cli";
import { parseProxyConfig, serverProxyEnv } from "../src/proxy-config";

// #1781: an auto-restart triggered by a plain command (no --headed flag) must
// NOT silently downgrade a headed session to headless. buildRestartEnv reapplies
// headed/proxy/configHash from this invocation OR the persisted server state.
describe("buildRestartEnv (#1781 headed persistence)", () => {
  const headedState = { pid: 1, port: 9, token: "t", startedAt: "", serverPath: "", mode: "headed" as const };
  const launchedState = { pid: 1, port: 9, token: "t", startedAt: "", serverPath: "", mode: "launched" as const };

  test("headed flag on this invocation → BROWSE_HEADED=1", () => {
    expect(buildRestartEnv({ headed: true } as any, null).BROWSE_HEADED).toBe("1");
  });

  test("plain command + persisted headed state → still BROWSE_HEADED=1 (the regression)", () => {
    const env = buildRestartEnv({} as any, headedState as any);
    expect(env.BROWSE_HEADED).toBe("1");
  });

  test("plain command + headless state → no BROWSE_HEADED (no spurious headed)", () => {
    const env = buildRestartEnv({} as any, launchedState as any);
    expect(env.BROWSE_HEADED).toBeUndefined();
  });

  test("nothing set → empty env", () => {
    expect(buildRestartEnv(null, null)).toEqual({});
  });

  test("proxy + configHash reapplied from flags", () => {
    const env = buildRestartEnv({ proxyUrl: "socks5://x", configHash: "abc" } as any, null);
    expect(env.BROWSE_PROXY_URL).toBe("socks5://x");
    expect(env.BROWSE_CONFIG_HASH).toBe("abc");
  });

  test("explicit direct (macOS/Windows, #3440) is re-emitted from this invocation", () => {
    const env = buildRestartEnv({ explicitDirect: true, configHash: "d" } as any, launchedState as any);
    expect(env.BROWSE_PROXY_URL).toBe("direct");
    expect(env.BROWSE_CONFIG_HASH).toBe("d");
  });

  test("the opt-out comes only from this invocation's flags, never from the persisted state, so the env never contradicts the hash", () => {
    expect(buildRestartEnv({ explicitDirect: false, configHash: "plain" } as any, { ...launchedState, proxyDirect: true } as any).BROWSE_PROXY_URL).toBeUndefined();
    expect(buildRestartEnv({ proxyUrl: "socks5://x" } as any, { ...launchedState, proxyDirect: true } as any).BROWSE_PROXY_URL).toBe("socks5://x");
  });

  test("configHash falls back to persisted state", () => {
    const env = buildRestartEnv({} as any, { ...launchedState, configHash: "fromstate" } as any);
    expect(env.BROWSE_CONFIG_HASH).toBe("fromstate");
  });
});

// #3457: the CLI folds BROWSE_PROXY_USER/PASS into the BROWSE_PROXY_URL it hands
// the daemon, and the daemon inherits the CLI's environment. The daemon parses
// that URL with the env creds exactly as server.ts does, so it must see one source.
describe("daemon env carries one proxy credential source (#3457)", () => {
  const userEnv = { BROWSE_PROXY_USER: "a", BROWSE_PROXY_PASS: "b" };
  const daemonParse = (env: Record<string, string>) => {
    const { url, source } = serverProxyEnv(env, "linux");
    return parseProxyConfig({ proxyUrl: url!, envUser: env.BROWSE_PROXY_USER, envPass: env.BROWSE_PROXY_PASS, source });
  };
  const spellings: Array<[string, string[], Record<string, string>]> = [
    ["--proxy", ["--proxy", "http://127.0.0.1:3128", "status"], {}],
    ["BROWSE_PROXY_URL", ["status"], { BROWSE_PROXY_URL: "http://127.0.0.1:3128" }],
    ["HTTPS_PROXY", ["status"], { HTTPS_PROXY: "http://127.0.0.1:3128" }],
  ];

  for (const [name, args, proxyEnv] of spellings) {
    test(`${name} with BROWSE_PROXY_USER/PASS: start, restart and headed daemons parse the creds once`, () => {
      const env = { ...userEnv, ...proxyEnv };
      const flags = extractGlobalFlags(args, env, "linux");
      for (const childEnv of [buildRestartEnv(flags, null), buildHeadedServerEnv(flags)]) {
        const parsed = daemonParse({ ...env, ...childEnv });
        expect(parsed).toMatchObject({ host: "127.0.0.1", port: 3128, userId: "a", password: "b" });
      }
    });
  }

  test("without a resolved proxy the daemon env leaves BROWSE_PROXY_USER/PASS alone", () => {
    const env = buildRestartEnv(extractGlobalFlags(["status"], userEnv, "linux"), null);
    expect(env.BROWSE_PROXY_USER).toBeUndefined();
    expect(env.BROWSE_PROXY_PASS).toBeUndefined();
  });
});
