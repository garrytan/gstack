/**
 * Drawing Inspection Tool CLI.
 *
 * Stateless CLI: each invocation runs a pipeline and writes output files.
 * Follows the design/src/cli.ts pattern.
 *
 * Usage:
 *   bun run Product/src/cli.ts inspect --input drawing.png --output report.html
 *   bun run Product/src/cli.ts layout --input drawing.png
 *   bun run Product/src/cli.ts classify --input drawing.png
 *   bun run Product/src/cli.ts list-checks
 */

import fs from "fs";
import path from "path";
import { COMMANDS } from "./commands";
import { resolveOpenAiKey, resolveAnthropicKey } from "./auth";
import { importDrawing } from "./import/importer";
import { analyzeLayout } from "./layout/analyzer";
import { classifyPart } from "./classify/classifier";
import { runInspection, buildReport } from "./checks/engine";
import { annotateDrawing } from "./render/annotator";
import { generateReportHtml } from "./render/report";
import { VlmClient } from "./vlm/client";
import { DEFAULT_CHECKS_CONFIG } from "./config/defaults";
import { loadChecksConfig } from "./config/loader";
import type { VlmProvider } from "./types";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function printUsage(): void {
  console.log("Drawing Inspection Tool — AI-powered engineering drawing inspection\n");
  console.log("Commands:");
  for (const [name, info] of COMMANDS) {
    console.log(`  ${name.padEnd(14)} ${info.description}`);
    console.log(`  ${"".padEnd(14)} ${info.usage}`);
  }
  console.log("\nAuth: ~/.gstack/openai.json + ~/.gstack/anthropic.json (or env vars)");
}

function createVlmClient(provider?: string): VlmClient {
  return new VlmClient({
    openaiKey: resolveOpenAiKey() ?? undefined,
    anthropicKey: resolveAnthropicKey() ?? undefined,
    defaultProvider: (provider === "openai" ? "openai" : "claude") as VlmProvider,
  });
}

async function cmdInspect(flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = flags.input as string;
  if (!inputPath) {
    console.error("Error: --input <file> is required");
    process.exit(1);
  }

  const outputPath = (flags.output as string) || inputPath.replace(/\.[^.]+$/, "-report.html");
  const configPath = flags.config as string | undefined;
  const provider = flags.provider as string | undefined;

  console.log(`Importing: ${inputPath}`);
  const { input, pages } = await importDrawing(path.resolve(inputPath));

  const vlm = createVlmClient(provider);
  const vlmCall = vlm.callWithRetry.bind(vlm);

  console.log("Analyzing layout...");
  const layouts = await Promise.all(pages.map((p) => analyzeLayout(p, vlmCall)));

  console.log("Classifying part...");
  const classification = await classifyPart(pages[0], layouts[0], vlmCall);
  console.log(`  → ${classification.category} (${classification.businessUnit})${classification.material ? `, Material: ${classification.material}` : ""}`);

  const checksConfig = configPath
    ? loadChecksConfig(path.resolve(configPath))
    : DEFAULT_CHECKS_CONFIG;

  console.log(`Running ${checksConfig.checks.filter(c => c.enabled).length} checks...`);
  const results = await runInspection(
    pages,
    layouts,
    classification,
    checksConfig.checks,
    vlmCall,
    {
      onCheckStart: (check) => process.stdout.write(`  [${check.rank}] ${check.id} ${check.name}...`),
      onCheckComplete: (result) => console.log(` ${result.verdict.toUpperCase()}`),
    },
  );

  const report = buildReport(input.filePath, input.fileName, classification, layouts, results);

  // Annotate drawing
  console.log("Generating annotated drawing...");
  const allEvidence = results.flatMap((r) => r.evidence);
  const annotatedPage = await annotateDrawing(pages[0], allEvidence);
  const annotatedBase64 = annotatedPage.toString("base64");

  // Generate HTML report
  const html = generateReportHtml(report, annotatedBase64);
  fs.writeFileSync(outputPath, html);

  // Print summary
  const s = report.summary;
  console.log("\n=== Inspection Summary ===");
  console.log(`Total: ${s.totalChecks} | Pass: ${s.passed} | Fail: ${s.failed} | Warn: ${s.warnings} | Skip: ${s.skipped}`);
  console.log(`C-Rank: ${Math.round(s.cRankScore * 100)}% | B-Rank: ${Math.round(s.bRankScore * 100)}% | A-Rank: ${Math.round(s.aRankScore * 100)}%`);
  console.log(`\nReport: ${outputPath}`);

  // Also write JSON report
  const jsonPath = outputPath.replace(/\.html$/, ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`JSON:   ${jsonPath}`);
}

