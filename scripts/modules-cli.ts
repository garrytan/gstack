/**
 * bin/gstack-modules (GSTA-140, PR 1a): the module catalog and loadout renders.
 *
 *   gstack-modules list [--json] [--pinned]
 *   gstack-modules validate
 *   gstack-modules render --host <h> (--loadout <name> | --modules <base>,-id,+id) --out-dir <d>
 *                         [--install-root <abs>] [--model <id>] [--plan-mode on|off]
 *
 * Exit 0 on success, 2 on a refused input (ModuleError, printed with its code,
 * fix and docs anchor), 1 on an unexpected failure.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHostArg } from '../hosts/index';
import { resolveModel } from './models';
import { LOADOUTS_FILE, ModuleError, loadLoadouts, moduleCatalog, selectModules, validateLoadouts } from './modules';
import { renderLoadout } from './modules-render';
import type { Host } from './resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const USAGE = `Usage:
  gstack-modules list [--json] [--pinned]   every module id with its kind, source and pin
  gstack-modules validate                   check ${LOADOUTS_FILE} against the catalog
  gstack-modules render --host <h> (--loadout <name> | --modules <base>,-id,+id) --out-dir <d>
                        [--install-root <abs>] [--model <id>] [--plan-mode on|off]
                                            render one loadout and write loadout.lock.json
Guide: docs/loadouts.md`;

export interface CliResult { code: number; stdout: string; stderr: string }

function flag(args: string[], name: string): string | undefined {
  const index = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const value = args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1];
  if (!value || value.startsWith('--')) throw new ModuleError('MODULE_SPEC_INVALID', `${name} requires a value`, `gstack-modules --help`);
  return value;
}

export async function modulesMain(args: string[]): Promise<CliResult> {
  const [command, ...rest] = args;
  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') return { code: 0, stdout: USAGE + '\n', stderr: '' };
    if (command === 'list') {
      const manifest = loadLoadouts();
      const catalog = moduleCatalog(manifest).filter(e => !rest.includes('--pinned') || e.pinned);
      const rows = catalog.map(e => {
        const bytes = fs.readFileSync(path.join(ROOT, e.source));
        return { ...e, source_bytes: bytes.length, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      });
      if (rest.includes('--json')) return { code: 0, stdout: JSON.stringify({ loadouts: Object.keys(manifest.loadouts), modules: rows }, null, 2) + '\n', stderr: '' };
      const lines = rows.map(r => `${r.id.padEnd(48)} ${r.kind.padEnd(8)} ${r.pinned ? 'pinned' : '      '} ${r.source}`);
      return { code: 0, stdout: [`loadouts: ${Object.keys(manifest.loadouts).join(', ')}`, ...lines].join('\n') + '\n', stderr: '' };
    }
    if (command === 'validate') {
      const manifest = loadLoadouts();
      const problems = validateLoadouts(manifest, moduleCatalog(manifest));
      if (problems.length) return { code: 2, stdout: '', stderr: problems.map(p => `LOADOUTS_INVALID: ${p}`).join('\n') + '\n' };
      return { code: 0, stdout: `LOADOUTS: ok (${Object.keys(manifest.loadouts).length} loadouts)\n`, stderr: '' };
    }
    if (command === 'render') {
      const hostValue = flag(rest, '--host');
      const outDir = flag(rest, '--out-dir');
      if (!hostValue || !outDir) throw new ModuleError('MODULE_SPEC_INVALID', 'render needs --host and --out-dir', 'gstack-modules render --host claude --loadout full --out-dir <dir>');
      let host: Host;
      try { host = resolveHostArg(hostValue) as Host; } catch (error) { throw new ModuleError('MODULE_SPEC_INVALID', (error as Error).message, 'pass a host from docs/hosts.md, for example --host claude'); }
      const loadout = flag(rest, '--loadout');
      const modules = flag(rest, '--modules');
      if (loadout === undefined && modules === undefined) throw new ModuleError('MODULE_SPEC_INVALID', 'render needs --loadout or --modules', 'add --loadout full for the control arm');
      const modelValue = flag(rest, '--model');
      const model = modelValue === undefined ? null : resolveModel(modelValue);
      if (modelValue !== undefined && !model) throw new ModuleError('MODULE_SPEC_INVALID', `--model ${JSON.stringify(modelValue.slice(0, 80))} is not a model gstack knows`, 'pass the same --model setup uses, for example gpt-6-astra');
      const planMode = flag(rest, '--plan-mode');
      if (planMode !== undefined && planMode !== 'on' && planMode !== 'off') throw new ModuleError('MODULE_SPEC_INVALID', '--plan-mode takes on or off', 'drop it, or pass --plan-mode off');
      const installRoot = flag(rest, '--install-root');
      if (installRoot !== undefined && !/^\/[A-Za-z0-9_.@+\/-]*$/.test(installRoot)) throw new ModuleError('MODULE_SPEC_INVALID', '--install-root must be a plain absolute path', 'pass the absolute install root setup would use');
      const selection = selectModules({ loadout, modules });
      const lock = await renderLoadout({ host, selection, outDir, installRoot: installRoot ?? null, model, planMode: planMode !== 'off' });
      return { code: 0, stdout: `RENDERED: loadout=${lock.loadout} host=${host} files=${lock.files.length} bytes=${lock.total_bytes} excluded=${lock.excluded.length} lock=${path.join(path.resolve(outDir), 'loadout.lock.json')}\n`, stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `Unknown command ${JSON.stringify(command.slice(0, 40))}.\n${USAGE}\n` };
  } catch (error) {
    if (error instanceof ModuleError) return { code: 2, stdout: '', stderr: `${error.code}: ${error.message}\n` };
    return { code: 1, stdout: '', stderr: `gstack-modules: unexpected failure: ${(error as Error).message}\n` };
  }
}
