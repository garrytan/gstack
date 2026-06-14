/**
 * User-supplied browser launch overrides, read from the environment so they
 * apply without patching the source. Both the headless `launch()` and the
 * headed `launchHeaded()` paths consult these helpers.
 *
 *   GSTACK_CHROMIUM_ARGS    extra Chromium command-line flags appended to the
 *                           launch args. Accepts a JSON array
 *                           (e.g. '["--use-fake-ui-for-media-stream"]') or a
 *                           whitespace-separated string
 *                           (e.g. '--flag-a --flag-b'). Empty/unset → no flags.
 *
 *   GSTACK_HTTP_CREDENTIALS HTTP basic-auth credentials as "user:pass", used to
 *                           auto-answer 401 challenges (e.g. a dev environment
 *                           behind a shared gate). Empty/unset → no credentials.
 *
 * Both default to a no-op, so the out-of-the-box launch behavior is unchanged.
 */

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

/**
 * Parse extra Chromium launch flags from GSTACK_CHROMIUM_ARGS.
 * JSON array of strings → used verbatim; any other non-empty string → split on
 * whitespace (the natural shape for CLI flags). Returns [] when unset/blank.
 */
export function parseExtraChromiumArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.GSTACK_CHROMIUM_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed.filter((v) => v.trim().length > 0);
    }
  } catch {
    // Not JSON — fall through to whitespace splitting.
  }
  return stripWrappingQuotes(raw.trim()).split(/\s+/).filter((v) => v.length > 0);
}

export interface HttpCredentials {
  username: string;
  password: string;
}

/**
 * Parse HTTP basic-auth credentials from GSTACK_HTTP_CREDENTIALS ("user:pass").
 * Splits on the first colon so passwords may contain colons. Returns undefined
 * when unset, blank, or missing a colon.
 */
export function parseHttpCredentials(
  env: NodeJS.ProcessEnv = process.env,
): HttpCredentials | undefined {
  const raw = env.GSTACK_HTTP_CREDENTIALS || '';
  const idx = raw.indexOf(':');
  if (idx <= 0) return undefined;
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}
