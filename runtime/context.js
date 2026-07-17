import net from "node:net";
import dns from "node:dns/promises";
import { loadConfig, loadSecrets } from "./config.js";

export const CONTEXT_FAILURES = Object.freeze([
  "CONTEXT_KEY_MISSING",
  "CONTEXT_KEY_INVALID",
  "CONTEXT_EMAIL_UNVERIFIED",
  "CONTEXT_CREDITS_EXHAUSTED",
  "CONTEXT_RATE_LIMITED",
  "CONTEXT_TIMEOUT",
  "CONTEXT_BLOCKED",
  "CONTEXT_BAD_RESPONSE",
]);

const CONTEXT_FAILURE_SET = new Set(CONTEXT_FAILURES);
const OFFICIAL_BASE_URL = "https://api.context.dev/v1";
const PREFIXED_CREDENTIAL = /(?:^|[^A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|(?:ctxt|github_pat|gh[pousr]|sk|pk|rk|xox[aboprs])[-_][A-Za-z0-9._~-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?:$|[^A-Za-z0-9])/i;
// `/` is a public URL/path separator, not part of one opaque candidate. Each
// path segment is still scanned independently, avoiding false positives where
// a long mixed-case documentation path looked like one credential.
const OPAQUE_TOKEN_CANDIDATE = /[A-Za-z0-9._~+=-]{32,}/g;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_CREDENTIAL_DECODE_PASSES = 8;
const MIN_OPAQUE_TOKEN_ENTROPY = 4.25;

const BOOLEAN_OPTION = "boolean";
const INTEGER_OPTION = "integer";
const STRING_OPTION = "string";
const STRING_ARRAY_OPTION = "string-array";
const PDF_OPTIONS = Object.freeze({
  shouldParse: BOOLEAN_OPTION,
  start: INTEGER_OPTION,
  end: INTEGER_OPTION,
  ocr: BOOLEAN_OPTION,
});
const VIEWPORT_OPTIONS = Object.freeze({
  width: INTEGER_OPTION,
  height: INTEGER_OPTION,
});

// Context.dev also documents free-form outbound headers and request tags. They
// are deliberately excluded: either can carry authentication or unrelated
// private text. Only the public extraction controls below may cross the boundary.
const PUBLIC_OPTION_SCHEMAS = Object.freeze({
  scrapeMarkdown: Object.freeze({
    includeLinks: BOOLEAN_OPTION,
    includeImages: BOOLEAN_OPTION,
    shortenBase64Images: BOOLEAN_OPTION,
    useMainContentOnly: BOOLEAN_OPTION,
    pdf: Object.freeze({ object: PDF_OPTIONS }),
    includeFrames: BOOLEAN_OPTION,
    includeSelectors: STRING_ARRAY_OPTION,
    excludeSelectors: STRING_ARRAY_OPTION,
    maxAgeMs: INTEGER_OPTION,
    waitForMs: INTEGER_OPTION,
    settleAnimations: BOOLEAN_OPTION,
    country: STRING_OPTION,
    timeoutMS: INTEGER_OPTION,
  }),
  scrapeHtml: Object.freeze({
    pdf: Object.freeze({ object: PDF_OPTIONS }),
    includeFrames: BOOLEAN_OPTION,
    useMainContentOnly: BOOLEAN_OPTION,
    includeSelectors: STRING_ARRAY_OPTION,
    excludeSelectors: STRING_ARRAY_OPTION,
    maxAgeMs: INTEGER_OPTION,
    waitForMs: INTEGER_OPTION,
    settleAnimations: BOOLEAN_OPTION,
    country: STRING_OPTION,
    timeoutMS: INTEGER_OPTION,
  }),
  crawl: Object.freeze({
    maxPages: INTEGER_OPTION,
    maxDepth: INTEGER_OPTION,
    urlRegex: STRING_OPTION,
    includeLinks: BOOLEAN_OPTION,
    includeImages: BOOLEAN_OPTION,
    shortenBase64Images: BOOLEAN_OPTION,
    useMainContentOnly: BOOLEAN_OPTION,
    followSubdomains: BOOLEAN_OPTION,
    pdf: Object.freeze({ object: PDF_OPTIONS }),
    includeFrames: BOOLEAN_OPTION,
    includeSelectors: STRING_ARRAY_OPTION,
    excludeSelectors: STRING_ARRAY_OPTION,
    maxAgeMs: INTEGER_OPTION,
    waitForMs: INTEGER_OPTION,
    settleAnimations: BOOLEAN_OPTION,
    stopAfterMs: INTEGER_OPTION,
    country: STRING_OPTION,
    timeoutMS: INTEGER_OPTION,
  }),
  sitemap: Object.freeze({
    maxLinks: INTEGER_OPTION,
    sitemapUrl: STRING_OPTION,
    urlRegex: STRING_OPTION,
    timeoutMS: INTEGER_OPTION,
  }),
  screenshot: Object.freeze({
    domain: STRING_OPTION,
    directUrl: STRING_OPTION,
    fullScreenshot: BOOLEAN_OPTION,
    page: Object.freeze({ enum: Object.freeze(["login", "signup", "blog", "careers", "pricing", "terms", "privacy", "contact"]) }),
    waitForMs: INTEGER_OPTION,
    viewport: Object.freeze({ object: VIEWPORT_OPTIONS }),
    handleCookiePopup: BOOLEAN_OPTION,
    colorScheme: Object.freeze({ enum: Object.freeze(["light", "dark"]) }),
    scrollOffset: INTEGER_OPTION,
    maxAgeMs: INTEGER_OPTION,
    country: STRING_OPTION,
    timeoutMS: INTEGER_OPTION,
  }),
});

export class ContextError extends Error {
  constructor(code, message, options = {}) {
    if (!CONTEXT_FAILURE_SET.has(code)) throw new TypeError(`Unknown Context.dev failure code: ${code}`);
    const secrets = options.secrets ?? [];
    const safeCause = sanitizeErrorCause(options.cause, secrets);
    super(redactSensitiveText(message, secrets), safeCause ? { cause: safeCause } : undefined);
    this.name = "ContextError";
    this.code = code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.details = redactSensitiveValue(options.details, secrets);
    this.unsupported = Boolean(options.unsupported);
  }

  static fromCause(code, message, cause, options = {}) {
    return new ContextError(code, message, { ...options, cause });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.status == null ? {} : { status: this.status }),
      ...(this.retryAfter == null ? {} : { retryAfter: this.retryAfter }),
      ...(this.unsupported ? { unsupported: true } : {}),
    };
  }
}

