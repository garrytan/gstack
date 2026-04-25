/**
 * CDP method allow-list (T2: deny-default).
 *
 * Codex outside-voice T2: allow-default with a deny-list is backwards because
 * Target.*, Browser.*, Runtime.evaluate, Page.addScriptToEvaluateOnNewDocument,
 * Fetch.*, IO.read, etc. are all dangerous and easy to forget. Default-deny
 * inverts the failure mode: missing a method means it's blocked (annoying),
 * not exposed (silent compromise).
 *
 * Each entry has:
 *   - domain.method     unique CDP identifier
 *   - scope             "tab" | "browser" — controls T7 mutex tier
 *   - output            "trusted" | "untrusted" — wraps result if "untrusted"
 *   - justification     why this method is safe to allow
 *
 * Add entries via PR. CI lint (cdp-allowlist.test.ts) ensures every entry has all 4 fields.
 */

export type CdpScope = 'tab' | 'browser';
export type CdpOutput = 'trusted' | 'untrusted';

export interface CdpAllowEntry {
  domain: string;
  method: string;
  scope: CdpScope;
  output: CdpOutput;
  justification: string;
}

export const CDP_ALLOWLIST: ReadonlyArray<CdpAllowEntry> = Object.freeze([
  // ─── Accessibility (read-only) ─────────────────────────────
  {
    domain: 'Accessibility',
    method: 'getFullAXTree',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Read-only AX tree extraction. Output is third-party page content; wrap in UNTRUSTED.',
  },
  {
    domain: 'Accessibility',
    method: 'getPartialAXTree',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Read-only AX tree subtree by node. Output is third-party page content.',
  },
  {
    domain: 'Accessibility',
    method: 'getRootAXNode',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Read-only root AX node accessor.',
  },
  // ─── DOM (read-only inspection) ────────────────────────────
  {
    domain: 'DOM',
    method: 'describeNode',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Inspect a DOM node by backend ID; pure read.',
  },
  {
    domain: 'DOM',
    method: 'getBoxModel',
    scope: 'tab',
    output: 'trusted',
    justification: 'Pure geometric data (box dimensions). No page content leaks; safe trusted.',
  },
  {
    domain: 'DOM',
    method: 'getNodeForLocation',
    scope: 'tab',
    output: 'trusted',
    justification: 'Pure coordinate→nodeId mapping; no content leak.',
  },
  // ─── CSS (read-only) ───────────────────────────────────────
  {
    domain: 'CSS',
    method: 'getMatchedStylesForNode',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Read computed cascade for a node; output may contain attacker-controlled selectors.',
  },
  {
    domain: 'CSS',
    method: 'getComputedStyleForNode',
    scope: 'tab',
    output: 'trusted',
    justification: 'Computed style values are bounded (CSS keywords/numbers); safe trusted.',
  },
  {
    domain: 'CSS',
    method: 'getInlineStylesForNode',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Inline style content may contain attacker-controlled custom-property values.',
  },
  // ─── Performance metrics ───────────────────────────────────
  {
    domain: 'Performance',
    method: 'getMetrics',
    scope: 'tab',
    output: 'trusted',
    justification: 'Pure numeric metrics (timing, layout count); safe.',
  },
  {
    domain: 'Performance',
    method: 'enable',
    scope: 'tab',
    output: 'trusted',
    justification: 'Domain enable; no content; required prerequisite for getMetrics.',
  },
  {
    domain: 'Performance',
    method: 'disable',
    scope: 'tab',
    output: 'trusted',
    justification: 'Domain disable; no content.',
  },
  // ─── Tracing (event capture) ───────────────────────────────
  // NOTE: Tracing.start can capture cross-tab data depending on categories.
  // We mark it browser-scoped to acquire the global lock when in use.
  {
    domain: 'Tracing',
    method: 'start',
    scope: 'browser',
    output: 'trusted',
    justification: 'Trace category capture. Browser-scoped to serialize against other CDP ops.',
  },
  {
    domain: 'Tracing',
    method: 'end',
    scope: 'browser',
    output: 'untrusted',
    justification: 'Trace dump may contain URLs and page data; wrap.',
  },
  // ─── Emulation (viewport/device) ───────────────────────────
  {
    domain: 'Emulation',
    method: 'setDeviceMetricsOverride',
    scope: 'tab',
    output: 'trusted',
    justification: 'Viewport/scale override on the active tab.',
  },
  {
    domain: 'Emulation',
    method: 'clearDeviceMetricsOverride',
    scope: 'tab',
    output: 'trusted',
    justification: 'Clear viewport override.',
  },
  {
    domain: 'Emulation',
    method: 'setUserAgentOverride',
    scope: 'tab',
    output: 'trusted',
    justification: 'UA override on the active tab. NOTE: changes affect future requests; fine for tests.',
  },
  // ─── Page capture (output, not navigation) ─────────────────
  {
    domain: 'Page',
    method: 'captureScreenshot',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Screenshot bytes; output is bounded image data (no marker injection vector).',
  },
  {
    domain: 'Page',
    method: 'printToPDF',
    scope: 'tab',
    output: 'untrusted',
    justification: 'PDF bytes; bounded binary output.',
  },
  // NOTE: Page.navigate is INTENTIONALLY NOT on the allowlist (Codex T2 cat 4).
  // Use $B goto for navigation; that path goes through the URL blocklist.
  // ─── Network metadata (NOT bodies/cookies — those exfil data) ──
  {
    domain: 'Network',
    method: 'enable',
    scope: 'tab',
    output: 'trusted',
    justification: 'Domain enable; required prerequisite. Does not return data.',
  },
  {
    domain: 'Network',
    method: 'disable',
    scope: 'tab',
    output: 'trusted',
    justification: 'Domain disable; mirrors Network.enable for cleanup symmetry.',
  },
  // NOTE: Network.getResponseBody, Network.getCookies, Network.replayXHR,
  // Network.loadNetworkResource are INTENTIONALLY NOT allowed (Codex T2 cat 7).
  // ─── Runtime (limited, NO evaluate/callFunctionOn) ──────────
  // Runtime.evaluate/callFunctionOn/compileScript/runScript = RCE if exposed (Codex T2 cat 6).
  // Only a tiny safe subset:
  {
    domain: 'Runtime',
    method: 'getProperties',
    scope: 'tab',
    output: 'untrusted',
    justification: 'Inspect properties of an existing remote object. Read-only; output may contain page data.',
  },
]);

const CDP_ALLOWLIST_INDEX: Map<string, CdpAllowEntry> = new Map(
  CDP_ALLOWLIST.map((e) => [`${e.domain}.${e.method}`, e]),
);

export function lookupCdpMethod(qualifiedName: string): CdpAllowEntry | null {
  return CDP_ALLOWLIST_INDEX.get(qualifiedName) ?? null;
}

export function isCdpMethodAllowed(qualifiedName: string): boolean {
  return CDP_ALLOWLIST_INDEX.has(qualifiedName);
}
