/**
 * URL validation for navigation commands — blocks dangerous schemes and cloud metadata endpoints.
 * Localhost and private IPs are allowed (primary use case: QA testing local dev servers).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateReadPath } from './path-security';

/** Metadata services reached by name rather than address. */
const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal', // GCP metadata
  'metadata.azure.internal',  // Azure IMDS
]);

/**
 * Classify one host literal (URL hostname, cookie domain, or a resolved A/AAAA
 * answer). Returns null when the host is not an IP literal. Single source of
 * truth for navigation (literal, DNS answers, redirects, page-driven
 * navigations) and for session-persist's cookie-domain guard.
 *
 * - 'blocked': IPv4 link-local 169.254.0.0/16 (cloud metadata and container
 *   credential services such as 169.254.170.2), Alibaba's 100.100.100.200,
 *   IPv6 link-local fe80::/10 and ULA fc00::/7, and any of these embedded in
 *   IPv4-mapped (::ffff:), IPv4-compatible (::) or NAT64 (64:ff9b::) IPv6.
 * - 'loopback': 127.0.0.0/8 and ::1.
 * - 'other': every other address (RFC 1918 dev servers stay allowed).
 *
 * The URL parser canonicalizes decimal, octal and hex IPv4 forms
 * (2852039166, 0251.0376.0251.0376, 0xA9FEA9FE) and IPv6 spellings first.
 */
export function classifyAddress(host: string): 'blocked' | 'loopback' | 'other' | null {
  let h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return null;
  if (h.includes(':')) {
    try { h = new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { return null; }
    const groups = expandIpv6(h);
    if (!groups) return null;
    const head = groups.slice(0, 6).map(g => g.toString(16)).join(':');
    if (head === '0:0:0:0:0:ffff' || head === '64:ff9b:0:0:0:0' || (head === '0:0:0:0:0:0' && groups[6] !== 0)) {
      return classifyIpv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255]);
    }
    if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) return 'loopback';
    if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80) return 'blocked';
    return 'other';
  }
  try { h = new URL(`http://${h}/`).hostname; } catch { return null; }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  return m ? classifyIpv4(m.slice(1).map(Number)) : null;
}

function classifyIpv4([a, b, c, d]: number[]): 'blocked' | 'loopback' | 'other' {
  if (a === 169 && b === 254) return 'blocked';
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'blocked';
  return a === 127 ? 'loopback' : 'other';
}

/** Expand a canonical IPv6 literal to eight 16-bit groups. */
function expandIpv6(addr: string): number[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []).map(g => parseInt(g, 16));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill(0), ...tail];
  return groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Resolve a hostname and report whether any A or AAAA answer is blocked.
 * Each family is tried independently; a missing family is not a risk. DNS
 * infrastructure failure fails open. Connection-time rebinding (a different
 * answer when Chromium connects) is out of scope.
 */
async function resolvesToBlockedIp(hostname: string): Promise<boolean> {
  try {
    const { resolve4, resolve6 } = (await import('node:dns')).promises;
    const check = (lookup: Promise<string[]>) => lookup.then(
      (addresses) => addresses.some(addr => classifyAddress(addr) === 'blocked'),
      () => false,
    );
    const [v4, v6] = await Promise.all([check(resolve4(hostname)), check(resolve6(hostname))]);
    return v4 || v6;
  } catch {
    return false;
  }
}

/**
 * Why an http(s) navigation target is refused, or null when it is allowed.
 * Applied to explicit navigations (validateNavigationUrl) and to every
 * navigation request the browser makes, including redirect hops and
 * page-driven navigations (BrowserManager's navigation guard).
 */
export async function blockedNavigationReason(url: string): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const kind = classifyAddress(hostname);
  if (kind === 'blocked' || BLOCKED_METADATA_HOSTNAMES.has(hostname)) {
    return `Blocked: ${parsed.hostname} is a cloud metadata or link-local address. Access is denied for security.`;
  }
  if (kind !== null || hostname === 'localhost') return null;
  if (await resolvesToBlockedIp(hostname)) {
    return `Blocked: ${parsed.hostname} resolves to a cloud metadata or link-local address. Possible DNS rebinding attack.`;
  }
  return null;
}