export async function readContextKey(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.CONTEXT_DEV_API_KEY || env.CONTEXT_API_KEY;
  if (fromEnv?.trim()) return { key: fromEnv.trim(), source: "environment" };

  const home = options.home;
  if (!home) throw new ContextError("CONTEXT_KEY_MISSING", "Context.dev API key is not configured");
  const secrets = await loadSecrets(home);
  const key = secrets?.context?.apiKey;
  if (!key) throw new ContextError("CONTEXT_KEY_MISSING", "Context.dev API key is not configured");
  return { key: String(key).trim(), source: "secrets.json" };
}

export function validateContextKey(key) {
  if (typeof key !== "string" || !key) {
    throw new ContextError("CONTEXT_KEY_MISSING", "Context.dev API key is missing");
  }
  // Do not bake in a provider prefix: Context.dev may rotate key formats.
  // Whitespace is never valid in a bearer token; a small length floor catches
  // accidental empty/placeholder values without rejecting a future prefix.
  if (key.length < 12 || /\s/.test(key)) {
    throw new ContextError("CONTEXT_KEY_INVALID", "Context.dev API key has an invalid format");
  }
  return key;
}

/**
 * Lexically validate a URL before any DNS lookup or HTTP request occurs.
 */
export function assertPublicUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch (cause) {
    throw ContextError.fromCause("CONTEXT_BLOCKED", "Target must be an absolute public HTTP(S) URL", cause);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ContextError("CONTEXT_BLOCKED", "Only HTTP and HTTPS target URLs are allowed");
  }
  if (url.username || url.password) {
    throw new ContextError("CONTEXT_BLOCKED", "Target URLs must not contain credentials");
  }
  assertNoCredentialMaterial(decodeUrlComponent(url.pathname), "URL path");
  for (const [key, value] of url.searchParams) {
    if (isSensitiveFieldName(key) || containsCredentialLabel(key)) {
      throw new ContextError("CONTEXT_BLOCKED", `Target URL contains credential-like query parameter: ${key}`);
    }
    assertNoCredentialMaterial(key, "URL query parameter name");
    assertNoCredentialMaterial(value, "URL query value");
  }
  const fragment = decodeUrlFragment(url.hash.slice(1));
  assertNoCredentialMaterial(fragment, "URL fragment");
  for (const part of fragment.split(/[?&;]/)) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (isSensitiveFieldName(key) || containsCredentialLabel(key)) {
      throw new ContextError("CONTEXT_BLOCKED", `Target URL contains credential-like fragment parameter: ${key}`);
    }
    assertNoCredentialMaterial(part.slice(separator + 1), "URL fragment value");
  }
  assertPublicHostname(url.hostname);
  return url;
}

