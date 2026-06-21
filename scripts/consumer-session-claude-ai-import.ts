#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";

import {
  defaultClaudeAiInputPath,
  defaultClaudeAiOutputDir,
  dryRunClaudeAiExport,
  isClaudeAiParseError,
  summarizeClaudeAiDiagnostics,
  writeClaudeAiNormalizedExport,
} from "../lib/consumer-session-claude-ai";

interface Args {
  inputPath: string;
  outputDir: string;
  dryRun: boolean;
}

function usage(): void {
  console.error(`Usage: bun run scripts/consumer-session-claude-ai-import.ts [options]

Options:
  --input <path>       Claude.ai export JSON file or folder.
                       Defaults to ~/.gstack/consumer-sessions/raw/claude-ai.
  --output <path>      Normalized output folder.
                       Defaults to ~/.gstack/consumer-sessions/normalized/claude-ai.
  --dry-run            Print metadata, counts, diagnostics, and planned output paths only.
  --help               Show this text.
`);
}

function parseArgs(): Args {
  const gstackHome = process.env.GSTACK_HOME || join(homedir(), ".gstack");
  let inputPath = defaultClaudeAiInputPath(gstackHome);
  let outputDir = defaultClaudeAiOutputDir(gstackHome);
  let dryRun = false;
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
        inputPath = argv[++i] || "";
        break;
      case "--output":
        outputDir = argv[++i] || "";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        usage();
        process.exit(1);
    }
  }

  if (!inputPath) {
    console.error("--input requires a path");
    process.exit(1);
  }
  if (!outputDir) {
    console.error("--output requires a path");
    process.exit(1);
  }

  return { inputPath, outputDir, dryRun };
}

function main(): void {
  const args = parseArgs();
  try {
    if (args.dryRun) {
      const report = dryRunClaudeAiExport({ inputPath: args.inputPath, outputDir: args.outputDir });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.diagnostics.length > 0 ? 1 : 0);
    }
    const result = writeClaudeAiNormalizedExport({ inputPath: args.inputPath, outputDir: args.outputDir });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (isClaudeAiParseError(err)) {
      console.error(summarizeClaudeAiDiagnostics(err.diagnostics));
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.main) main();
