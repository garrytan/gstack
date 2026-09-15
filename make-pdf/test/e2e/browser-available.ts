/**
 * Gate prerequisite shared by the make-pdf e2e gates: SOME browser the
 * compiled binary can print through — the Aside app (macOS dev machines) or
 * gstack's own browse binary (what the Linux free-tests lane builds via
 * build:gates). Mirrors lib/aside-render's pickEngine() order.
 */
import { resolveBrowseBin } from "../../../lib/aside-render";
import { asideAvailable } from "../../../test/helpers/aside-available";

export const NO_BROWSER_REASON =
  "no browser available (open the Aside app, or build gstack's own browser with `bun run build:gates`; GSTACK_SKIP_ASIDE=1 skips Aside).";

export function browserAvailable(): boolean {
  return asideAvailable() || resolveBrowseBin() !== null;
}