async function cmdLayout(flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = flags.input as string;
  if (!inputPath) {
    console.error("Error: --input <file> is required");
    process.exit(1);
  }

  const { pages } = await importDrawing(path.resolve(inputPath));
  const vlm = createVlmClient(flags.provider as string);
  const vlmCall = vlm.callWithRetry.bind(vlm);

  console.log("Analyzing layout...");
  const layout = await analyzeLayout(pages[0], vlmCall);

  console.log(`Found ${layout.regions.length} regions:`);
  for (const r of layout.regions) {
    console.log(`  ${r.type.padEnd(18)} ${r.label || ""} (confidence: ${Math.round(r.confidence * 100)}%)`);
    console.log(`  ${"".padEnd(18)} bbox: x=${r.bbox.x.toFixed(2)} y=${r.bbox.y.toFixed(2)} w=${r.bbox.w.toFixed(2)} h=${r.bbox.h.toFixed(2)}`);
  }

  // Save annotated image if --output specified
  const outputPath = flags.output as string;
  if (outputPath) {
    const evidence = layout.regions.map((r) => ({
      type: "bbox" as const,
      bbox: r.bbox,
      description: `${r.type}${r.label ? `: ${r.label}` : ""}`,
      severity: "minor" as const,
    }));
    const annotated = await annotateDrawing(pages[0], evidence);
    fs.writeFileSync(outputPath, annotated);
    console.log(`\nAnnotated: ${outputPath}`);
  }
}

async function cmdClassify(flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = flags.input as string;
  if (!inputPath) {
    console.error("Error: --input <file> is required");
    process.exit(1);
  }

  const { pages } = await importDrawing(path.resolve(inputPath));
  const vlm = createVlmClient(flags.provider as string);
  const vlmCall = vlm.callWithRetry.bind(vlm);

  const layout = await analyzeLayout(pages[0], vlmCall);
  const classification = await classifyPart(pages[0], layout, vlmCall);

  console.log(JSON.stringify(classification, null, 2));
}

async function cmdListChecks(flags: Record<string, string | boolean>): Promise<void> {
  const configPath = flags.config as string | undefined;
  const config = configPath
    ? loadChecksConfig(path.resolve(configPath))
    : DEFAULT_CHECKS_CONFIG;

  console.log(`${config.checks.length} check items (version ${config.version}):\n`);
  for (const c of config.checks) {
    const status = c.enabled ? "ON" : "OFF";
    const cats = c.categories === "*" ? "all" : (c.categories as string[]).join(", ");
    console.log(`  [${c.rank}] ${c.id} ${c.name}`);
    if (c.nameJa) console.log(`       ${c.nameJa}`);
    console.log(`       Status: ${status} | Categories: ${cats} | Method: ${c.judgmentMethod} | Target: ${Math.round(c.targetAccuracy * 100)}%`);
    console.log();
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  try {
    switch (command) {
      case "inspect":
        await cmdInspect(flags);
        break;
      case "layout":
        await cmdLayout(flags);
        break;
      case "classify":
        await cmdClassify(flags);
        break;
      case "list-checks":
        await cmdListChecks(flags);
        break;
      case "setup":
        console.log("API key setup:");
        console.log("  OpenAI:    Save to ~/.gstack/openai.json: { \"api_key\": \"sk-...\" }");
        console.log("  Anthropic: Save to ~/.gstack/anthropic.json: { \"api_key\": \"sk-ant-...\" }");
        console.log("  Or set OPENAI_API_KEY / ANTHROPIC_API_KEY environment variables");
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
