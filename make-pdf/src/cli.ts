#!/usr/bin/env bun
/**
 * make-pdf CLI — argv parse, dispatch, exit.
 *
 * Output contract (per CEO plan DX spec):
 *   stdout: ONLY the output path on success. One line. Nothing else.
 *   stderr: progress spinner per stage, final "Done in Xs. N pages."
 *   --quiet: suppress progress. Errors still print.
 *   --verbose: per-stage timings.
 *   exit 0 success / 1 bad args / 2 render error / 3 Paged.js timeout / 4 browse unavailable.
 */

import { COMMANDS } from "./commands";
import { ExitCode, BrowseClientError } from "./types";
import type { GenerateOptions, PreviewOptions } from "./types";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(ExitCode.Success);
  }

  // First non-flag arg is the command.
  let command = "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!command) {
      command = a;
    } else {
      positional.push(a);
    }
  }

  return { command, positional, flags };
}

function printUsage(): void {
  const lines = [
    "make-pdf — turn markdown into publication-quality PDFs",
    "",
    "Usage:",
  ];
  for (const [name, info] of COMMANDS) {
    lines.push(`  $P ${info.usage}`);
    lines.push(`      ${info.description}`);
  }
  lines.push("");
  lines.push("Page layout:");
  lines.push("  --margins <dim>           All four margins (default: 1in). in, pt, cm, mm.");
  lines.push("  --page-size letter|a4|legal  (aliases: --format)");
  lines.push("");
  lines.push("Document structure:");
  lines.push("  --cover                   Add a cover page.");
  lines.push("  --toc                     Generate clickable table of contents.");
  lines.push("  --no-chapter-breaks       Don't start a new page at every H1.");
  lines.push("");
  lines.push("Branding:");
  lines.push("  --watermark <text>        Diagonal watermark on every page.");
  lines.push("  --header-template <html>");
  lines.push("  --footer-template <html>  Mutex with --page-numbers.");
  lines.push("  --no-confidential         Suppress the CONFIDENTIAL footer.");
  lines.push("");
  lines.push("Output control:");
  lines.push("  --page-numbers / --no-page-numbers   (default: on)");
  lines.push("  --tagged / --no-tagged               (default: on, accessible PDF)");
  lines.push("  --outline / --no-outline             (default: on, PDF bookmarks)");
  lines.push("  --quiet                   Suppress progress on stderr.");
  lines.push("  --verbose                 Per-stage timings on stderr.");
  lines.push("");
  lines.push("Network:");
  lines.push("  --allow-network           Load external images (off by default).");
  lines.push("");
  lines.push("Examples:");
  lines.push("  $P generate letter.md");
  lines.push("  $P generate --cover --toc essay.md essay.pdf");
  lines.push("  $P generate --watermark DRAFT memo.md draft.pdf");
  lines.push("  $P preview letter.md");
  lines.push("");
  lines.push("Run `$P setup` to verify browse + Chromium + pdftotext install.");
  console.error(lines.join("\n"));
}

function generateOptionsFromFlags(parsed: ParsedArgs): GenerateOptions {
  const p = parsed.positional;
  if (p.length === 0) {
    console.error("$P generate: missing <input.md>");
    console.error("Usage: $P generate <input.md> [output.pdf] [options]");
    process.exit(ExitCode.BadArgs);
  }
  const f = parsed.flags;
  const booleanFlag = (key: string, def: boolean): boolean => {
    if (f[key] === true) return true;
    if (f[`no-${key}`] === true) return false;
    return def;
  };
  return {
    input: p[0],
    output: p[1],
    margins: f.margins as string | undefined,
    marginTop: f["margin-top"] as string | undefined,
    marginRight: f["margin-right"] as string | undefined,
    marginBottom: f["margin-bottom"] as string | undefined,
    marginLeft: f["margin-left"] as string | undefined,
    pageSize: ((f["page-size"] ?? f.format) as any),
    cover: f.cover === true,
    toc: f.toc === true,
    noChapterBreaks: f["no-chapter-breaks"] === true,
    watermark: typeof f.watermark === "string" ? f.watermark : undefined,
    headerTemplate: typeof f["header-template"] === "string"
      ? f["header-template"] : undefined,
    footerTemplate: typeof f["footer-template"] === "string"
      ? f["footer-template"] : undefined,
    confidential: booleanFlag("confidential", true),
    pageNumbers: booleanFlag("page-numbers", true),
    tagged: booleanFlag("tagged", true),
    outline: booleanFlag("outline", true),
    quiet: f.quiet === true,
    verbose: f.verbose === true,
    allowNetwork: f["allow-network"] === true,
    title: typeof f.title === "string" ? f.title : undefined,
    author: typeof f.author === "string" ? f.author : undefined,
    date: typeof f.date === "string" ? f.date : undefined,
  };
}

