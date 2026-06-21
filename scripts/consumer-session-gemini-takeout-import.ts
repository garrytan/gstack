#!/usr/bin/env bun

import { displayGeminiTakeoutImportResult, importGeminiTakeout } from "../lib/consumer-session-gemini";

interface Args {
  inputPath?: string;
  outputPath?: string;
  gstackHome?: string;
  dryRun: boolean;
}

function usage(): string {
  return `Usage: consumer-session-gemini-takeout-import [options]

Options:
  --input <path>       Extracted Google Takeout folder, .zip, .tgz, or .tar.gz.
                       Default: ~/.gstack/consumer-sessions/raw/gemini
  --output <path>      Normalized output folder.
                       Default: ~/.gstack/consumer-sessions/normalized/gemini
  --gstack-home <path> Override GSTACK_HOME for default input/output roots.
  --dry-run           Print counts and planned output paths only; no chat text.
  --help              Show this text.
`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
        args.inputPath = requireValue(argv, ++i, "--input");
        break;
      case "--output":
        args.outputPath = requireValue(argv, ++i, "--output");
        break;
      case "--gstack-home":
        args.gstackHome = requireValue(argv, ++i, "--gstack-home");
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`unknown_arg:${arg}`);
    }
  }
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = importGeminiTakeout({
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    gstackHome: args.gstackHome,
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(args.dryRun ? displayGeminiTakeoutImportResult(result) : result, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage());
  process.exit(1);
}
