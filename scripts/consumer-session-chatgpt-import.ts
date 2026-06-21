#!/usr/bin/env bun

import {
  defaultChatGptNormalizedPath,
  defaultChatGptRawPath,
  importChatGptConsumerSessions,
} from "../lib/consumer-session-chatgpt";

interface Args {
  input?: string;
  output?: string;
  dryRun: boolean;
  help: boolean;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const report = importChatGptConsumerSessions({
    inputPath: args.input,
    outputPath: args.output,
    dryRun: args.dryRun,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`consumer-session-chatgpt-import: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--input") {
      parsed.input = requireValue(argv, ++i, "--input");
      continue;
    }
    if (arg.startsWith("--input=")) {
      parsed.input = arg.slice("--input=".length);
      continue;
    }
    if (arg === "--output") {
      parsed.output = requireValue(argv, ++i, "--output");
      continue;
    }
    if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  const gstackHome = process.env.GSTACK_HOME || `${process.env.HOME || "~"}/.gstack`;
  process.stderr.write(`Usage: consumer-session-chatgpt-import [--input PATH] [--output PATH] [--dry-run]

Normalize a ChatGPT official export into ConsumerSession JSON.

Defaults:
  input:  ${defaultChatGptRawPath(gstackHome)}
  output: ${defaultChatGptNormalizedPath(gstackHome)}

Supported input shapes:
  - extracted official export directory containing conversations.json
  - direct conversations.json file
  - .zip official export, extracted with system unzip

Dry-run prints counts and planned output paths only; it does not print chat text.
`);
}
