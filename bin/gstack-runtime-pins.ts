#!/usr/bin/env bun
/**
 * gstack-runtime-pins — the doctor's `project pins` row (lib/runtime-pins.ts).
 *
 *   gstack-runtime-pins --project <dir> [--bun <v>] [--node <v>] [--platform linux|darwin|win32] [--json]
 *
 * Prints one PIN: line per declared pin (tool, constraint, exact|range,
 * file:line, lane), PIN_SKIP: for pins it cannot evaluate, PIN_FAIL: per
 * failing tool, then `PINS_VERDICT: pass|fail|none`. --json prints the report
 * object instead. Exit 0 on pass or none, 1 on fail, 2 on usage.
 */
import * as fs from 'node:fs';
import { collectPins, evaluatePins, renderPinLines, type Running } from '../lib/runtime-pins';

const args = process.argv.slice(2);
let project = '';
let json = false;
let platform: NodeJS.Platform = process.platform;
const running: Running = {};
const usage = () => { console.error('usage: gstack-runtime-pins --project <dir> [--bun <v>] [--node <v>] [--platform linux|darwin|win32] [--json]'); process.exit(2); };
for (let i = 0; i < args.length; i++) {
  const next = () => { if (i + 1 >= args.length) usage(); return args[++i]; };
  switch (args[i]) {
    case '--project': project = next(); break;
    case '--bun': running.bun = next(); break;
    case '--node': running.node = next(); break;
    case '--platform': platform = next() as NodeJS.Platform; break;
    case '--json': json = true; break;
    case '-h': case '--help': console.log('usage: gstack-runtime-pins --project <dir> [--bun <v>] [--node <v>] [--platform linux|darwin|win32] [--json]'); process.exit(0);
    default: usage();
  }
}
if (!project || !fs.existsSync(project)) usage();
const report = evaluatePins(collectPins(project), running, platform);
if (json) console.log(JSON.stringify({ schema_version: 1, project, running, platform, ...report }));
else for (const line of renderPinLines(report, platform)) console.log(line);
process.exit(report.verdict === 'fail' ? 1 : 0);
