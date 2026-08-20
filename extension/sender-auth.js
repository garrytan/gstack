/**
 * gstack browse — sender authorization for privileged extension messages
 *
 * Single decision point for which chrome.runtime.onMessage senders may read
 * or spend the browse server's auth token and port. Loaded into the
 * background service worker via importScripts() (classic worker — see
 * manifest.json) and require()-able from bun tests
 * (browse/test/extension-sender-auth.test.ts).
 *
 * Policy: privileged types are for this extension's own pages only
 * (sidepanel / popup — sender.url is chrome-extension://<own id>/...).
 * Content scripts run in web-page context (sender.tab is set, sender.url is
 * the page URL) and can be influenced by page content; foreign extensions
 * have a different sender.id. Both are denied, and a denied sender gets
 * { error: 'unauthorized' } with no other fields — never the token, never
 * the port. This mirrors the server side of the v1.63 token model: the
 * browse server releases AUTH_TOKEN only to the pinned extension Origin via
 * POST /extension-token, so the extension must not re-leak it to contexts
 * the server would never have trusted.
 */
(function (root) {
  'use strict';

  // Message types that return or spend the auth token / server port, or leak
  // privileged browser state. Every other type in background.js's allowlist
  // stays reachable from content scripts — the inspector flow (elementPicked,
  // pickerCancelled, inspectResult) and openSidePanel are content-script-
  // originated by design.
  const PRIVILEGED_TYPES = new Set([
    'getPort',         // response carries port + connected state + token
    'setPort',         // repoints the token-bearing client at another port
    'getServerUrl',    // response carries the server URL (port)
    'getToken',        // response carries the token
    'fetchRefs',       // spends the token on an authorized /refs fetch
    'command',         // spends the token on an arbitrary browse command
    'sidebar-command', // spends the token on a server POST
    'getTabState',     // response carries every open tab's URL + title
  ]);

  // Extension-page senders only: popup / sidepanel / options. A content
  // script has sender.tab set and a web-page sender.url; a foreign extension
  // has a different sender.id; a sender with no URL has no provenance at all.
  // All three are denied.
  function isExtensionPageSender(sender, ownExtensionId) {
    if (!sender || !ownExtensionId) return false;
    if (sender.id !== ownExtensionId) return false;
    if (sender.tab) return false;
    if (typeof sender.url !== 'string') return false;
    return sender.url.startsWith('chrome-extension://' + ownExtensionId + '/');
  }

  // Returns null when the message may proceed, or the exact response a
  // denied sender receives: { error: 'unauthorized' } and nothing else.
  function denialFor(msgType, sender, ownExtensionId) {
    if (!PRIVILEGED_TYPES.has(msgType)) return null;
    if (isExtensionPageSender(sender, ownExtensionId)) return null;
    return { error: 'unauthorized' };
  }

  const api = { PRIVILEGED_TYPES, isExtensionPageSender, denialFor };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // bun test (CommonJS require)
  }
  root.gstackSenderAuth = api; // importScripts() in the service worker
})(typeof self !== 'undefined' ? self : globalThis);
