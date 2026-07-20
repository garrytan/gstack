import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../runtime/cli.js";
import { configSet, loadConfig } from "../runtime/config.js";
import {
  ContextClient,
  assertPublicRequestOptions,
  assertPublicUrl,
  assertPublicUrlResolved,
  mapContextFailure,
  readContextKey,
  redactSensitiveText,
  validateContextKey,
} from "../runtime/context.js";

const consented = {
  network: { mode: "context", consent: true, selection: "context" },
  context: { baseUrl: "https://api.context.dev/v1" },
};

describe("Context.dev privacy and failure contract", () => {
  test("fallback choices persist without granting Context.dev consent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-context-choice-"));
    const home = path.join(root, "state");
    let output = "";
    const stream = { write: (value: string) => { output += value; } };
    try {
      expect(await main(["context", "options"], { env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream })).toBe(0);
      expect(output).toContain("A) Set up Context.dev free");
      output = "";
      expect(await main(["context", "select", "host"], { env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream })).toBe(0);
      expect(await loadConfig(home)).toMatchObject({ network: { mode: "host", consent: false, selection: "host" } });
      expect(await main(["context", "select", "local-browser"], { env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream })).toBe(0);
      expect(await loadConfig(home)).toMatchObject({ network: { mode: "local-browser", consent: false, selection: "local-browser" } });
      expect(await main(["context", "select", "none"], { env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream })).toBe(0);
      expect(await loadConfig(home)).toMatchObject({ network: { mode: "off", consent: false, selection: "none" } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("Context setup persists one coherent selected network choice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-context-setup-"));
    const home = path.join(root, "state");
    const stream = { write: (_value: string) => {} };
    try {
      expect(await main(["context", "setup", "--consent", "--offline"], {
        env: { GSTACK_HOME: home, CONTEXT_DEV_API_KEY: "future-format-12345" },
        cwd: root,
        stdout: stream,
        stderr: stream,
      })).toBe(0);
      expect(await loadConfig(home)).toMatchObject({
        network: { mode: "context", consent: true, selection: "context" },
        context: { validation: { status: "unverified", checkedAt: null } },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("Context setup becomes ready only after provider validation succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-context-verified-"));
    const home = path.join(root, "state");
    const stream = { write: (_value: string) => {} };
    let validated = 0;
    try {
      expect(await main(["context", "setup", "--consent"], {
        env: { GSTACK_HOME: home, CONTEXT_DEV_API_KEY: "future-format-12345" },
        cwd: root,
        stdout: stream,
        stderr: stream,
        contextClientFactory: () => ({
          scrapeMarkdown: async () => { validated += 1; return { success: true }; },
        }),
      })).toBe(0);
      expect(validated).toBe(1);
      expect(await loadConfig(home)).toMatchObject({
        network: { mode: "context", consent: true, selection: "context" },
        context: { validation: { status: "verified" } },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("CLI exposes only the allowlisted public Context.dev operations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-context-cli-"));
    const home = path.join(root, "state");
    let output = "";
    const stream = { write: (value: string) => { output += value; } };
    const calls: Array<[string, unknown, unknown]> = [];
    const client = {
      scrapeMarkdown: async (target: string, options: unknown) => { calls.push(["markdown", target, options]); return { markdown: "hello" }; },
      scrapeHtml: async (target: string, options: unknown) => { calls.push(["html", target, options]); return { html: "<p>hello</p>" }; },
      crawl: async (target: string, options: unknown) => { calls.push(["crawl", target, options]); return { pages: [] }; },
      sitemap: async (target: string, options: unknown) => { calls.push(["sitemap", target, options]); return { links: [] }; },
      screenshot: async (target: string, options: unknown) => { calls.push(["screenshot", target, options]); return { image: "omitted" }; },
    };
    const common = {
      env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream,
      contextClientFactory: () => client,
    };
    try {
      expect(await main(["context", "scrape-markdown", "https://example.com", "--main-content"], common)).toBe(0);
      expect(output).toBe("hello\n");
      output = "";
      expect(await main(["context", "crawl", "https://example.com", "--max-pages", "2", "--max-depth", "1", "--json"], common)).toBe(0);
      expect(calls).toContainEqual(["crawl", "https://example.com", { maxPages: 2, maxDepth: 1 }]);
      expect(await main(["context", "sitemap", "example.com", "--max-links", "0"], common)).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("public config rejects nested secret-shaped fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-context-config-"));
    const home = path.join(root, "state");
    const stream = { write: (_value: string) => {} };
    try {
      expect(await main(["context", "select", "none"], {
        env: { GSTACK_HOME: home }, cwd: root, stdout: stream, stderr: stream,
      })).toBe(0);
      for (const key of ["oauth.clientSecret", "auth.session", "service.cookie", "tls.privateKey"]) {
        let error: any;
        try {
          await configSet(home, key, "must-not-be-public");
        } catch (caught) {
          error = caught;
        }
        expect(error?.code).toBe("SECRET_IN_CONFIG");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("public URL gate rejects credentials, loopback, link-local, private IPs, and private-ish names", () => {
    const opaqueCredential = "Q7vN2xLm9Pz4Ks8Wd3Hj6Rc1Ty5Ua0Be";
    const hyphenatedOpaqueCredential = "Q7vN2xLm-9Pz4Ks8W-d3Hj6Rc1-Ty5Ua0Be";
    const blocked = [
      "http://user:password@example.com",
      "http://localhost/path",
      "http://service.internal/path",
      "http://10.1.2.3/path",
      "http://127.0.0.1/path",
      "http://0x7f000001/path",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.4.5/path",
      "http://[::1]/path",
      "http://[fe80::1]/path",
      "http://[fec0::1]/path",
      "http://[64:ff9b:1::1]/path",
      "http://[::ffff:127.0.0.1]/path",
      "file:///etc/passwd",
      "https://example.com/report?access_token=secret",
      "https://example.com/download?X-Amz-Signature=secret",
      "https://example.com/download?X-Goog-Signature=secret",
      "https://example.com/download?client_secret=short",
      "https://example.com/download?refresh-token=short",
      "https://example.com/download?cookie=session-value",
      "https://example.com/download?access_to%256ben=abc",
      "https://example.com/download?client_se%2563ret=abc",
      "https://example.com/download?coo%256bie=abc",
      "https://example.com/oauth/callback#access_token=secret",
      "https://example.com/oauth/callback#id_token=secret",
      `https://example.com/download/${opaqueCredential}`,
      `https://example.com/download?document=${opaqueCredential}`,
      `https://example.com/download/${hyphenatedOpaqueCredential}`,
      "https://example.com/download/sk_aaaaaaaaaaaaaaaa",
    ];
    for (const target of blocked) {
      try {
        assertPublicUrl(target);
        throw new Error(`gate accepted ${target}`);
      } catch (error: any) {
        expect(error.code).toBe("CONTEXT_BLOCKED");
      }
    }
    expect(assertPublicUrl("https://example.com/path").hostname).toBe("example.com");
    expect(assertPublicUrl("https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie").hostname).toBe("developer.mozilla.org");
    expect(assertPublicUrl("https://www.rfc-editor.org/rfc/rfc6750?topic=access-token").hostname).toBe("www.rfc-editor.org");
    expect(assertPublicUrl("https://example.com/posts/sphinx-of-black-quartz-judge-my-vow-2026").hostname).toBe("example.com");
    expect(assertPublicUrl("https://example.com/posts/Introducing-GStack2-for-public-web-research-2026").hostname).toBe("example.com");
    expect(assertPublicUrl("https://example.com/resources/550e8400-e29b-41d4-a716-446655440000").hostname).toBe("example.com");
    expect(assertPublicUrl("https://example.com/resources/00000000-0000-0000-0000-000000000000").hostname).toBe("example.com");
    expect(assertPublicUrl("https://example.com/search?q=this-is-a-long-public-article-slug-2026").hostname).toBe("example.com");
    expect(assertPublicUrl("https://8.8.8.8/").hostname).toBe("8.8.8.8");
  });

  test("nested percent encoding cannot hide credentials in paths, queries, or fragments", () => {
    let nestedCredential = "sk%2Dlive%5Fexample%5F1234567890";
    for (let layer = 0; layer < 5; layer += 1) nestedCredential = encodeURIComponent(nestedCredential);
    for (const target of [
      `https://example.com/download/${nestedCredential}`,
      `https://example.com/download?q=${nestedCredential}`,
      `https://example.com/download#q=${nestedCredential}`,
    ]) {
      let error: any;
      try {
        assertPublicUrl(target);
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("CONTEXT_BLOCKED");
    }

    let nestedLabel = [..."access_token"]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    for (let layer = 0; layer < 5; layer += 1) nestedLabel = encodeURIComponent(nestedLabel);
    for (const target of [
      `https://example.com/download?${nestedLabel}=ordinary-password-value`,
      `https://example.com/download#${nestedLabel}=ordinary-password-value`,
    ]) {
      let error: any;
      try {
        assertPublicUrl(target);
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("CONTEXT_BLOCKED");
    }
  });

  test("unknown and private request fields are rejected by endpoint allowlists", async () => {
    for (const [endpoint, options] of [
      ["scrapeMarkdown", { headers: { Authorization: "Bearer secret" } }],
      ["scrapeMarkdown", { auth: "Bearer secret" }],
      ["scrapeHtml", { jwt: "secret" }],
      ["crawl", { prompt: "private repository contents" }],
      ["sitemap", { "private-repo": "owner/private" }],
      ["screenshot", { directUrl: "https://example.com", viewport: { width: 1280, privateKey: "secret" } }],
      ["scrapeMarkdown", { pdf: { shouldParse: true, arbitrary: { nested: "secret" } } }],
    ]) {
      expect(() => assertPublicRequestOptions(endpoint, options)).toThrow();
      try {
        assertPublicRequestOptions(endpoint, options);
      } catch (error: any) {
        expect(error.code).toBe("CONTEXT_BLOCKED");
      }
    }
  });

  test("secret-shaped values are rejected even under allowlisted nested option names", () => {
    const opaqueCredential = "Q7vN2xLm9Pz4Ks8Wd3Hj6Rc1Ty5Ua0Be";
    for (const options of [
      { includeSelectors: [`[data-document='${opaqueCredential}']`] },
      { pdf: { shouldParse: true }, country: `us-${opaqueCredential}` },
    ]) {
      let error: any;
      try {
        assertPublicRequestOptions("scrapeMarkdown", options);
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("CONTEXT_BLOCKED");
      expect(String(error?.message)).not.toContain(opaqueCredential);
    }
  });

  test("a URL object cannot validate one value and serialize a secret-bearing value later", async () => {
    const opaqueCredential = "Q7vN2xLm9Pz4Ks8Wd3Hj6Rc1Ty5Ua0Be";
    const target = new URL("https://example.com/public");
    Object.defineProperty(target, "toString", {
      value: () => `https://example.com/download/${opaqueCredential}`,
    });
    let fetches = 0;
    const client = new ContextClient({
      config: consented,
      key: "future-format-credential-12345",
      resolveDns: false,
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    let error: any;
    try {
      await client.scrapeMarkdown(target);
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_BLOCKED");
    expect(fetches).toBe(0);
  });

  test("endpoint allowlists preserve documented public extraction controls", () => {
    const allowed = [
      ["scrapeMarkdown", {
        includeLinks: false,
        includeImages: true,
        shortenBase64Images: true,
        useMainContentOnly: true,
        pdf: { shouldParse: true, start: 1, end: 2, ocr: false },
        includeFrames: false,
        includeSelectors: ["main"],
        excludeSelectors: ["nav"],
        maxAgeMs: 0,
        waitForMs: 100,
        settleAnimations: true,
        country: "us",
        timeoutMS: 1_000,
      }],
      ["scrapeHtml", {
        pdf: { shouldParse: true, ocr: false },
        includeFrames: false,
        useMainContentOnly: true,
        includeSelectors: ["article"],
        excludeSelectors: ["footer"],
        maxAgeMs: 0,
        waitForMs: 100,
        settleAnimations: false,
        country: "us",
        timeoutMS: 1_000,
      }],
      ["crawl", {
        maxPages: 2,
        maxDepth: 1,
        urlRegex: "^https://example\\.com/docs",
        includeLinks: true,
        includeImages: false,
        shortenBase64Images: true,
        useMainContentOnly: true,
        followSubdomains: false,
        pdf: { shouldParse: true, start: 1, end: 2, ocr: false },
        includeFrames: false,
        includeSelectors: ["main"],
        excludeSelectors: ["nav"],
        maxAgeMs: 0,
        waitForMs: 100,
        settleAnimations: false,
        stopAfterMs: 10_000,
        country: "us",
        timeoutMS: 20_000,
      }],
      ["sitemap", {
        maxLinks: 3,
        sitemapUrl: "https://example.com/sitemap.xml",
        urlRegex: "^https://example\\.com/docs",
        timeoutMS: 1_000,
      }],
      ["screenshot", {
        directUrl: "https://example.com/pricing",
        fullScreenshot: false,
        waitForMs: 100,
        viewport: { width: 1280, height: 720 },
        handleCookiePopup: true,
        colorScheme: "dark",
        scrollOffset: 0,
        maxAgeMs: 0,
        country: "us",
        timeoutMS: 1_000,
      }],
    ];
    for (const [endpoint, options] of allowed) {
      expect(assertPublicRequestOptions(endpoint, options)).toEqual(options);
    }
  });

  test("DNS rebinding/private resolution is rejected before fetch", async () => {
    let error: any;
    try {
      await assertPublicUrlResolved("https://public.example.com", {
        lookup: async () => [{ address: "10.0.0.9", family: 4 }],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_BLOCKED");
  });

  test("DNS resolution is covered by the public-operation timeout", async () => {
    let fetches = 0;
    const client = new ContextClient({
      config: consented,
      key: "future-format-credential-12345",
      timeoutMs: 20,
      lookup: async () => new Promise(() => {}),
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    const started = Date.now();
    await expect(client.scrapeMarkdown("https://example.com")).rejects.toMatchObject({ code: "CONTEXT_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetches).toBe(0);
  });

  test("network and DNS remain untouched unless selection, mode, and consent all select Context.dev", async () => {
    let lookups = 0;
    let fetches = 0;
    for (const config of [
      { network: { mode: "off", consent: false, selection: "none" } },
      { network: { mode: "context", consent: true, selection: "host" } },
      { network: { mode: "context", consent: true, selection: null } },
      { network: { mode: "context", consent: true } },
    ]) {
      const client = new ContextClient({
        config,
        key: "ctxt_secret_12345678",
        lookup: async () => {
          lookups += 1;
          return [{ address: "93.184.216.34", family: 4 }];
        },
        fetch: async () => {
          fetches += 1;
          return new Response("{}");
        },
      });
      let error: any;
      try {
        await client.scrapeMarkdown("https://example.com");
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("CONTEXT_BLOCKED");
    }
    expect(lookups).toBe(0);
    expect(fetches).toBe(0);
  });

  test("revoking the Context.dev selection after DNS still prevents fetch", async () => {
    const config = {
      network: { mode: "context", consent: true, selection: "context" },
      context: { baseUrl: "https://api.context.dev/v1" },
    };
    let lookups = 0;
    let fetches = 0;
    const client = new ContextClient({
      config,
      key: "ctxt_secret_12345678",
      lookup: async () => {
        lookups += 1;
        config.network.selection = "host";
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    let error: any;
    try {
      await client.scrapeMarkdown("https://example.com");
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_BLOCKED");
    expect(lookups).toBe(1);
    expect(fetches).toBe(0);
  });

  test("blocked endpoint options perform zero DNS lookups and zero fetches", async () => {
    let lookups = 0;
    let fetches = 0;
    const client = new ContextClient({
      config: consented,
      key: "ctxt_secret_12345678",
      lookup: async () => {
        lookups += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    const attempts = [
      () => client.scrapeMarkdown("https://example.com", { auth: "secret" }),
      () => client.scrapeHtml("https://example.com", { jwt: "secret" }),
      () => client.crawl("https://example.com", { prompt: "private" }),
      () => client.sitemap("example.com", { "private-repo": "owner/private" }),
      () => client.screenshot("https://example.com", { viewport: { width: 1280, prompt: "private" } }),
    ];
    for (const attempt of attempts) {
      let error: any;
      try {
        await attempt();
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("CONTEXT_BLOCKED");
    }
    expect(lookups).toBe(0);
    expect(fetches).toBe(0);
  });

  test("validated options are snapshotted before any asynchronous work", async () => {
    let reads = 0;
    let requestUrl: URL | undefined;
    const options = Object.defineProperty({}, "includeLinks", {
      enumerable: true,
      get: () => (++reads === 1 ? false : { prompt: "private" }),
    });
    const client = new ContextClient({
      config: consented,
      key: "ctxt_secret_12345678",
      resolveDns: false,
      fetch: async (url: URL) => {
        requestUrl = new URL(url);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
    });
    await client.scrapeMarkdown("https://example.com", options);
    expect(reads).toBe(1);
    expect(requestUrl?.searchParams.get("includeLinks")).toBe("false");
    expect(requestUrl?.search).not.toContain("prompt");
  });

  test("documented scrape and crawl endpoints use authenticated JSON without dependencies", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = new ContextClient({
      config: consented,
      key: "ctxt_secret_12345678",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url: URL, init: RequestInit) => {
        calls.push({ url: new URL(url), init });
        return new Response(JSON.stringify({ success: true, markdown: "hello" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.scrapeMarkdown("https://example.com/docs", { includeLinks: false });
    await client.scrapeHtml("https://example.com/docs");
    await client.crawl("https://example.com", { maxPages: 2 });
    await client.sitemap("example.com", { maxLinks: 3 });
    await client.screenshot("https://example.com/pricing", { fullScreenshot: false });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v1/web/scrape/markdown",
      "/v1/web/scrape/html",
      "/v1/web/crawl",
      "/v1/web/scrape/sitemap",
      "/v1/screenshot",
    ]);
    expect(calls[0].url.searchParams.get("url")).toBe("https://example.com/docs");
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ maxPages: 2, url: "https://example.com" });
    expect(String((calls[0].init.headers as Record<string, string>).Authorization).startsWith("Bearer ")).toBe(true);
  });

  test("custom Context origins can never receive credentials, even with the legacy override flag", async () => {
    let fetches = 0;
    const client = new ContextClient({
      config: consented,
      key: "future-format-credential-12345",
      baseUrl: "https://credential-collector.example/v1",
      allowCustomBaseUrl: true,
      resolveDns: false,
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    let error: any;
    try {
      await client.scrapeMarkdown("https://example.com");
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_BAD_RESPONSE");
    expect(fetches).toBe(0);
  });

  test("provider echoes and fetch causes redact arbitrary current and future credential formats", async () => {
    const key = "future-format-credential-12345";
    const responseClient = new ContextClient({
      config: consented,
      key,
      resolveDns: false,
      fetch: async () => new Response(JSON.stringify({
        error_code: "UNAUTHORIZED",
        message: `provider rejected ${key}`,
        metadata: { echoedCredential: key },
      }), { status: 401 }),
    });
    let responseError: any;
    try {
      await responseClient.scrapeMarkdown("https://example.com");
    } catch (caught) {
      responseError = caught;
    }
    expect(responseError?.code).toBe("CONTEXT_KEY_INVALID");
    expect(responseError?.message).toContain("[REDACTED]");
    expect(JSON.stringify(responseError)).not.toContain(key);
    expect(JSON.stringify(responseError?.details)).not.toContain(key);

    const causeClient = new ContextClient({
      config: consented,
      key,
      resolveDns: false,
      fetch: async (_url: URL, init: RequestInit) => {
        throw new Error(`transport logged ${(init.headers as Record<string, string>).Authorization}`);
      },
    });
    let causeError: any;
    try {
      await causeClient.scrapeMarkdown("https://example.com");
    } catch (caught) {
      causeError = caught;
    }
    expect(causeError?.cause?.message).toContain("[REDACTED]");
    expect(causeError?.cause?.message).not.toContain(key);
    expect(causeError?.message).not.toContain(key);
  });

  test("redaction catches credential syntax without rewriting ordinary prose or commit hashes", () => {
    const ordinary = "The monkey: banana sketch uses tokenization at commit bb57306d98c97011b0919c6132705a15b1579781.";
    expect(redactSensitiveText(ordinary)).toBe(ordinary);
    expect(redactSensitiveText("Authorization: Bearer unknown_future_Ab3K9mP2qR7sT4vW8xY1z"))
      .toBe("Authorization: [REDACTED]");
    expect(redactSensitiveText("api_key=unknown_future_Ab3K9mP2qR7sT4vW8xY1z")).not.toContain("Ab3K9mP2");
  });

  test("request timeout covers a response body that stalls after headers", async () => {
    const client = new ContextClient({
      config: consented,
      key: "future-format-credential-12345",
      resolveDns: false,
      timeoutMs: 20,
      fetch: async (_url: URL, init: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      } as Response),
    });
    const started = Date.now();
    let error: any;
    try {
      await client.scrapeMarkdown("https://example.com");
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("failure taxonomy is stable and exact", async () => {
    let missing: any;
    try {
      await readContextKey({ env: {} });
    } catch (error) {
      missing = error;
    }
    expect(missing?.code).toBe("CONTEXT_KEY_MISSING");
    expect(() => validateContextKey("not-a-key")).toThrow();
    try {
      validateContextKey("not-a-key");
    } catch (error: any) {
      expect(error.code).toBe("CONTEXT_KEY_INVALID");
    }
    expect(validateContextKey("future-format-12345")).toBe("future-format-12345");
    expect(mapContextFailure(403, { error_code: "FORBIDDEN", message: "Please verify your email" }).code).toBe("CONTEXT_EMAIL_UNVERIFIED");
    expect(mapContextFailure(403, { error_code: "USAGE_EXCEEDED", message: "No credits" }).code).toBe("CONTEXT_CREDITS_EXHAUSTED");
    expect(mapContextFailure(401, { message: "Credits remaining: 0" }).code).toBe("CONTEXT_CREDITS_EXHAUSTED");
    expect(mapContextFailure(429, { error_code: "RATE_LIMITED" }).code).toBe("CONTEXT_RATE_LIMITED");
    expect(mapContextFailure(408, { error_code: "REQUEST_TIMEOUT" }).code).toBe("CONTEXT_TIMEOUT");
    expect(mapContextFailure(400, { error_code: "WEBSITE_ACCESS_ERROR" }).code).toBe("CONTEXT_BLOCKED");
    expect(mapContextFailure(401, { error_code: "UNAUTHORIZED" }).code).toBe("CONTEXT_KEY_INVALID");
    expect(mapContextFailure(500, { error_code: "INTERNAL_ERROR" }).code).toBe("CONTEXT_BAD_RESPONSE");
  });

  test("deprecated search is typed unsupported and performs no network", async () => {
    let fetches = 0;
    const client = new ContextClient({
      config: consented,
      key: "ctxt_secret_12345678",
      fetch: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    let error: any;
    try {
      await client.search();
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("CONTEXT_BAD_RESPONSE");
    expect(error?.unsupported).toBe(true);
    expect(fetches).toBe(0);
  });
});