/**
 * Normalize non-standard file:// URLs into absolute form before the WHATWG URL parser
 * sees them. Handles cwd-relative, home-relative, and bare-segment shapes that the
 * standard parser would otherwise mis-interpret as hostnames.
 *
 *   file:///abs/path.html       → unchanged
 *   file://./<rel>              → file://<cwd>/<rel>
 *   file://~/<rel>              → file://<HOME>/<rel>
 *   file://<single-segment>/... → file://<cwd>/<single-segment>/...  (cwd-relative)
 *   file://localhost/<abs>      → unchanged
 *   file://<host-like>/...      → unchanged (caller rejects via host heuristic)
 *
 * Rejects empty (file://) and root-only (file:///) URLs — these would silently
 * trigger Chromium's directory listing, which is a different product surface.
 */
export function normalizeFileUrl(url: string): string {
  if (!url.toLowerCase().startsWith('file:')) return url;

  // Split off query + fragment BEFORE touching the path — SPAs + fixture URLs rely
  // on these. path.resolve would URL-encode `?` and `#` as `%3F`/`%23` (and
  // pathToFileURL drops them entirely), silently routing preview URLs to the
  // wrong fixture. Extract, normalize the path, reattach at the end.
  //
  // Parse order: `?` before `#` per RFC 3986 — '?' in a fragment is literal.
  // Find the FIRST `?` or `#`, whichever comes first, and take everything
  // after (including the delimiter) as the trailing segment.
  const qIdx = url.indexOf('?');
  const hIdx = url.indexOf('#');
  let delimIdx = -1;
  if (qIdx >= 0 && hIdx >= 0) delimIdx = Math.min(qIdx, hIdx);
  else if (qIdx >= 0) delimIdx = qIdx;
  else if (hIdx >= 0) delimIdx = hIdx;

  const pathPart = delimIdx >= 0 ? url.slice(0, delimIdx) : url;
  const trailing = delimIdx >= 0 ? url.slice(delimIdx) : '';

  const rest = pathPart.slice('file:'.length);

  // file:/// or longer → standard absolute; pass through unchanged (caller validates path).
  if (rest.startsWith('///')) {
    // Reject bare root-only (file:/// with nothing after)
    if (rest === '///' || rest === '////') {
      throw new Error('Invalid file URL: file:/// has no path. Use file:///<absolute-path>.');
    }
    return pathPart + trailing;
  }

  // Everything else: must start with // (we accept file://... only)
  if (!rest.startsWith('//')) {
    throw new Error(`Invalid file URL: ${url}. Use file:///<absolute-path> or file://./<rel> or file://~/<rel>.`);
  }

  const afterDoubleSlash = rest.slice(2);

  // Reject empty (file://) and trailing-slash-only (file://./ listing cwd).
  if (afterDoubleSlash === '') {
    throw new Error('Invalid file URL: file:// is empty. Use file:///<absolute-path>.');
  }
  if (afterDoubleSlash === '.' || afterDoubleSlash === './') {
    throw new Error('Invalid file URL: file://./ would list the current directory. Use file://./<filename> to render a specific file.');
  }
  if (afterDoubleSlash === '~' || afterDoubleSlash === '~/') {
    throw new Error('Invalid file URL: file://~/ would list the home directory. Use file://~/<filename> to render a specific file.');
  }

  // Home-relative: file://~/<rel>
  if (afterDoubleSlash.startsWith('~/')) {
    const rel = afterDoubleSlash.slice(2);
    const absPath = path.join(os.homedir(), rel);
    return pathToFileURL(absPath).href + trailing;
  }

  // cwd-relative with explicit ./ : file://./<rel>
  if (afterDoubleSlash.startsWith('./')) {
    const rel = afterDoubleSlash.slice(2);
    const absPath = path.resolve(process.cwd(), rel);
    return pathToFileURL(absPath).href + trailing;
  }

  // localhost host explicitly allowed: file://localhost/<abs> (pass through to standard parser).
  if (afterDoubleSlash.toLowerCase().startsWith('localhost/')) {
    return pathPart + trailing;
  }

  // Ambiguous: file://<segment>/<rest> — treat as cwd-relative ONLY if <segment> is a
  // simple path name (no dots, no colons, no backslashes, no percent-encoding, no
  // IPv6 brackets, no Windows drive letter pattern).
  const firstSlash = afterDoubleSlash.indexOf('/');
  const segment = firstSlash === -1 ? afterDoubleSlash : afterDoubleSlash.slice(0, firstSlash);

  // Reject host-like segments: dotted names (docs.v1), IPs (127.0.0.1), IPv6 ([::1]),
  // drive letters (C:), percent-encoded, or backslash paths.
  const looksLikeHost = /[.:\\%]/.test(segment) || segment.startsWith('[');
  if (looksLikeHost) {
    throw new Error(
      `Unsupported file URL host: ${segment}. Use file:///<absolute-path> for local files (network/UNC paths are not supported).`
    );
  }

  // Simple-segment cwd-relative: file://docs/page.html → cwd/docs/page.html
  const absPath = path.resolve(process.cwd(), afterDoubleSlash);
  return pathToFileURL(absPath).href + trailing;
}

