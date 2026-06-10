export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
export const COLD_LOCAL_ROUTE_TIMEOUT_MS = 90_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MIN_WAIT_TIMEOUT_MS = 1_000;

export interface ParsedWaitTimeout {
  timeout: number;
  explicit: boolean;
}

function clampWaitTimeout(timeout: number): number {
  return Math.min(Math.max(timeout, MIN_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS);
}

export function parseWaitTimeout(rawTimeout: string | undefined): ParsedWaitTimeout {
  if (rawTimeout === undefined || rawTimeout === '') {
    return { timeout: DEFAULT_WAIT_TIMEOUT_MS, explicit: false };
  }
  return { timeout: clampWaitTimeout(parseInt(rawTimeout, 10) || MIN_WAIT_TIMEOUT_MS), explicit: true };
}

function isLocalDevHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1'
    || normalized === '::1' || normalized === '[::1]';
}

export function localRouteKey(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLocalDevHostname(url.hostname)) {
    return null;
  }
  return `${url.origin}${url.pathname}`;
}
