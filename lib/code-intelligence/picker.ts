/**
 * Picker — constructs the code-intelligence provider the user selected, and
 * offers the recommendation order (GBrain first) for the selection UX.
 *
 * `resolveSelectedProvider()` reads the persisted selection and constructs that
 * provider, or returns null when nothing is selected — the provider-OFF path,
 * where callers degrade to grep / the file-only decision store. Availability is
 * proven at call time: a selected provider whose tool/server is absent throws
 * PROVIDER_UNAVAILABLE from its ops, which callers catch and degrade on. The
 * `detectAvailable()` probe drives the `options`/`status` display.
 *
 * GBrain is recommended first. Graphify is NEVER auto-installed — it appears in
 * the options only once its CLI is present (a user install).
 */

import { localEngineStatus } from "../gbrain-local-status";
import { GbrainProvider } from "./gbrain-adapter";
import { GraphifyProvider, graphifyInstalled, type GraphifyOptions } from "./graphify-adapter";
import { SourcebotProvider, type SourcebotOptions } from "./sourcebot-adapter";
import { readSelection, getRoot } from "./selection";
import type { CodeProvider, CodeProviderId } from "./contract";

/** Recommendation order — GBrain first. */
export const RECOMMENDED_ORDER: readonly CodeProviderId[] = ["gbrain", "sourcebot", "graphify"];

export interface PickerOptions {
  env?: NodeJS.ProcessEnv;
  graphify?: GraphifyOptions;
  sourcebot?: SourcebotOptions;
}

/** Construct a provider by id (no availability check — ops degrade at call time). */
export function providerById(id: CodeProviderId, opts: PickerOptions = {}): CodeProvider {
  switch (id) {
    case "gbrain":
      return new GbrainProvider();
    case "graphify": {
      // Default the graph root to the repo Graphify last indexed, so `search`
      // reads the same graph `index` built (not whatever cwd happens to be).
      const root = opts.graphify?.root ?? getRoot("graphify", opts.env);
      return new GraphifyProvider({ env: opts.env, ...opts.graphify, ...(root ? { root } : {}) });
    }
    case "sourcebot":
      return new SourcebotProvider({ env: opts.env, ...opts.sourcebot });
  }
}

/**
 * The provider the user selected, constructed, or null when none is selected.
 * Null is the provider-OFF path: callers MUST degrade to grep / file-only.
 */
export function resolveSelectedProvider(opts: PickerOptions = {}): CodeProvider | null {
  const { provider } = readSelection(opts.env);
  return provider ? providerById(provider, opts) : null;
}

export interface Availability {
  id: CodeProviderId;
  available: boolean;
  detail: string;
}

/**
 * Probe which providers are usable right now, in recommendation order. Used by
 * the `options`/`status` display. GBrain via the real localEngineStatus();
 * Graphify via its CLI status; Sourcebot via an HTTP liveness probe.
 */
export async function detectAvailable(opts: PickerOptions = {}): Promise<Availability[]> {
  const gbrainStatus = localEngineStatus({ env: opts.env });
  const gbrainOk = gbrainStatus === "ok" || gbrainStatus === "timeout";

  // Available = the CLI is installed and selectable (NOT "a graph already exists
  // here"). A freshly installed Graphify with no graph yet is still available.
  const graphifyOk = graphifyInstalled(opts.env);
  let graphifyDetail = "graphify CLI not installed (pip install graphifyy, Python >= 3.10)";
  if (graphifyOk) {
    try {
      const s = await new GraphifyProvider({ env: opts.env, ...opts.graphify }).status();
      graphifyDetail = s.state === "ready" ? "installed; graph built in this repo" : "installed; run `index` to build a graph";
    } catch {
      graphifyDetail = "installed";
    }
  }

  let sourcebotOk = false;
  let sourcebotDetail = "server unreachable";
  try {
    const s = await new SourcebotProvider({ env: opts.env, ...opts.sourcebot }).status();
    sourcebotOk = s.state === "ready";
    sourcebotDetail = s.detail ?? "";
  } catch {
    sourcebotOk = false;
  }

  return [
    { id: "gbrain", available: gbrainOk, detail: `gbrain engine: ${gbrainStatus}` },
    { id: "sourcebot", available: sourcebotOk, detail: sourcebotDetail },
    { id: "graphify", available: graphifyOk, detail: graphifyDetail },
  ];
}
