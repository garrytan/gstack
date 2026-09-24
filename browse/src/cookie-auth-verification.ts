import { errors, type Page } from 'playwright';
import { CookieImportError } from './cookie-import-browser';
import { withCdpSession } from './cdp-bridge';

export interface CookieAuthVerificationOptions {
  identitySelector?: string;
  expectedIdentity?: string;
  timeoutMs?: number;
}

type VerificationReason = 'verified' | 'not_configured' | 'invalid_configuration'
  | 'invalid_target' | 'target_closed' | 'target_changed' | 'login_redirect'
  | 'http_error' | 'no_response' | 'identity_missing' | 'identity_ambiguous'
  | 'identity_mismatch' | 'timeout' | 'verification_failed';

type VerificationResult = { verified: boolean; reason: VerificationReason; status?: number };

const MAX_TIMEOUT_MS = 15_000;
const LOGIN_PATH = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|logon)(?:[\/.;]|$)|(?:^|\/)sessions?\/new(?:[\/.;]|$)/i;

function validateOrigin(expectedOrigin: string): void {
  try {
    const target = new URL(expectedOrigin);
    if ((target.protocol === 'http:' || target.protocol === 'https:') && target.origin === expectedOrigin) return;
  } catch {}
  throw new CookieImportError('A captured HTTP(S) target origin is required.', 'invalid_target');
}

export function validateCookieAuthOptions(options: CookieAuthVerificationOptions): void {
  if (!options || typeof options.identitySelector !== 'string' || !options.identitySelector.trim()
    || typeof options.expectedIdentity !== 'string' || !options.expectedIdentity.replace(/\s+/g, ' ').trim()) {
    throw new CookieImportError('Authentication verification requires an identity selector and expected identity.', 'verification_not_configured');
  }
  if (options.timeoutMs !== undefined && (typeof options.timeoutMs !== 'number'
    || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new CookieImportError('Authentication verification requires a positive finite timeout.', 'invalid_verification_config');
  }
}

export async function verifyCookieAuthentication(
  page: Page,
  options: CookieAuthVerificationOptions,
  expectedOrigin: string,
): Promise<VerificationResult> {
  try {
    validateCookieAuthOptions(options);
    validateOrigin(expectedOrigin);
  } catch (error) {
    const reason = error instanceof CookieImportError && error.code === 'verification_not_configured'
      ? 'not_configured' : error instanceof CookieImportError && error.code === 'invalid_target'
        ? 'invalid_target' : 'invalid_configuration';
    return { verified: false, reason };
  }

  const timeoutMs = Math.min(options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const deadline = performance.now() + timeoutMs;
  const expectedIdentity = options.expectedIdentity!.replace(/\s+/g, ' ').trim();
  let finished = false;
  let status: number | undefined;
  let lastFailure: VerificationReason = 'timeout';
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<VerificationResult>(resolve => {
    timer = setTimeout(() => {
      finished = true;
      resolve({ verified: false, reason: lastFailure, ...(status === undefined ? {} : { status }) });
    }, timeoutMs);
  });

  try {
    return await Promise.race([timeout, (async (): Promise<VerificationResult> => {
      if (page.isClosed()) return { verified: false, reason: 'target_closed' };
      if (new URL(page.url()).origin !== expectedOrigin) return { verified: false, reason: 'target_changed' };
      const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - performance.now()) });
      if (finished || performance.now() >= deadline) return { verified: false, reason: 'timeout' };
      if (page.isClosed()) return { verified: false, reason: 'target_closed' };
      const loadedUrl = page.url();
      if (new URL(loadedUrl).origin !== expectedOrigin) return { verified: false, reason: 'target_changed' };
      if (LOGIN_PATH.test(decodeURIComponent(new URL(loadedUrl).pathname))) return { verified: false, reason: 'login_redirect' };
      if (!response) return { verified: false, reason: 'no_response' };
      status = response.status();
      if (status < 200 || status >= 300) return { verified: false, reason: 'http_error', status };
      for (let request = response.request(); request; request = request.redirectedFrom()!) {
        const url = new URL(request.url());
        if (url.origin !== expectedOrigin) return { verified: false, reason: 'target_changed', status };
        if (LOGIN_PATH.test(decodeURIComponent(url.pathname))) return { verified: false, reason: 'login_redirect', status };
      }
      if (new URL(response.url()).origin !== expectedOrigin
        || new URL(response.url()).href !== new URL(loadedUrl.split('#')[0]).href) {
        return { verified: false, reason: 'target_changed', status };
      }

      while (!finished && performance.now() < deadline) {
        if (page.isClosed()) return { verified: false, reason: 'target_closed', status };
        if (page.url() !== loadedUrl) return { verified: false, reason: 'target_changed', status };
        const reason = await page.locator(options.identitySelector!).filter({ visible: true }).evaluateAll((elements, expected) => {
          if (location.origin !== expected.origin || location.href !== expected.url) return 'target_changed';
          if (elements.length === 0) return 'identity_missing';
          if (elements.length !== 1) return 'identity_ambiguous';
          const element = elements[0];
          const text = element instanceof HTMLElement ? element.innerText : element.textContent ?? '';
          return text.replace(/\s+/g, ' ').trim() === expected.identity ? 'verified' : 'identity_mismatch';
        }, { origin: expectedOrigin, url: loadedUrl, identity: expectedIdentity });
        if (finished || performance.now() >= deadline) return { verified: false, reason: lastFailure, status };
        if (page.isClosed()) return { verified: false, reason: 'target_closed', status };
        if (page.url() !== loadedUrl) return { verified: false, reason: 'target_changed', status };
        if (reason === 'target_changed' || reason === 'verified') return { verified: reason === 'verified', reason, status };
        lastFailure = reason;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { verified: false, reason, status };
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
      }
      return { verified: false, reason: lastFailure, ...(status === undefined ? {} : { status }) };
    })()]);
  } catch (error) {
    const reason = error instanceof errors.TimeoutError || finished || performance.now() >= deadline ? 'timeout'
      : page.isClosed() ? 'target_closed' : 'verification_failed';
    return { verified: false, reason, ...(status === undefined ? {} : { status }) };
  } finally {
    finished = true;
    clearTimeout(timer!);
  }
}

