/**
 * Snapshot flag metadata for agent-browser.
 *
 * Replaces browse/src/snapshot.ts SNAPSHOT_FLAGS for doc generation and validation.
 *
 * agent-browser supports: -i, -c, -s (as flags on `snapshot`)
 * Diff and annotated screenshots are separate commands:
 *   - `diff snapshot` replaces `snapshot -D`
 *   - `screenshot --annotate` replaces `snapshot -a -o`
 *
 * Imported by:
 *   - gen-skill-docs.ts (generates {{SNAPSHOT_FLAGS}} tables)
 *   - skill-parser.ts (validates flags in SKILL.md examples)
 */

interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  selector?: string;
}

export const SNAPSHOT_FLAGS: Array<{
  short: string;
  long: string;
  description: string;
  takesValue?: boolean;
  valueHint?: string;
  optionKey: keyof SnapshotOptions;
}> = [
  { short: '-i', long: '--interactive', description: 'Interactive elements only (buttons, links, inputs) with @e refs', optionKey: 'interactive' },
  { short: '-c', long: '--compact', description: 'Compact (no empty structural nodes)', optionKey: 'compact' },
  { short: '-s', long: '--selector', description: 'Scope to CSS selector', takesValue: true, valueHint: '<sel>', optionKey: 'selector' },
];

/**
 * Parse CLI args into SnapshotOptions — driven by SNAPSHOT_FLAGS metadata.
 */
export function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (let i = 0; i < args.length; i++) {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === args[i] || f.long === args[i]);
    if (!flag) throw new Error(`Unknown snapshot flag: ${args[i]}`);
    if (flag.takesValue) {
      const value = args[++i];
      if (!value) throw new Error(`Usage: snapshot ${flag.short} <value>`);
      (opts as any)[flag.optionKey] = value;
    } else {
      (opts as any)[flag.optionKey] = true;
    }
  }
  return opts;
}
