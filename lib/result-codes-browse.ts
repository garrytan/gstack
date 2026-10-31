/**
 * Result codes for the browse daemon's per-agent features: per-session tabs
 * (#1961) and phone emulation with touch input (#3058). Kept beside
 * lib/result-codes.ts (which spreads this table into RESULT_CODES) so the
 * owner module stays within the module-size ratchet; the same rules apply:
 * one stable docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const BROWSE_RESULT_CODES = {
  // Per-session tabs (#1961).
  BROWSE_SESSION_INVALID: {
    anchor: 'browse-session-invalid',
    summary: 'the session name is not 1-64 letters, digits, dots, colons, underscores or dashes',
    fix: 'pick a name like agent-1 (BROWSE_SESSION=agent-1 or --session agent-1)',
  },
  BROWSE_SESSION_ROOT_ONLY: {
    anchor: 'browse-session-root-only',
    summary: 'only the local root token may name a session; paired and scoped agents get their own tab with newtab',
    fix: 'drop the session field and run newtab, then pass its tabId on every command',
  },
  BROWSE_SESSION_TAB_RESET: {
    anchor: 'browse-session-tab-reset',
    summary: 'this session\'s tab was closed (by closetab, the window, or the idle sweep), so the page it was reading is gone',
    fix: 'open the page again with `browse goto <url>` in the same session, then snapshot again before using @refs',
  },
  BROWSE_SESSION_LIMIT: {
    anchor: 'browse-session-limit',
    summary: 'every session slot is running a command, so no idle session could be closed to make room',
    fix: 'retry when a command finishes, or raise BROWSE_MAX_SESSIONS (default 16)',
  },
  // Phone emulation and touch (#3058).
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
