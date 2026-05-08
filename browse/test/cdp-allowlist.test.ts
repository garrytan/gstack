import { describe, it, expect } from 'bun:test';
import { CDP_ALLOWLIST, lookupCdpMethod, isCdpMethodAllowed } from '../src/cdp-allowlist';

describe('CDP allowlist (T2: deny-default)', () => {
  it('every entry has all 4 required fields', () => {
    for (const entry of CDP_ALLOWLIST) {
      expect(entry.domain).toBeTruthy();
      expect(entry.method).toBeTruthy();
      expect(['tab', 'browser']).toContain(entry.scope);
      expect(['trusted', 'untrusted']).toContain(entry.output);
      expect(entry.justification).toBeTruthy();
      expect(entry.justification.length).toBeGreaterThan(20); // not a placeholder
    }
  });

  it('no duplicate (domain.method) entries', () => {
    const seen = new Set<string>();
    for (const e of CDP_ALLOWLIST) {
      const key = `${e.domain}.${e.method}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('lookupCdpMethod returns the entry for allowed methods', () => {
    const e = lookupCdpMethod('Accessibility.getFullAXTree');
    expect(e).not.toBeNull();
    expect(e!.scope).toBe('tab');
    expect(e!.output).toBe('untrusted');
  });

  it('isCdpMethodAllowed returns false for dangerous methods that must NOT be allowed (Codex T2)', () => {
    // Code execution surfaces — would be RCE if allowed
    expect(isCdpMethodAllowed('Runtime.evaluate')).toBe(false);
    expect(isCdpMethodAllowed('Runtime.callFunctionOn')).toBe(false);
    expect(isCdpMethodAllowed('Runtime.compileScript')).toBe(false);
    expect(isCdpMethodAllowed('Runtime.runScript')).toBe(false);
    expect(isCdpMethodAllowed('Debugger.evaluateOnCallFrame')).toBe(false);
    expect(isCdpMethodAllowed('Page.addScriptToEvaluateOnNewDocument')).toBe(false);
    expect(isCdpMethodAllowed('Page.createIsolatedWorld')).toBe(false);

    // Navigation — must use $B goto so URL blocklist applies
    expect(isCdpMethodAllowed('Page.navigate')).toBe(false);
    expect(isCdpMethodAllowed('Page.navigateToHistoryEntry')).toBe(false);

    // Exfil surfaces
    expect(isCdpMethodAllowed('Network.getResponseBody')).toBe(false);
    expect(isCdpMethodAllowed('Network.getCookies')).toBe(false);
    expect(isCdpMethodAllowed('Network.replayXHR')).toBe(false);
    expect(isCdpMethodAllowed('Network.loadNetworkResource')).toBe(false);
    expect(isCdpMethodAllowed('Storage.getCookies')).toBe(false);
    expect(isCdpMethodAllowed('Fetch.fulfillRequest')).toBe(false);

    // Browser/process-level mutators
    expect(isCdpMethodAllowed('Browser.close')).toBe(false);
    expect(isCdpMethodAllowed('Browser.crash')).toBe(false);
    expect(isCdpMethodAllowed('Target.attachToTarget')).toBe(false);
    expect(isCdpMethodAllowed('Target.createTarget')).toBe(false);
    expect(isCdpMethodAllowed('Target.setAutoAttach')).toBe(false);
    expect(isCdpMethodAllowed('Target.exposeDevToolsProtocol')).toBe(false);

    // Read-only methods we never added
    expect(isCdpMethodAllowed('Bogus.unknown')).toBe(false);
  });

  it('isCdpMethodAllowed returns true for the small read-only safe set', () => {
    expect(isCdpMethodAllowed('Accessibility.getFullAXTree')).toBe(true);
    expect(isCdpMethodAllowed('DOM.getBoxModel')).toBe(true);
    expect(isCdpMethodAllowed('Performance.getMetrics')).toBe(true);
    expect(isCdpMethodAllowed('Page.captureScreenshot')).toBe(true);
  });

  it('untrusted-output methods cover the read-everything-attacker-controlled cases', () => {
    // Anything that reads attacker-controlled strings (DOM/AX/CSS selectors)
    // should be tagged untrusted so the envelope wraps the result.
    const untrustedMethods = CDP_ALLOWLIST.filter((e) => e.output === 'untrusted').map((e) => `${e.domain}.${e.method}`);
    expect(untrustedMethods).toContain('Accessibility.getFullAXTree');
    expect(untrustedMethods).toContain('CSS.getMatchedStylesForNode');
  });
});
