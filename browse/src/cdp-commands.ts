/**
 * $B cdp <Domain.method> [json-params] — CLI surface for the CDP escape hatch.
 *
 * Output for trusted methods is a plain JSON pretty-print.
 * Output for untrusted methods is wrapped with the centralized UNTRUSTED EXTERNAL
 * CONTENT envelope so the sidebar-agent classifier sees it (matches the pattern
 * used by other untrusted-content commands in commands.ts).
 */

import type { BrowserManager } from './browser-manager';
import { dispatchCdpCall } from './cdp-bridge';
import { wrapUntrustedContent } from './commands';

function parseQualified(name: string): { domain: string; method: string } {
  const idx = name.indexOf('.');
  if (idx <= 0 || idx === name.length - 1) {
    throw new Error(
      `Usage: $B cdp <Domain.method> [json-params]\n` +
        `Cause: '${name}' is not in Domain.method format.\n` +
        'Action: e.g. $B cdp Accessibility.getFullAXTree {}'
    );
  }
  return { domain: name.slice(0, idx), method: name.slice(idx + 1) };
}

export async function handleCdpCommand(args: string[], bm: BrowserManager): Promise<string> {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    return [
      '$B cdp — raw CDP method dispatch (deny-default escape hatch)',
      '',
      'Usage: $B cdp <Domain.method> [json-params]',
      '',
      'Allowed methods are listed in browse/src/cdp-allowlist.ts. To add one,',
      'open a PR with a one-line justification and the (scope, output) tags.',
      'Examples:',
      '  $B cdp Accessibility.getFullAXTree {}',
      '  $B cdp Performance.getMetrics {}',
      '  $B cdp DOM.describeNode \'{"backendNodeId":42,"depth":3}\'',
    ].join('\n');
  }
  const qualified = args[0]!;
  const { domain, method } = parseQualified(qualified);
  // Optional second arg is JSON params; default to {}.
  let params: Record<string, unknown> = {};
  if (args[1]) {
    try {
      params = JSON.parse(args[1]) ?? {};
    } catch (e: any) {
      throw new Error(
        `Cannot parse params as JSON: ${e.message}\n` +
          `Cause: argument '${args[1]}' is not valid JSON.\n` +
          'Action: pass a JSON object literal, e.g. \'{"backendNodeId":42}\'.'
      );
    }
  }
  // Dispatch via the bridge (allowlist + mutex + timeout + finally-release).
  const tabId = bm.getActiveTabId();
  const { raw, entry } = await dispatchCdpCall({ domain, method, params, tabId, bm });
  const json = JSON.stringify(raw, null, 2);
  if (entry.output === 'untrusted') {
    return wrapUntrustedContent(json, `cdp:${qualified}`);
  }
  return json;
}
