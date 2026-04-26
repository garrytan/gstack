/**
 * gstack design CLI — stateless CLI for AI-powered design generation.
 *
 * Unlike the browse binary (persistent Chromium daemon), the design binary
 * is stateless: each invocation resolves a provider, makes API calls, and
 * writes files. Session state for multi-turn iteration is a JSON file in /tmp.
 *
 * Supported providers:
 *   - Google Gemini (default, Nano Banana 2 image + Gemini Flash vision)
 *   - OpenAI (legacy, gpt-4o image_generation + gpt-4o vision)
 *
 * Provider resolution:
 *   1. GSTACK_DESIGN_PROVIDER env var ("gemini" | "openai") — explicit
 *   2. Auto-detect: prefer Gemini if a key is available, fall back to OpenAI
 *
 * Flow:
 *   1. Parse command + flags from argv
 *   2. Resolve provider via ./providers/factory
 *   3. Execute command (API call → write PNG/HTML)
 *   4. Print result JSON to stdout
 */

import { COMMANDS } from "./commands";
import { generate } from "./generate";
import { checkCommand } from "./check";
import { compare } from "./compare";
import { variants } from "./variants";
import { iterate } from "./iterate";
import {
  resolveOpenAIKey,
  saveOpenAIKey,
  resolveGeminiKey,
  saveGeminiKey,
} from "./auth";
import { extractDesignLanguage, updateDesignMd } from "./memory";
import { diffMockups, verifyAgainstMockup } from "./diff";
import { evolve } from "./evolve";
import { generateDesignToCodePrompt } from "./design-to-code";
import { serve } from "./serve";
import { gallery } from "./gallery";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2); // skip bun/node and script path
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
  console.log("gstack design — AI-powered UI mockup generation\n");
  console.log("Commands:");
  for (const [name, info] of COMMANDS) {
    console.log(`  ${name.padEnd(12)} ${info.description}`);
    console.log(`  ${"".padEnd(12)} ${info.usage}`);
  }
  console.log("\nProviders:");
  console.log("  Gemini (default):  ~/.gstack/gemini.json or GEMINI_API_KEY");
  console.log("                     https://aistudio.google.com/app/apikey");
  console.log("  OpenAI (legacy):   ~/.gstack/openai.json or OPENAI_API_KEY");
  console.log("                     https://platform.openai.com/api-keys");
  console.log("\nForce provider: GSTACK_DESIGN_PROVIDER=gemini|openai");
  console.log("Setup:          $D setup");
}

async function readLineFromStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim();
}