export function assertPublicHostname(input) {
  const hostname = String(input).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.includes("\0")) {
    throw new ContextError("CONTEXT_BLOCKED", "Target hostname is missing or invalid");
  }
  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    if (!isPublicIp(hostname)) throw new ContextError("CONTEXT_BLOCKED", "Target IP address is not public");
    return hostname;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ContextError("CONTEXT_BLOCKED", "Localhost targets are not allowed");
  }
  const forbiddenSuffixes = [
    ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa",
    ".localdomain", ".corp", ".private", ".test", ".invalid", ".example",
  ];
  if (!hostname.includes(".") || forbiddenSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw new ContextError("CONTEXT_BLOCKED", "Private or non-public hostnames are not allowed");
  }
  if (/^(metadata|instance-data)(\.|$)/.test(hostname) || hostname === "metadata.google.internal") {
    throw new ContextError("CONTEXT_BLOCKED", "Cloud metadata hostnames are not allowed");
  }
  return hostname;
}

export function isPublicIp(input) {
  const address = String(input).replace(/^\[|\]$/g, "");
  const version = net.isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

export async function assertPublicUrlResolved(input, options = {}) {
  const url = assertPublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return url;
  const lookup = options.lookup ?? dns.lookup;
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw ContextError.fromCause("CONTEXT_BLOCKED", "Target hostname could not be resolved publicly", cause);
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length || list.some((record) => !isPublicIp(record?.address ?? record))) {
    throw new ContextError("CONTEXT_BLOCKED", "Target hostname resolves to a non-public address");
  }
  return url;
}

export function mapContextFailure(status, payload = {}, cause, headers, options = {}) {
  const secrets = options.secrets ?? [];
  const safeCause = sanitizeErrorCause(cause, secrets);
  if (cause?.name === "AbortError" || cause?.code === "ABORT_ERR" || cause?.code === "ETIMEDOUT") {
    return new ContextError("CONTEXT_TIMEOUT", "Context.dev request timed out", { status, cause: safeCause, secrets });
  }
  const apiCode = String(payload?.error_code ?? payload?.code ?? "").toUpperCase();
  const rawMessage = String(payload?.message ?? payload?.error ?? "Context.dev request failed");
  const searchable = `${apiCode} ${rawMessage}`.toLowerCase();
  const message = redactSensitiveText(rawMessage, secrets);
  const details = payload && typeof payload === "object" ? redactSensitiveValue(payload, secrets) : undefined;

  if (status === 429 || apiCode === "RATE_LIMITED") {
    const retryAfter = getHeader(headers, "retry-after");
    return new ContextError("CONTEXT_RATE_LIMITED", message, { status, retryAfter, cause: safeCause, details, secrets });
  }
  if (status === 408 || apiCode === "REQUEST_TIMEOUT" || apiCode === "TIMEOUT_EXCEEDS_MAXIMUM") {
    return new ContextError("CONTEXT_TIMEOUT", message, { status, cause: safeCause, details, secrets });
  }
  if (apiCode === "USAGE_EXCEEDED" || /credits?\s*(exhausted|exceeded|remaining\s*[:=]?\s*0)|usage\s*(limit|exceeded)|quota/.test(searchable)) {
    return new ContextError("CONTEXT_CREDITS_EXHAUSTED", message, { status, cause: safeCause, details, secrets });
  }
  if (/email.*(unverified|not verified|verify)|verify.*email/.test(searchable)) {
    return new ContextError("CONTEXT_EMAIL_UNVERIFIED", message, { status, cause: safeCause, details, secrets });
  }
  if (apiCode === "WEBSITE_ACCESS_ERROR" || apiCode === "EXTERNAL_PROVIDER_ERROR" ||
      /blocked|private address|localhost|link.local|website access|hostile waf/.test(searchable)) {
    return new ContextError("CONTEXT_BLOCKED", message, { status, cause: safeCause, details, secrets });
  }
  if (status === 401 || ["UNAUTHORIZED", "DISABLED", "INSUFFICIENT_PERMISSIONS", "FORBIDDEN"].includes(apiCode) || status === 403) {
    return new ContextError("CONTEXT_KEY_INVALID", message, { status, cause: safeCause, details, secrets });
  }
  return new ContextError("CONTEXT_BAD_RESPONSE", message, { status, cause: safeCause, details, secrets });
}

