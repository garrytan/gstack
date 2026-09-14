import { describe, test, expect } from "bun:test";
import { buildRestartEnv } from "../src/cli";

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

  test("configHash falls back to persisted state", () => {
    const env = buildRestartEnv({} as any, { ...launchedState, configHash: "fromstate" } as any);
    expect(env.BROWSE_CONFIG_HASH).toBe("fromstate");
  });
});
