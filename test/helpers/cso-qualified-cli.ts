import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchCsoCommand, type CsoCliDependencies } from '../../lib/cso/cli';
import { canonical, sha256 } from '../../lib/cso/contracts';
import { validateRuntimeCatalog, type QualifiedRuntime, type RuntimeCatalog, type RuntimePlatform } from '../../lib/cso/runtime-catalog';
import { completeRuntimeCatalogFixture } from './cso-runtime-catalog';

export interface QualifiedCsoCli {
  readonly catalog: RuntimeCatalog;
  readonly runtime: QualifiedRuntime;
  command<T = unknown>(args: string[]): Promise<T>;
}

/** Bind a staged Node image to the real command dispatcher without adding a production override. */
export function qualifiedNodeCli(options: {
  image: string;
  versions: Record<string, string>;
  watchdogPath: string;
  platform: RuntimePlatform;
}): QualifiedCsoCli {
  if (!path.isAbsolute(options.watchdogPath) || !fs.statSync(options.watchdogPath).isFile()) {
    throw new Error('Node lifecycle qualification requires an absolute compiled watchdog path');
  }
  for (const key of ['node', 'npm', 'cso-preparation']) {
    if (!/^\d+\.\d+\.\d+$/.test(options.versions[key] ?? '')) {
      throw new Error(`Node lifecycle qualification requires exact ${key} version metadata`);
    }
  }
  if (options.versions['cso-preparation'] !== '1.0.0') {
    throw new Error('Node lifecycle qualification requires cso-preparation 1.0.0');
  }

  const catalog = completeRuntimeCatalogFixture('node-lifecycle-fixture');
  const runtimeIndex = catalog.runtimes.findIndex(item => item.stack === 'node' && item.platform === options.platform);
  const profile = catalog.profiles.find(item => item.stack === 'node' && item.platform === options.platform);
  if (runtimeIndex < 0 || !profile || !catalog.promotion) throw new Error('Node lifecycle catalog fixture is incomplete');
  const runtime: QualifiedRuntime = {
    ...catalog.runtimes[runtimeIndex],
    image: options.image,
    versions: { ...options.versions },
  };
  catalog.runtimes[runtimeIndex] = runtime;
  profile.versions = { ...runtime.versions };
  catalog.promotion.evidenceDigest = `sha256:${sha256(canonical(catalog.runtimes))}`;
  validateRuntimeCatalog(catalog);

  const dependencies: CsoCliDependencies = Object.freeze({
    runtimeCatalog: catalog,
    watchdogPath: () => options.watchdogPath,
  });
  return Object.freeze({
    catalog,
    runtime,
    async command<T = unknown>(args: string[]): Promise<T> {
      const [command, ...commandArgs] = args;
      if (!command) throw new Error('CSO qualification command is required');
      return await dispatchCsoCommand(command, commandArgs, dependencies) as T;
    },
  });
}