export class ContextClient {
  constructor(options = {}) {
    this.home = options.home;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.lookup = options.lookup ?? dns.lookup;
    this.resolveDns = options.resolveDns ?? true;
    this.config = options.config;
    this.key = options.key;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.baseUrl = options.baseUrl;
  }

  async scrapeMarkdown(url, options = {}) {
    const publicOptions = assertPublicRequestOptions("scrapeMarkdown", options);
    const target = String(url);
    await this.#gateTarget(target);
    return this.#request("GET", "/web/scrape/markdown", { query: { ...publicOptions, url: target } });
  }

  async scrapeHtml(url, options = {}) {
    const publicOptions = assertPublicRequestOptions("scrapeHtml", options);
    const target = String(url);
    await this.#gateTarget(target);
    return this.#request("GET", "/web/scrape/html", { query: { ...publicOptions, url: target } });
  }

  async crawl(url, options = {}) {
    const publicOptions = assertPublicRequestOptions("crawl", options);
    const target = String(url);
    await this.#gateTarget(target);
    return this.#request("POST", "/web/crawl", { body: { ...publicOptions, url: target } });
  }

  async sitemap(domain, options = {}) {
    const publicOptions = assertPublicRequestOptions("sitemap", options);
    const normalized = normalizeDomain(domain);
    await this.#gateTarget(`https://${normalized}`);
    if (publicOptions.sitemapUrl) await this.#gateTarget(publicOptions.sitemapUrl);
    return this.#request("GET", "/web/scrape/sitemap", { query: { ...publicOptions, domain: normalized } });
  }

  async screenshot(target, options = {}) {
    let query;
    if (target && typeof target === "object" && !(target instanceof URL)) {
      query = { ...target, ...options };
    } else {
      const serialized = String(target);
      query = /^https?:\/\//i.test(serialized)
        ? { directUrl: serialized, ...options }
        : { domain: serialized, ...options };
    }
    query = assertPublicRequestOptions("screenshot", query);
    if (query.directUrl && query.domain) {
      throw new ContextError("CONTEXT_BAD_RESPONSE", "Screenshot accepts either domain or directUrl, not both");
    }
    if (query.directUrl) await this.#gateTarget(query.directUrl);
    else {
      query.domain = normalizeDomain(query.domain);
      await this.#gateTarget(`https://${query.domain}`);
    }
    return this.#request("GET", "/screenshot", { query });
  }

  async search() {
    throw new ContextError(
      "CONTEXT_BAD_RESPONSE",
      "Context.dev Search API is deprecated and is intentionally unsupported",
      { unsupported: true },
    );
  }