export function validateCookieStorageSupport(page: Page): void {
  try {
    if (page.context().browser()?.browserType().name() === 'chromium') return;
  } catch {}
  throw new CookieImportError('Storage reset requires a Chromium target. Import cookies without storage reset on other browsers.', 'storage_reset_unsupported');
}

export async function clearCookieTargetStorage(page: Page, expectedOrigin: string): Promise<void> {
  validateOrigin(expectedOrigin);
  validateCookieStorageSupport(page);
  if (page.isClosed()) throw new CookieImportError('The captured target is closed.', 'target_closed');
  let targetUrl: string;
  try {
    targetUrl = page.url();
    if (new URL(targetUrl).origin !== expectedOrigin) {
      throw new CookieImportError('The captured target has changed.', 'target_changed');
    }
  } catch {
    throw new CookieImportError('The captured target has changed.', 'target_changed');
  }

  const deadline = performance.now() + MAX_TIMEOUT_MS;
  let expired = false;
  let navigated = false;
  const frame = page.mainFrame();
  const navigation = Promise.withResolvers<string>();
  const onNavigation = (changed: typeof frame) => {
    if (changed === frame) { navigated = true; navigation.resolve('target_changed'); }
  };
  const onClose = () => { navigated = true; navigation.resolve('target_changed'); };
  page.on('framenavigated', onNavigation);
  page.on('close', onClose);
  const cancelled = () => expired || performance.now() >= deadline ? 'storage_reset_timeout'
    : navigated || page.isClosed() || page.url() !== targetUrl ? 'target_changed' : undefined;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string>(resolve => {
    timer = setTimeout(() => {
      expired = true;
      resolve('storage_reset_timeout');
    }, Math.max(0, deadline - performance.now()));
  });
  const cancellation = Promise.race([timeout, navigation.promise]);
  let result: string;
  try {
    result = await Promise.race([cancellation, withCdpSession(page, async session => {
      let isolated: { id: number; uniqueId: string } | undefined;
      let frameId: string | undefined;
      const worldName = 'gstack-cookie-storage-reset';
      const onContext = ({ context }: any) => {
        if (context.name === worldName && context.auxData?.frameId === frameId && context.auxData?.isDefault === false) isolated = context;
      };
      session.on('Runtime.executionContextCreated', onContext);
      try {
        return await Promise.race([cancellation, (async () => {
          if (cancelled()) return cancelled()!;
          const tree = await session.send('Page.getFrameTree');
          if (cancelled()) return cancelled()!;
          frameId = tree.frameTree.frame.id;
          await session.send('Runtime.enable');
          if (cancelled()) return cancelled()!;
          const world = await session.send('Page.createIsolatedWorld', { frameId, worldName, grantUniveralAccess: false });
          if (cancelled()) return cancelled()!;
          if (!isolated?.uniqueId || isolated.id !== world.executionContextId) return 'storage_reset_failed';
          const uniqueContextId = isolated.uniqueId;
          const clock = await session.send('Runtime.evaluate', { expression: 'performance.now()', uniqueContextId, returnByValue: true, silent: true });
          const remaining = deadline - performance.now();
          if (cancelled() || remaining <= 0) return cancelled() ?? 'storage_reset_timeout';
          if (clock.exceptionDetails || !Number.isFinite(clock.result?.value)) return 'storage_reset_failed';
          const cleared = await session.send('Runtime.callFunctionOn', {
            uniqueContextId,
            functionDeclaration: String(({ origin, url, deadline }: { origin: string; url: string; deadline: number }) => {
              if (performance.now() >= deadline) return 'storage_reset_timeout';
              if (location.origin !== origin || location.href !== url) return 'target_changed';
              localStorage.clear();
              if (performance.now() >= deadline) return 'storage_reset_timeout';
              sessionStorage.clear();
              return 'cleared';
            }),
            arguments: [{ value: { origin: expectedOrigin, url: targetUrl, deadline: clock.result.value + remaining } }],
            returnByValue: true,
            silent: true,
          });
          if (cancelled()) return cancelled()!;
          if (cleared.exceptionDetails || !['cleared', 'target_changed', 'storage_reset_timeout'].includes(cleared.result?.value)) return 'storage_reset_failed';
          return cleared.result.value;
        })()]);
      } finally {
        session.off('Runtime.executionContextCreated', onContext);
      }
    })]);
  } catch {
    result = cancelled() ?? 'storage_reset_failed';
  } finally {
    expired = true;
    clearTimeout(timer!);
    page.off('framenavigated', onNavigation);
    page.off('close', onClose);
  }
  if (result === 'storage_reset_timeout') throw new CookieImportError('Target storage reset timed out; storage may be partially cleared.', 'storage_reset_timeout');
  if (result === 'target_changed') throw new CookieImportError('The captured target has changed.', 'target_changed');
  if (result !== 'cleared') throw new CookieImportError('Target storage reset failed; storage may be partially cleared.', 'storage_reset_failed');
}