async function runSetup(): Promise<void> {
  const existingGemini = resolveGeminiKey();
  const existingOpenAI = resolveOpenAIKey();

  if (existingGemini) {
    console.log("Existing Gemini API key found. Running smoke test on Gemini...");
  } else if (existingOpenAI) {
    console.log("Existing OpenAI API key found (legacy).");
    console.log("Gemini is the new default provider and produces better UI mockups.");
    console.log("Get a Gemini key at: https://aistudio.google.com/app/apikey\n");
    process.stdout.write("Gemini API key (or blank to keep using OpenAI): ");
    const key = await readLineFromStdin();
    if (key) {
      saveGeminiKey(key);
      console.log("Gemini key saved to ~/.gstack/gemini.json (0600 permissions).");
    } else {
      console.log("Keeping OpenAI. Set GSTACK_DESIGN_PROVIDER=openai or clear the Gemini key to force OpenAI.");
    }
  } else {
    console.log("No API key found. Please enter a Gemini API key (recommended).");
    console.log("Get one at: https://aistudio.google.com/app/apikey\n");
    console.log("Or enter an OpenAI key prefixed with 'sk-' to use the legacy provider.\n");

    process.stdout.write("API key: ");
    const key = await readLineFromStdin();

    if (!key) {
      console.error("No key entered.");
      process.exit(1);
    }

    if (key.startsWith("sk-")) {
      saveOpenAIKey(key);
      console.log("OpenAI key saved to ~/.gstack/openai.json (0600 permissions).");
    } else {
      saveGeminiKey(key);
      console.log("Gemini key saved to ~/.gstack/gemini.json (0600 permissions).");
    }
  }

  console.log("\nRunning smoke test (generating a simple image)...");
  try {
    await generate({
      brief: "A simple blue square centered on a white background. Minimal, geometric, clean.",
      output: "/tmp/gstack-design-smoke-test.png",
      size: "1024x1024",
      quality: "low",
    });
    console.log("\nSmoke test PASSED. Design generation is working.");
  } catch (err: any) {
    console.error(`\nSmoke test FAILED: ${err.message}`);
    console.error("Check your API key and provider configuration.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "generate":
      await generate({
        brief: flags.brief as string,
        briefFile: flags["brief-file"] as string,
        output: (flags.output as string) || "/tmp/gstack-mockup.png",
        check: !!flags.check,
        retry: flags.retry ? parseInt(flags.retry as string) : 0,
        size: flags.size as string,
        quality: flags.quality as string,
      });
      break;

    case "check":
      await checkCommand(flags.image as string, flags.brief as string);
      break;

    case "compare": {
      // Parse --images as glob or multiple files
      const imagesArg = flags.images as string;
      const images = await resolveImagePaths(imagesArg);
      const outputPath = (flags.output as string) || "/tmp/gstack-design-board.html";
      compare({ images, output: outputPath });
      // If --serve flag is set, start HTTP server for the board
      if (flags.serve) {
        await serve({
          html: outputPath,
          timeout: flags.timeout ? parseInt(flags.timeout as string) : 600,
        });
      }
      break;
    }

    case "prompt": {
      const promptImage = flags.image as string;
      if (!promptImage) {
        console.error("--image is required");
        process.exit(1);
      }
      console.error(`Generating implementation prompt from ${promptImage}...`);
      const proc2 = Bun.spawn(["git", "rev-parse", "--show-toplevel"]);
      const root = (await new Response(proc2.stdout).text()).trim();
      const d2c = await generateDesignToCodePrompt(promptImage, root || undefined);
      console.log(JSON.stringify(d2c, null, 2));
      break;
    }

    case "setup":
      await runSetup();
      break;

    case "variants":
      await variants({
        brief: flags.brief as string,
        briefFile: flags["brief-file"] as string,
        count: flags.count ? parseInt(flags.count as string) : 3,
        outputDir: (flags["output-dir"] as string) || "/tmp/gstack-variants/",
        size: flags.size as string,
        quality: flags.quality as string,
        viewports: flags.viewports as string,
      });
      break;

    case "iterate":
      await iterate({
        session: flags.session as string,
        feedback: flags.feedback as string,
        output: (flags.output as string) || "/tmp/gstack-iterate.png",
      });
      break;

    case "extract": {
      const imagePath = flags.image as string;
      if (!imagePath) {
        console.error("--image is required");
        process.exit(1);
      }
      console.error(`Extracting design language from ${imagePath}...`);
      const extracted = await extractDesignLanguage(imagePath);
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"]);
      const repoRoot = (await new Response(proc.stdout).text()).trim();
      if (repoRoot) {
        updateDesignMd(repoRoot, extracted, imagePath);
      }
      console.log(JSON.stringify(extracted, null, 2));
      break;
    }

    case "diff": {
      const before = flags.before as string;
      const after = flags.after as string;
      if (!before || !after) {
        console.error("--before and --after are required");
        process.exit(1);
      }
      console.error(`Comparing ${before} vs ${after}...`);
      const diffResult = await diffMockups(before, after);
      console.log(JSON.stringify(diffResult, null, 2));
      break;
    }

    case "verify": {
      const mockup = flags.mockup as string;
      const screenshot = flags.screenshot as string;
      if (!mockup || !screenshot) {
        console.error("--mockup and --screenshot are required");
        process.exit(1);
      }
      console.error(`Verifying implementation against approved mockup...`);
      const verifyResult = await verifyAgainstMockup(mockup, screenshot);
      console.error(`Match: ${verifyResult.matchScore}/100 — ${verifyResult.pass ? "PASS" : "FAIL"}`);
      console.log(JSON.stringify(verifyResult, null, 2));
      break;
    }

    case "evolve":
      await evolve({
        screenshot: flags.screenshot as string,
        brief: flags.brief as string,
        output: (flags.output as string) || "/tmp/gstack-evolved.png",
      });
      break;

    case "gallery":
      gallery({
        designsDir: flags["designs-dir"] as string,
        output: (flags.output as string) || "/tmp/gstack-design-gallery.html",
      });
      break;

    case "serve":
      await serve({
        html: flags.html as string,
        timeout: flags.timeout ? parseInt(flags.timeout as string) : 600,
      });
      break;
  }
}

/**
 * Resolve image paths from a glob pattern or comma-separated list.
 */
async function resolveImagePaths(input: string): Promise<string[]> {
  if (!input) {
    console.error("--images is required. Provide glob pattern or comma-separated paths.");
    process.exit(1);
  }

  // Check if it's a glob pattern
  if (input.includes("*")) {
    const glob = new Bun.Glob(input);
    const paths: string[] = [];
    for await (const match of glob.scan({ absolute: true })) {
      if (match.endsWith(".png") || match.endsWith(".jpg") || match.endsWith(".jpeg")) {
        paths.push(match);
      }
    }
    return paths.sort();
  }

  // Comma-separated or single path
  return input.split(",").map(p => p.trim());
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