  async #gateTarget(input) {
    // The lexical gate is intentionally first and performs no I/O. DNS is only
    // reached after #networkSettings confirms explicit persisted consent.
    const url = assertPublicUrl(input);
    const settings = await this.#networkSettings();
    if (!settings.enabled) {
      throw new ContextError("CONTEXT_BLOCKED", "Network access is off; run `gstack context setup --consent`");
    }
    if (this.resolveDns) {
      try {
        await withTimeout(assertPublicUrlResolved(url, { lookup: this.lookup }), this.timeoutMs);
      } catch (cause) {
        if (cause instanceof ContextError) throw cause;
        throw mapContextFailure(undefined, {}, cause);
      }
    }
    return url;
  }

  async #networkSettings() {
    const config = this.config ?? await loadConfig(this.home);
    return {
      enabled: hasContextNetworkConsent(config),
      config,
    };
  }

  async #apiKey() {
    if (this.key) return validateContextKey(String(this.key));
    return validateContextKey((await readContextKey({ home: this.home, env: this.env })).key);
  }

  async #request(method, endpoint, options = {}) {
    if (typeof this.fetch !== "function") {
      throw new ContextError("CONTEXT_BAD_RESPONSE", "This Node runtime does not provide fetch()");
    }
    const { config, enabled } = await this.#networkSettings();
    if (!enabled) {
      throw new ContextError("CONTEXT_BLOCKED", "Network access is off; explicit Context.dev consent is required");
    }
    const configuredBase = this.baseUrl ?? config?.context?.baseUrl ?? OFFICIAL_BASE_URL;
    const baseUrl = validateBaseUrl(configuredBase);
    const key = await this.#apiKey();
    if (!key) throw new ContextError("CONTEXT_KEY_MISSING", "Context.dev API key is not configured");
    const requestUrl = new URL(`${baseUrl.replace(/\/$/, "")}${endpoint}`);
    addQuery(requestUrl.searchParams, options.query ?? {});
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // This timer is part of the public operation contract, so keep it
    // referenced until the request settles. Bun on Windows may otherwise
    // leave a caller awaiting an unresolving fetch/body without delivering
    // the unref'ed abort timer.
    let response;
    try {
      try {
        response = await raceWithAbort(this.fetch(requestUrl, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${key}`,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
          redirect: "error",
        }), controller.signal);
      } catch (cause) {
        if (cause instanceof ContextError) throw cause;
        throw mapContextFailure(undefined, {}, cause, undefined, { secrets: [key] });
      }

      let text;
      try {
        text = await raceWithAbort(response.text(), controller.signal);
      } catch (cause) {
        throw mapContextFailure(response.status, {}, cause, response.headers, { secrets: [key] });
      }
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (cause) {
        throw ContextError.fromCause("CONTEXT_BAD_RESPONSE", "Context.dev returned malformed JSON", cause, {
          status: response.status,
          secrets: [key],
        });
      }
      if (!response.ok) {
        throw mapContextFailure(response.status, payload, undefined, response.headers, { secrets: [key] });
      }
      if (!payload || typeof payload !== "object") {
        throw new ContextError("CONTEXT_BAD_RESPONSE", "Context.dev returned an empty or invalid response", {
          status: response.status,
          secrets: [key],
        });
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function assertPublicRequestOptions(endpoint, options) {
  const schema = PUBLIC_OPTION_SCHEMAS[endpoint];
  if (!schema) throw new TypeError(`Unknown Context.dev option schema: ${endpoint}`);
  return copyOptionObject(options, schema, endpoint);
}

function copyOptionObject(value, schema, trail) {
  if (!isPlainObject(value)) {
    throw new ContextError("CONTEXT_BLOCKED", `Context.dev ${trail} options must be a plain public-data object`);
  }
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(schema, key)) {
      throw new ContextError("CONTEXT_BLOCKED", `Context.dev request option is not allowlisted: ${trail}.${key}`);
    }
    copy[key] = copyOptionValue(child, schema[key], `${trail}.${key}`);
  }
  return copy;
}

function copyOptionValue(value, schema, trail) {
  if (value == null) return value;
  if (schema === BOOLEAN_OPTION) {
    if (typeof value === "boolean" || value === "true" || value === "false") return value;
  } else if (schema === INTEGER_OPTION) {
    if (Number.isSafeInteger(value)) return value;
  } else if (schema === STRING_OPTION) {
    if (typeof value === "string" && !value.includes("\0")) {
      assertNoCredentialMaterial(value, trail);
      return value;
    }
  } else if (schema === STRING_ARRAY_OPTION) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string" && !item.includes("\0"))) {
      for (const item of value) assertNoCredentialMaterial(item, trail);
      return [...value];
    }
  } else if (schema?.object) {
    return copyOptionObject(value, schema.object, trail);
  } else if (schema?.enum) {
    if (schema.enum.includes(value)) return value;
  }
  throw new ContextError("CONTEXT_BLOCKED", `Context.dev request option has a disallowed shape: ${trail}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasContextNetworkConsent(config) {
  return config?.network?.selection === "context" &&
    config?.network?.mode === "context" &&
    config?.network?.consent === true;
}

export async function contextStatus(home, env = process.env) {
  const config = await loadConfig(home);
  let keySource = null;
  try {
    keySource = (await readContextKey({ home, env })).source;
  } catch (error) {
    if (error?.code !== "CONTEXT_KEY_MISSING") throw error;
  }
  const contextReady = Boolean(keySource) && hasContextNetworkConsent(config);
  return {
    configured: Boolean(keySource),
    keySource,
    networkMode: config.network.mode,
    selection: config.network.selection,
    consent: config.network.consent === true,
    contextReady,
    ready: config.network.selection === "context"
      ? contextReady
      : ["host", "local-browser", "none"].includes(config.network.selection),
    needsChoice: config.network.selection == null,
  };
}

function normalizeDomain(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ContextError("CONTEXT_BLOCKED", "A public domain is required");
  const url = assertPublicUrl(raw.includes("://") ? raw : `https://${raw}`);
  if (url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new ContextError("CONTEXT_BLOCKED", "Expected a bare public domain");
  }
  return url.hostname.replace(/^\[|\]$/g, "");
}

function decodeUrlFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function validateBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch (cause) {
    throw ContextError.fromCause("CONTEXT_BAD_RESPONSE", "Invalid Context.dev API base URL", cause);
  }
  if (url.origin !== "https://api.context.dev" || url.username || url.password ||
      !["/v1", "/v1/"].includes(url.pathname) || url.search || url.hash) {
    throw new ContextError("CONTEXT_BAD_RESPONSE", "Refusing to send a Context.dev key to a non-official API host");
  }
  return OFFICIAL_BASE_URL;
}

export function redactSensitiveText(message, knownSecrets = []) {
  let safe = String(message ?? "");
  const exactSecrets = new Set();
  for (const secret of knownSecrets) {
    const raw = String(secret ?? "");
    if (raw.length < 8) continue;
    exactSecrets.add(raw);
    if (hasWellFormedUtf16(raw)) exactSecrets.add(encodeURIComponent(raw));
  }
  for (const secret of exactSecrets) safe = safe.split(secret).join("[REDACTED]");
  safe = safe.replace(/(\bAuthorization\s*[:=]\s*)[^\r\n,}]+/gi, "$1[REDACTED]");
  safe = safe.replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]");
  safe = safe.replace(/((?:[?&#]|\b)(?:access_?token|api_?key|auth(?:orization)?|client_?secret|credential|id_?token|jwt|oauth_?token|password|refresh_?token|secret|session|signature|token)=)[^&#\s,}]+/gi, "$1[REDACTED]");
  safe = safe.replace(/(\b(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|credential|id[_-]?token|jwt|oauth[_-]?token|password|refresh[_-]?token|secret|session|signature|token)\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1[REDACTED]");
  safe = safe.replace(/[A-Za-z0-9._~+/=-]{32,}/g, (candidate) =>
    looksOpaqueCredential(candidate) ? "[REDACTED]" : candidate);
  return safe;
}

function redactSensitiveValue(value, knownSecrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return redactSensitiveText(value, knownSecrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, knownSecrets, seen));
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = isSensitiveFieldName(key)
      ? "[REDACTED]"
      : redactSensitiveValue(child, knownSecrets, seen);
  }
  return copy;
}

function sanitizeErrorCause(cause, knownSecrets = []) {
  if (!cause) return undefined;
  const safe = new Error(redactSensitiveText(cause?.message ?? String(cause), knownSecrets));
  safe.name = String(cause?.name ?? "Error");
  if (cause?.code != null) safe.code = cause.code;
  return safe;
}

function assertNoCredentialMaterial(value, location) {
  let candidate = String(value ?? "");
  for (let pass = 0; pass < MAX_CREDENTIAL_DECODE_PASSES; pass += 1) {
    if (containsCredentialMaterial(candidate)) {
      throw new ContextError("CONTEXT_BLOCKED", `Context.dev ${location} contains secret-shaped data`);
    }
    const decoded = decodeUrlComponent(candidate);
    if (decoded === candidate) return;
    candidate = decoded;
  }
  // A value that remains encoded after the inspection cap could hide a token
  // at arbitrary depth. Fail closed rather than forwarding residual encoding.
  throw new ContextError("CONTEXT_BLOCKED", `Context.dev ${location} uses excessive nested URL encoding`);
}

function containsCredentialMaterial(value) {
  const text = String(value ?? "");
  if (!text) return false;
  if (PREFIXED_CREDENTIAL.test(text)) return true;
  for (const candidate of text.match(OPAQUE_TOKEN_CANDIDATE) ?? []) {
    if (looksOpaqueCredential(candidate)) return true;
  }
  return false;
}

function looksOpaqueCredential(candidate) {
  const token = candidate.replace(/[.,;:!?]+$/, "");
  if (token.length < 32 || /^[a-f0-9]{32,}$/i.test(token) || UUID.test(token) || isReadablePublicSlug(token)) return false;
  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[._~+/=-]/]
    .reduce((count, pattern) => count + Number(pattern.test(token)), 0);
  return categories >= 3 && shannonEntropy(token) >= MIN_OPAQUE_TOKEN_ENTROPY;
}

function isReadablePublicSlug(value) {
  const parts = value.split("-");
  if (parts.length < 3) return false;
  let wordParts = 0;
  for (const part of parts) {
    if (/^[A-Za-z]{1,24}$/.test(part)) {
      wordParts += 1;
      continue;
    }
    if (/^\d{1,8}$/.test(part)) continue;
    if (/^[A-Za-z]{2,20}\d{1,4}$/.test(part)) {
      wordParts += 1;
      continue;
    }
    return false;
  }
  return wordParts >= 2;
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSensitiveFieldName(key) {
  const normalized = String(key).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (["authorization", "clientsecret", "code", "cookie", "credential", "idtoken", "jwt", "key", "password", "refreshtoken", "secret", "session", "setcookie", "signature", "token"].includes(normalized)) {
    return true;
  }
  return /(?:access|api|auth|client|oauth|refresh|private|security|session|xamz|xgoog)(?:credential|key|password|secret|signature|token)$/.test(normalized) ||
    /(?:credential|password|secret|signature|token)$/.test(normalized);
}

function hasWellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsCredentialLabel(value) {
  let candidate = String(value ?? "");
  for (let pass = 0; pass < MAX_CREDENTIAL_DECODE_PASSES; pass += 1) {
    const parts = candidate.split(/[\s/?#&;=:[\](){},]+/).filter(Boolean);
    if (parts.some((part) => isSensitiveFieldName(part))) return true;
    const decoded = decodeUrlComponent(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  // Residual nested encoding after the shared cap is ambiguous and may conceal
  // a credential label. Match the value scanner's fail-closed behavior.
  return true;
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Keep the deadline referenced while the caller is awaiting `promise`.
  // An unref'ed timer is only appropriate for optional background cleanup;
  // this timer is the mechanism that guarantees the operation completes.
  try {
    return await raceWithAbort(promise, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addQuery(searchParams, values, prefix = "") {
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(name, String(item));
    } else if (typeof value === "object") {
      addQuery(searchParams, value, name);
    } else {
      searchParams.append(name, String(value));
    }
  }
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()];
}

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const blocked = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => inIpv4Cidr(value, ipv4Number(base), bits));
}

function ipv4Number(address) {
  return address.split(".").map(Number).reduce((value, part) => value * 256 + part, 0) >>> 0;
}

function inIpv4Cidr(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv6(address) {
  // isPublicIp has already required Node's IPv6 parser to accept the address.
  const value = ipv6BigInt(address);
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  const ranges = [
    ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
    ["2001:10::", 28], ["2001:db8::", 32], ["2002::", 16],
    ["fc00::", 7], ["fec0::", 10], ["fe80::", 10], ["ff00::", 8],
  ];
  return !ranges.some(([base, bits]) => inIpv6Cidr(value, ipv6BigInt(base), bits));
}

function ipv6BigInt(address) {
  let source = address.toLowerCase().split("%")[0];
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = source.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => part < 0 || part > 255)) throw new Error("bad IPv6");
    source = `${source.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) throw new Error("bad IPv6");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) throw new Error("bad IPv6");
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) throw new Error("bad IPv6");
  return groups.reduce((total, group) => (total << 16n) + BigInt(`0x${group}`), 0n);
}

function inIpv6Cidr(value, base, bits) {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}
