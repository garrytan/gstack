import type { Page } from 'playwright';
import {
  CookieImportError, cookieDomainMatches, importCookies, importCookiesViaCdp,
  listDomains, listProfiles, normalizeCookieDomain, withCookieReadRetry,
  type ProfileEntry,
} from './cookie-import-browser';
import { clearCookieTargetStorage, validateCookieAuthOptions, validateCookieStorageSupport, verifyCookieAuthentication, type CookieAuthVerificationOptions } from './cookie-auth-verification';

export interface CookieImportTarget {
  page: Page;
  url: string;
}

export interface CookieImportOptions {
  browser: string;
  domains?: string[];
  profile?: string;
  all?: boolean;
  clearStorage?: boolean;
  verifyAuth?: boolean;
}

const activeImports = new WeakSet<object>();

export function parseCookieImportArgs(args: string[]): CookieImportOptions {
  const options: CookieImportOptions = { browser: 'comet' };
  let browserSet = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (browserSet) throw new CookieImportError('Specify only one source browser.', 'bad_request');
      options.browser = arg;
      browserSet = true;
      continue;
    }
    if (seen.has(arg)) throw new CookieImportError('Duplicate cookie-import option.', 'bad_request');
    seen.add(arg);
    if (arg === '--domain' || arg === '--profile') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CookieImportError('Cookie-import option requires a value.', 'bad_request');
      if (arg === '--domain') options.domains = [normalizeCookieDomain(value)];
      else options.profile = value;
    } else if (arg === '--all') options.all = true;
    else if (arg === '--clear-storage') options.clearStorage = true;
    else if (arg === '--verify-auth') options.verifyAuth = true;
    else throw new CookieImportError('Unknown cookie-import option.', 'bad_request');
  }
  if (options.all && options.domains) throw new CookieImportError('Choose --domain or --all, not both.', 'bad_request');
  if (options.all && options.clearStorage) throw new CookieImportError('Storage reset requires a single target origin; --all is not supported.', 'bad_request');
  return options;
}

export async function getCookieProfiles(browser: string, domains: string[] = [], hostname?: string) {
  const profiles: Array<ProfileEntry & { matches?: boolean; unavailable?: boolean }> = listProfiles(browser);
  if (domains.length || hostname) {
    const selected = domains.map(normalizeCookieDomain);
    let index = 0;
    const check = async () => {
      while (index < profiles.length) {
        const profile = profiles[index++];
        try {
          const result = await withCookieReadRetry(() => listDomains(browser, profile.name));
          profile.matches = result.domains.some(entry => selected.length
            ? selected.includes(normalizeCookieDomain(entry.domain))
            : cookieDomainMatches(hostname!, entry.domain));
        } catch (err) {
          if (err instanceof CookieImportError && err.code === 'sqlite_unavailable') throw err;
          profile.unavailable = true;
        }
      }
    };
    await Promise.all([check(), check()]);
  }
  const matching = profiles.filter(profile => profile.matches === true);
  const recommendedProfile = !profiles.some(profile => profile.unavailable) && matching.length === 1
    ? matching[0].name : profiles.length === 1 && profiles[0].matches !== false && !profiles[0].unavailable ? profiles[0].name : undefined;
  return { profiles, recommendedProfile };
}

export function validateCookieTarget(target: CookieImportTarget): URL {
  try {
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (target.page.isClosed() || target.page.url() !== target.url) throw new Error();
    return url;
  } catch {
    throw new CookieImportError('The captured HTTP(S) target has changed or is unavailable. Reopen the picker on the intended page.', 'target_changed');
  }
}

