/**
 * The public key in extension/manifest.json fixes this extension's Chrome ID.
 * A display name is attacker-controlled metadata; this ID is the trust anchor
 * used before the daemon provisions its root bearer to extension storage.
 */
export const GSTACK_EXTENSION_ID = 'hjcdllcckghjebjopehjhplcilonljjk';

export function isTrustedGstackExtensionWorkerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'chrome-extension:'
      && url.hostname === GSTACK_EXTENSION_ID
      && url.pathname === '/background.js';
  } catch {
    return false;
  }
}
