/**
 * Result codes for the browse daemon's phone emulation and touch verbs
 * (`$B device`, `$B tap|swipe|pinch|touch`; #3058). Kept beside
 * lib/result-codes.ts, which spreads this table into RESULT_CODES; the same
 * rules apply: one stable docs/troubleshooting.md anchor, a summary and a fix.
 */
import type { ResultCode } from './result-codes';

export const BROWSE_RESULT_CODES = {
  BROWSE_DEVICE_UNKNOWN: {
    anchor: 'browse-device-unknown',
    summary: 'no Playwright device has that name, so nothing on the tab changed',
    fix: '$B device --list',
  },
  BROWSE_DEVICE_CDP_FAILED: {
    anchor: 'browse-device-cdp-failed',
    summary: 'Chromium refused a device emulation call on this tab',
    fix: '$B device off',
  },
  BROWSE_TOUCH_NO_DEVICE: {
    anchor: 'browse-touch-no-device',
    summary: 'touch input needs a phone profile on this tab first',
    fix: '$B device "iPhone 15"',
  },
} as const satisfies Record<string, ResultCode>;