export async function runCookieImport(
  options: CookieImportOptions,
  target: CookieImportTarget,
  trackDomains: (domains: string[]) => void,
  authOptions: CookieAuthVerificationOptions = {},
) {
  for (const value of [options.all, options.clearStorage, options.verifyAuth]) {
    if (value !== undefined && typeof value !== 'boolean') throw new CookieImportError('Cookie import options must be booleans.', 'bad_request');
  }
  if (typeof options.browser !== 'string' || !options.browser.trim()) throw new CookieImportError('Select a source browser.', 'bad_request');
  if (options.profile !== undefined && (typeof options.profile !== 'string' || !options.profile)) throw new CookieImportError('Invalid source profile.', 'bad_request');
  if (options.all && options.domains || options.all && options.clearStorage) throw new CookieImportError('All-domain import cannot be combined with a scoped domain or storage reset.', 'bad_request');
  if (!options.all && (!Array.isArray(options.domains) || !options.domains.length)) throw new CookieImportError('Select at least one cookie domain.', 'bad_request');
  const selected = options.domains?.map(normalizeCookieDomain) ?? [];
  const needsTarget = options.clearStorage || options.verifyAuth;
  const targetUrl = needsTarget ? validateCookieTarget(target) : undefined;
  if (options.clearStorage) validateCookieStorageSupport(target.page);
  if (options.verifyAuth) validateCookieAuthOptions(authOptions);
  if (targetUrl && selected.length && !selected.some(domain => cookieDomainMatches(targetUrl.hostname, '.' + domain))) {
    throw new CookieImportError('The selected cookies do not match the captured target origin.', 'target_mismatch');
  }
  const context = target.page.context();
  if (target.page.isClosed()) throw new CookieImportError('The captured target is closed.', 'target_closed');
  if (activeImports.has(context)) throw new CookieImportError('Another cookie import is still running. Wait before retrying.', 'import_busy', 'retry');
  activeImports.add(context);
  try {
    let profile = options.profile;
    if (!profile) {
      const suggestion = await getCookieProfiles(options.browser, selected);
      profile = suggestion.recommendedProfile;
      if (!profile) throw new CookieImportError('Choose a source profile explicitly; matching profiles are ambiguous, unavailable, or empty.', 'profile_required');
    }
    const domains = options.all
      ? (await withCookieReadRetry(() => listDomains(options.browser, profile!))).domains.map(entry => entry.domain)
      : selected;
    let result = await withCookieReadRetry(() => importCookies(options.browser, domains, profile));
    if (result.count === 0 && result.failureReasons?.unsupported_encryption && process.platform === 'win32') {
      const failed = result.failed;
      result = await importCookiesViaCdp(options.browser, domains, profile);
      result.failed = Math.max(result.failed, failed - result.count);
      if (result.failed) result.failureReasons = { native_unrecovered: result.failed };
    }
    const receipt = {
      browser: options.browser,
      profile,
      imported: 0,
      failed: result.failed,
      domainCounts: {} as Record<string, number>,
      failureReasons: result.failureReasons ?? {},
      outcome: (result.failed ? 'failed' : 'empty') as 'empty' | 'imported' | 'partial' | 'failed',
      reset: 'not_requested' as 'not_requested' | 'cleared' | 'failed',
      verification: { verified: false, reason: 'not_requested' } as { verified: boolean; reason: string; status?: number },
      message: result.failed ? 'No cookies imported; cookies could not be decrypted.' : 'No matching cookies found.',
    };
    if (!result.count) {
      if (options.verifyAuth) receipt.verification.reason = 'no_cookies_imported';
      return receipt;
    }
    if (targetUrl && !result.cookies.some(cookie => cookieDomainMatches(targetUrl.hostname, cookie.domain))) {
      throw new CookieImportError('No imported cookies apply to the captured target origin.', 'target_mismatch');
    }
    if (target.page.isClosed()) throw new CookieImportError('The captured target is closed.', 'target_closed');
    if (needsTarget) validateCookieTarget(target);
    if (options.clearStorage) {
      try {
        await clearCookieTargetStorage(target.page, targetUrl!.origin);
        receipt.reset = 'cleared';
      } catch {
        receipt.outcome = 'failed';
        receipt.reset = 'failed';
        receipt.message = 'Storage reset did not complete; storage may be partially cleared. No new cookies were applied.';
        receipt.verification.reason = 'reset_failed';
        return receipt;
      }
    }
    const appliedDomains = [...new Set(result.cookies.map(cookie => cookie.domain))];
    try {
      await context.addCookies(result.cookies);
    } catch {
      trackDomains(appliedDomains);
      receipt.outcome = 'failed';
      receipt.message = 'Cookie application failed; the browser may contain a partial import. Authentication was not verified.';
      receipt.verification.reason = 'application_failed';
      return receipt;
    }
    trackDomains(appliedDomains);
    receipt.imported = result.count;
    receipt.domainCounts = result.domainCounts;
    receipt.outcome = result.failed ? 'partial' : 'imported';
    receipt.message = result.failed ? 'Some cookies could not be decrypted.' : 'Cookie copy complete.';
    if (options.verifyAuth) {
      try {
        validateCookieTarget(target);
        receipt.verification = await verifyCookieAuthentication(target.page, authOptions, targetUrl!.origin);
      } catch {
        receipt.verification = { verified: false, reason: 'target_changed' };
      }
    }
    return receipt;
  } finally {
    activeImports.delete(context);
  }
}

export function formatCookieImportResult(result: Awaited<ReturnType<typeof runCookieImport>>): string {
  return `Imported ${result.imported} cookies from ${result.browser} (profile: ${result.profile}); ${result.failed} failed to decrypt. ${result.message} Storage reset: ${result.reset}. Authentication: ${result.verification.reason}.`;
}
