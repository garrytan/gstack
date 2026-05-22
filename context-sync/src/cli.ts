import {
  getDefaultConfigPath,
  getStatus,
  initConfig,
  loadConfig,
  runCommit,
  scanConfig,
} from './core';

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (!parsed.command || parsed.flags.has('help') || parsed.flags.has('h')) {
      printHelp();
      return parsed.flags.has('help') || parsed.flags.has('h') ? 0 : 1;
    }

    if (parsed.command === 'init') {
      const result = initConfig({
        configPath: flagString(parsed, 'config'),
        deviceId: flagString(parsed, 'device-id'),
        driveRoot: flagString(parsed, 'drive-root'),
        force: parsed.flags.has('force'),
      });
      printJson({
        ok: true,
        command: 'init',
        created: result.created,
        configPath: result.configPath,
        config: result.config,
      });
      return 0;
    }

    if (parsed.command === 'scan') {
      if (!parsed.flags.has('dry-run')) {
        throw new Error('scan requires --dry-run so no raw files are copied by accident.');
      }
      const configPath = flagString(parsed, 'config') || getDefaultConfigPath();
      const config = loadConfig(configPath);
      const report = await scanConfig(config, { configPath, hashFiles: parsed.flags.has('with-hashes') });
      if (parsed.flags.has('summary')) {
        printJson({ ok: true, command: 'scan', summary: summarizeDryRun(report) });
      } else {
        printJson({ ok: true, command: 'scan', report });
      }
      return 0;
    }

    if (parsed.command === 'run') {
      if (!parsed.flags.has('commit')) {
        throw new Error('run requires --commit. Use "gstack-context-sync scan --dry-run" first.');
      }
      const configPath = flagString(parsed, 'config') || getDefaultConfigPath();
      const config = loadConfig(configPath);
      const result = await runCommit(config, { configPath });
      printJson({ ok: true, command: 'run', manifestPath: result.manifestPath, manifest: result.manifest });
      return 0;
    }

    if (parsed.command === 'status') {
      const configPath = flagString(parsed, 'config') || getDefaultConfigPath();
      printJson({ ok: true, command: 'status', status: getStatus(configPath) });
      return 0;
    }

    throw new Error(`Unknown command: ${parsed.command}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printJson({ ok: false, error: message });
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') && !command) {
      command = arg;
      continue;
    }
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const [key, inlineValue] = raw.split(/=(.*)/s).filter(Boolean);
      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags.set(key, argv[++i]);
      } else {
        flags.set(key, true);
      }
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return { command, flags };
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`gstack-context-sync

Commands:
  init --device-id <id> --drive-root <path>   Create ~/.gstack/context-sync/config.json
  scan --dry-run                             Inventory planned copies, risk skips, and sensitive findings
  run --commit                               Copy approved raw/readable records into the Drive spine
  status                                     Show config, source, Drive, and device status

Optional:
  --config <path>                            Use a specific config file
  --summary                                  Print counts and samples instead of full planned-copy JSON
  --with-hashes                              Compute full content hashes during dry-run
  --force                                    Replace an existing config during init
`);
}

function summarizeDryRun(report: any): unknown {
  const sensitivePatternCounts = new Map<string, number>();
  for (const finding of report.sensitiveFindings || []) {
    for (const pattern of finding.patterns || []) {
      sensitivePatternCounts.set(pattern, (sensitivePatternCounts.get(pattern) || 0) + 1);
    }
  }

  const skippedReasonCounts = new Map<string, number>();
  for (const skipped of report.skippedRisk || []) {
    skippedReasonCounts.set(skipped.reason, (skippedReasonCounts.get(skipped.reason) || 0) + 1);
  }

  return {
    schemaVersion: report.schemaVersion,
    dryRun: report.dryRun,
    generatedAt: report.generatedAt,
    deviceId: report.deviceId,
    driveRoot: report.driveRoot,
    plannedCount: report.plannedCopies?.length || 0,
    estimatedBytes: report.estimatedBytes,
    sensitiveFindingCount: report.sensitiveFindings?.length || 0,
    skippedRiskCount: report.skippedRisk?.length || 0,
    inventory: report.inventory,
    sensitivePatternFamilies: Array.from(sensitivePatternCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    topSkippedReasons: Array.from(skippedReasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    plannedSamples: (report.plannedCopies || []).slice(0, 50).map((copy: any) => ({
      sourceId: copy.sourceId,
      relativePath: copy.relativePath,
      sizeBytes: copy.sizeBytes,
      hashStatus: copy.hashStatus,
      sensitivePatterns: copy.sensitivePatterns,
    })),
  };
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