/**
 * Validate a navigation URL and return a normalized version suitable for page.goto().
 *
 * Callers MUST use the return value — normalization of non-standard file:// forms
 * only takes effect at the navigation site, not at the original URL.
 *
 * Callers (keep this list current, grep before removing):
 *   - write-commands.ts:goto
 *   - meta-commands.ts:diff (both URL args)
 *   - browser-manager.ts:newTab
 *   - browser-manager.ts:restoreState
 */
export async function validateNavigationUrl(url: string): Promise<string> {
  // Normalize non-standard file:// shapes before the URL parser sees them.
  let normalized = url;
  if (url.toLowerCase().startsWith('file:')) {
    normalized = normalizeFileUrl(url);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // file:// path: validate against safe-dirs and allow; otherwise defer to http(s) logic.
  if (parsed.protocol === 'file:') {
    // Reject non-empty non-localhost hosts (UNC / network paths).
    if (parsed.host !== '' && parsed.host.toLowerCase() !== 'localhost') {
      throw new Error(
        `Unsupported file URL host: ${parsed.host}. Use file:///<absolute-path> for local files.`
      );
    }

    // Convert URL → filesystem path with proper decoding (handles %20, %2F, etc.)
    // fileURLToPath strips query + hash; we reattach them after validation so SPA
    // fixture URLs like file:///tmp/app.html?route=home#login survive intact.
    let fsPath: string;
    try {
      fsPath = fileURLToPath(parsed);
    } catch (e: any) {
      throw new Error(`Invalid file URL: ${url} (${e.message})`);
    }

    // Reject path traversal after decoding — e.g. file:///tmp/safe%2F..%2Fetc/passwd
    // Note: fileURLToPath doesn't collapse .., so a literal '..' in the decoded path
    // is suspicious. path.resolve will normalize it; check the result against safe dirs.
    validateReadPath(fsPath);

    // Return the canonical file:// URL derived from the filesystem path + original
    // query + hash. This guarantees page.goto() gets a well-formed URL regardless
    // of input shape while preserving SPA route/query params.
    return pathToFileURL(fsPath).href + parsed.search + parsed.hash;
  }

  // about:blank ONLY — the canonical empty page, and the one the daemon opens its own
  // first tab on. Blocking it meant `browse newtab about:blank` failed, which is what
  // `make-pdf setup` runs as its Chromium smoke test: make-pdf reported "Chromium failed
  // to launch" against a perfectly healthy Chromium, and any browse session whose daemon
  // restarted could never recreate the blank tab it starts from.
  //
  // Deliberately not the whole `about:` scheme. about:blank has no origin, loads nothing
  // and runs nothing; about:config, about:net-internals and friends are real surfaces.
  // Exact href match, not a prefix test, so `about:blankfoo` stays blocked.
  // Compared lower-cased: the URL parser normalises the PROTOCOL but not the opaque part,
  // so `ABOUT:BLANK` parses to href `about:BLANK` and an exact === would reject it.
  if (parsed.protocol === 'about:' && parsed.href.toLowerCase() === 'about:blank') {
    return 'about:blank';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked: scheme "${parsed.protocol}" is not allowed. Only http:, https:, file:, and about:blank URLs are permitted.`
    );
  }

  const blocked = await blockedNavigationReason(parsed.href);
  if (blocked) throw new Error(blocked);

  return url;
}
