/**
 * Model detection for loadouts (GSTA-161, PR 1b): which loadout an install
 * serves, from explicit inputs only.
 *
 * Order: (1) an explicit loadout name (`--loadout`), served as asked and bound
 * to no model; (2) an explicit model id (`--model`), else `GSTACK_MODEL`;
 * (3) nothing, which is full. A model id is normalized (trim, lowercase, a
 * trailing `[…]` and a `provider/` prefix dropped) and must match MODEL_ID_RE
 * before it can reach generated shell or a launch file. An invalid, unmapped
 * or unreadable input always resolves to full and never errors; only an
 * unknown explicit loadout name is refused. No Claude settings, overlay
 * preference or inherited loadout variable is read.
 * Guide: docs/loadouts.md.
 */
import { FULL, MODEL_ID_RE, ModuleError, loadLoadouts, loadoutForModel, normalizeModelId, rungFor, type LoadoutsManifest } from '../scripts/modules';

export interface LoadoutResolution {
  loadout: string;
  source: 'loadout-flag' | 'model-flag' | 'GSTACK_MODEL' | 'default';
  /** The model an automatic selection is bound to (the matched manifest.models key, so a dated snapshot binds to its base id); null for an explicit or default selection. */
  model: string | null;
  /** Why a given model resolved to full. */
  reason?: 'unmapped' | 'invalid' | 'manifest-unreadable' | 'render-failed';
  /** A LOADOUT_INVALID_MODEL line to print, when the model id was refused. */
  notice?: string;
}

export function resolveLoadout(input: { loadout?: string; model?: string; env?: Record<string, string | undefined>; manifest?: LoadoutsManifest }): LoadoutResolution {
  const env = input.env ?? process.env;
  if (input.loadout !== undefined) {
    const manifest = input.manifest ?? loadLoadouts();
    if (!Object.hasOwn(manifest.loadouts, input.loadout)) {
      throw new ModuleError('LOADOUT_UNKNOWN', `${JSON.stringify(input.loadout.slice(0, 40))} is not a loadout (valid: ${Object.keys(manifest.loadouts).sort().join(', ')})`, 'gstack-modules list');
    }
    return { loadout: input.loadout, source: 'loadout-flag', model: null };
  }
  const raw = input.model ?? env.GSTACK_MODEL;
  if (raw === undefined || raw.trim() === '') return { loadout: FULL, source: 'default', model: null };
  const source = input.model !== undefined ? 'model-flag' : 'GSTACK_MODEL';
  const id = normalizeModelId(raw);
  if (!MODEL_ID_RE.test(id)) {
    const shown = JSON.stringify(raw.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 40));
    return { loadout: FULL, source, model: null, reason: 'invalid', notice: `LOADOUT_INVALID_MODEL: ${shown} is not a plain model id; using full (docs/troubleshooting.md#loadout-invalid-model)` };
  }
  let manifest: LoadoutsManifest;
  try { manifest = input.manifest ?? loadLoadouts(); } catch { return { loadout: FULL, source, model: null, reason: 'manifest-unreadable' }; }
  const mapped = loadoutForModel(manifest, id);
  const loadout = mapped?.loadout ?? manifest.default?.[rungFor(manifest, id)] ?? FULL;
  if (loadout === FULL || !Object.hasOwn(manifest.loadouts, loadout)) return { loadout: FULL, source, model: null, reason: 'unmapped' };
  return { loadout, source, model: mapped?.key ?? id };
}

/** One printable line: `LOADOUT: <name> model=<id|none> source=<s>[ reason=<r>]`. */
export function describeResolution(r: LoadoutResolution): string {
  return `LOADOUT: ${r.loadout} model=${r.model ?? 'none'} source=${r.source}${r.reason ? ` reason=${r.reason}` : ''}`;
}
