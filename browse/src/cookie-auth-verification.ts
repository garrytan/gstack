/**
 * Post-import authentication verification.
 *
 * This deliberately verifies the active page, not cookie values. A caller
 * may configure a visible identity selector and expected text through the
 * environment, but neither is ever included in the result or logs.
 */

export interface CookieAuthVerification {
  verified: boolean;
  reason: 'ok' | 'http_unauthorized' | 'redirected_to_auth' | 'identity_not_visible' | 'identity_mismatch' | 'verification_failed';
  status?: number;
}

export interface CookieAuthVerificationOptions {
  identitySelector?: string;
  expectedIdentity?: string;
  timeoutMs?: number;
}

const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|authenticate|auth)(?:\/|$)/i;

/**
 * Reload the active page after cookies are installed and verify that it did
 * not remain unauthorized or redirect to a sign-in surface. When an
 * identitySelector is provided, require that it is visible; expectedIdentity
 * is compared locally and is never returned.
 */
export async function verifyCookieAuthentication(
  page: {
    url(): string;
    reload(options?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null } | null>;
    locator(selector: string): { isVisible(): Promise<boolean>; textContent(): Promise<string | null> };
  },
  options: CookieAuthVerificationOptions = {},
): Promise<CookieAuthVerification> {
  try {
    const response = await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs ?? 15_000,
    });
    const status = response?.status() ?? undefined;
    if (status === 401 || status === 403) {
      return { verified: false, reason: 'http_unauthorized', status };
    }

    const finalUrl = new URL(page.url());
    if (AUTH_PATH.test(finalUrl.pathname)) {
      return { verified: false, reason: 'redirected_to_auth', status };
    }

    if (options.identitySelector) {
      const identity = page.locator(options.identitySelector);
      if (!await identity.isVisible()) {
        return { verified: false, reason: 'identity_not_visible', status };
      }
      if (options.expectedIdentity) {
        const text = await identity.textContent();
        if (!text?.includes(options.expectedIdentity)) {
          return { verified: false, reason: 'identity_mismatch', status };
        }
      }
    }

    return { verified: true, reason: 'ok', status };
  } catch {
    return { verified: false, reason: 'verification_failed' };
  }
}
