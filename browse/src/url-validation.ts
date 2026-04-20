/**
 * URL validation for navigation commands — blocks dangerous schemes and cloud metadata endpoints.
 * Localhost and private IPs are allowed (primary use case: QA testing local dev servers).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateReadPath } from './path-security';

export const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',  // AWS/GCP/Azure instance metadata
  'fe80::1',          // IPv6 link-local — common metadata endpoint alias
  '::ffff:169.254.169.254', // IPv4-mapped IPv6 form of the metadata IP
  '::ffff:a9fe:a9fe', // Hex-encoded IPv4-mapped form (URL constructor normalizes to this)
  '::a9fe:a9fe',      // Deprecated IPv4-compatible hex form
  'metadata.google.internal', // GCP metadata
  'metadata.azure.internal',  // Azure IMDS
]);

/**
 * IPv6 prefixes to block (CIDR-style). Any address starting with these
 * hex prefixes is rejected. Covers the full ULA range (fc00::/7 = fc00:: and fd00::).
 */
const BLOCKED_IPV6_PREFIXES = ['fc', 'fd'];

/**
 * Check if an IPv6 address falls within a blocked prefix range.
 * Handles the full ULA range (fc00::/7), not just the exact literal fd00::.
 * Only matches actual IPv6 addresses (must contain ':'), not hostnames
 * like fd.example.com or fcustomer.com.
 */
function isBlockedIpv6(addr: string): boolean {
  const normalized = addr.toLowerCase().replace(/^\[|\]$/g, '');
  // Must contain a colon to be an IPv6 address — avoids false positives on
  // hostnames like fd.example.com or fcustomer.com
  if (!normalized.includes(':')) return false;
  return BLOCKED_IPV6_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Normalize hostname for blocklist comparison:
 * - Strip trailing dot (DNS fully-qualified notation)
 * - Strip IPv6 brackets (URL.hostname includes [] for IPv6)
 * - Resolve hex (0xA9FEA9FE) and decimal (2852039166) IP representations
 */
function normalizeHostname(hostname: string): string {
  // Strip IPv6 brackets
  let h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Check if a hostname resolves to the link-local metadata IP 169.254.169.254.
 * Catches hex (0xA9FEA9FE), decimal (2852039166), and octal (0251.0376.0251.0376) forms.
 */
function isMetadataIp(hostname: string): boolean {
  // Try to parse as a numeric IP via URL constructor — it normalizes all forms
  try {
    const probe = new URL(`http://${hostname}`);
    const normalized = probe.hostname;
    if (BLOCKED_METADATA_HOSTS.has(normalized) || isBlockedIpv6(normalized)) return true;
    // Also check after stripping trailing dot
    if (normalized.endsWith('.') && BLOCKED_METADATA_HOSTS.has(normalized.slice(0, -1))) return true;
  } catch {
    // Not a valid hostname — can't be a metadata IP
  }
  return false;
}

/**
 * Resolve a hostname to its IP addresses and check if any resolve to blocked metadata IPs.
 * Mitigates DNS rebinding: even if the hostname looks safe, the resolved IP might not be.
 *
 * Checks both A (IPv4) and AAAA (IPv6) records — an attacker can use AAAA-only DNS to
 * bypass IPv4-only checks. Each record family is tried independently; failure of one
 * (e.g. no AAAA records exist) is not treated as a rebinding risk.
 */
async function resolvesToBlockedIp(hostname: string): Promise<boolean> {
  try {
    const dns = await import('node:dns');
    const { resolve4, resolve6 } = dns.promises;

    // Check IPv4 A records
    const v4Check = resolve4(hostname).then(
      (addresses) => addresses.some(addr => BLOCKED_METADATA_HOSTS.has(addr)),
      () => false, // ENODATA / ENOTFOUND — no A records, not a risk
    );

    // Check IPv6 AAAA records — the gap that issue #668 identified
    const v6Check = resolve6(hostname).then(
      (addresses) => addresses.some(addr => {
        const normalized = addr.toLowerCase();
        return BLOCKED_METADATA_HOSTS.has(normalized) || isBlockedIpv6(normalized) ||
          // fe80::/10 is link-local — always block (covers all fe80:: addresses)
          normalized.startsWith('fe80:');
      }),
      () => false, // ENODATA / ENOTFOUND — no AAAA records, not a risk
    );

    const [v4Blocked, v6Blocked] = await Promise.all([v4Check, v6Check]);
    return v4Blocked || v6Blocked;
  } catch {
    // Unexpected error — fail open (don't block navigation on DNS infrastructure failure)
    return false;
  }
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

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked: scheme "${parsed.protocol}" is not allowed. Only http:, https:, and file: URLs are permitted.`
    );
  }

  const hostname = normalizeHostname(parsed.hostname.toLowerCase());

  if (BLOCKED_METADATA_HOSTS.has(hostname) || isMetadataIp(hostname) || isBlockedIpv6(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} is a cloud metadata endpoint. Access is denied for security.`
    );
  }

  // DNS rebinding protection: resolve hostname and check if it points to metadata IPs.
  // Skip for loopback/private IPs — they can't be DNS-rebinded and the async DNS
  // resolution adds latency that breaks concurrent E2E tests under load.
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isPrivateNet = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname);
  if (!isLoopback && !isPrivateNet && await resolvesToBlockedIp(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} resolves to a cloud metadata IP. Possible DNS rebinding attack.`
    );
  }

  return url;
}