function previewOptionsFromFlags(parsed: ParsedArgs): PreviewOptions {
  const p = parsed.positional;
  if (p.length === 0) {
    console.error("$P preview: missing <input.md>");
    console.error("Usage: $P preview <input.md> [options]");
    process.exit(ExitCode.BadArgs);
  }
  const f = parsed.flags;
  const booleanFlag = (key: string, def: boolean): boolean => {
    if (f[key] === true) return true;
    if (f[`no-${key}`] === true) return false;
    return def;
  };
  return {
    input: p[0],
    cover: f.cover === true,
    toc: f.toc === true,
    watermark: typeof f.watermark === "string" ? f.watermark : undefined,
    noChapterBreaks: f["no-chapter-breaks"] === true,
    confidential: booleanFlag("confidential", true),
    allowNetwork: f["allow-network"] === true,
    title: typeof f.title === "string" ? f.title : undefined,
    author: typeof f.author === "string" ? f.author : undefined,
    date: typeof f.date === "string" ? f.date : undefined,
    quiet: f.quiet === true,
    verbose: f.verbose === true,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.command) {
    printUsage();
    process.exit(ExitCode.BadArgs);
  }

  if (!COMMANDS.has(parsed.command)) {
    console.error(`$P: unknown command: ${parsed.command}`);
    console.error("");
    printUsage();
    process.exit(ExitCode.BadArgs);
  }

  try {
    switch (parsed.command) {
      case "version": {
        // Read from VERSION file or fall back to a hard-coded default.
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const versionFile = path.resolve(
            path.dirname(process.argv[1] || ""),
            "../../VERSION",
          );
          const version = fs.readFileSync(versionFile, "utf8").trim();
          console.log(version);
        } catch {
          console.log("make-pdf (version unknown)");
        }
        process.exit(ExitCode.Success);
      }

      case "setup": {
        const { runSetup } = await import("./setup");
        await runSetup();
        process.exit(ExitCode.Success);
      }

      case "generate": {
        const opts = generateOptionsFromFlags(parsed);
        const { generate } = await import("./orchestrator");
        const outputPath = await generate(opts);
        // Contract: stdout = output path only
        console.log(outputPath);
        process.exit(ExitCode.Success);
      }

      case "preview": {
        const opts = previewOptionsFromFlags(parsed);
        const { preview } = await import("./orchestrator");
        const htmlPath = await preview(opts);
        console.log(htmlPath);
        process.exit(ExitCode.Success);
      }

      default:
        // Unreachable: COMMANDS.has guarded above
        process.exit(ExitCode.BadArgs);
    }
  } catch (err: any) {
    if (err instanceof BrowseClientError) {
      console.error(`$P: ${err.message}`);
      process.exit(ExitCode.BrowseUnavailable);
    }
    if (err?.code === "ENOENT") {
      console.error(`$P: file not found: ${err.path ?? err.message}`);
      process.exit(ExitCode.BadArgs);
    }
    if (err?.name === "PagedJsTimeout") {
      console.error(`$P: ${err.message}`);
      process.exit(ExitCode.PagedJsTimeout);
    }
    console.error(`$P: ${err?.message ?? String(err)}`);
    if (parsed.flags.verbose && err?.stack) {
      console.error(err.stack);
    }
    process.exit(ExitCode.RenderError);
  }
}

main();
