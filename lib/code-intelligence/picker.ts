/**
 * Picker — recommends a code-intelligence provider, GBrain first.
 *
 * RECOMMENDED_ORDER is the static "GBrain first" fact the options UX and phase-2
 * resolution filter against. In phase 1 only GBrain is drivable from the runtime
 * (it has a CLI the runtime can spawn); Sourcebot and Graphify are MCP tools in
 * the host session and become resolvable in phase 2 once a host transport is
 * wired. So recommendCodeProvider returns GBrain-or-nothing today, and
 * resolveCodeProvider degrades to null — the provider-OFF path — when GBrain is
 * unavailable. Callers then use grep / the file-only decision store.
 *
 * GBrain availability uses the real detector, localEngineStatus() ("ok"/"timeout"
 * are usable). Graphify is NEVER auto-installed or auto-offered.
 */

import { localEngineStatus, type LocalEngineStatus } from "../gbrain-local-status";
import { GbrainProvider } from "./gbrain-adapter";
import type { CodeProvider, CodeProviderId } from "./contract";

/** Recommendation order — GBrain first. Sourcebot/Graphify join in phase 2. */
export const RECOMMENDED_ORDER: readonly CodeProviderId[] = ["gbrain", "sourcebot", "graphify"];

export interface PickerOptions {
  env?: NodeJS.ProcessEnv;
  /** Inject GBrain status for tests; otherwise probed via localEngineStatus(). */
  gbrainStatus?: LocalEngineStatus;
}

const GBRAIN_USABLE: ReadonlySet<LocalEngineStatus> = new Set(["ok", "timeout"]);

/** Drivable providers, in recommendation order (GBrain first). */
export function recommendCodeProvider(opts: PickerOptions = {}): CodeProvider[] {
  const status = opts.gbrainStatus ?? localEngineStatus({ env: opts.env });
  return GBRAIN_USABLE.has(status) ? [new GbrainProvider()] : [];
}

/**
 * The single recommended provider, or null when none is drivable. Null is the
 * provider-OFF path: callers MUST degrade to grep / file-only, never fail.
 */
export function resolveCodeProvider(opts: PickerOptions = {}): CodeProvider | null {
  return recommendCodeProvider(opts)[0] ?? null;
}
