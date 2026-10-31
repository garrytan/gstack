/**
 * gstack design CLI — stateless CLI for AI-powered design generation.
 *
 * Unlike the browse binary (persistent Chromium daemon), the design binary
 * is stateless: each invocation makes API calls and writes files. Session
 * state for multi-turn iteration is a JSON file in /tmp.
 *
 * Flow:
 *   1. Parse command + flags from argv
 *   2. Resolve the provider (GSTACK_DESIGN_PROVIDER, then an OpenAI key, then a Gemini key; see auth.ts)
 *   3. Execute command (API call → write PNG/HTML)
 *   4. Print result JSON to stdout
 */

import { COMMANDS, OUTPUT_CONTRACT } from "./commands";
import { generate } from "./generate";
import { checkCommand } from "./check";
import { compare } from "./compare";
import { variants } from "./variants";
import { iterate } from "./iterate";
import { resolveProvider, saveApiKey, type ProviderName } from "./auth";
import { extractDesignLanguage, updateDesignMd } from "./memory";
import { diffMockups, verifyAgainstMockup } from "./diff";
import { evolve } from "./evolve";
import { generateDesignToCodePrompt } from "./design-to-code";
import { serve } from "./serve";
import { gallery } from "./gallery";
import { normalizeIntFlag } from "./flag-utils";
import { readVersionString } from "./daemon-state";
import { resolveImagePaths } from "./image-args";
import {
  daemonStatus as daemonStatusClient,
  ensureDaemon,
  publishBoard,
  shutdownDaemon,
} from "./daemon-client";
import { spawn as nodeSpawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const args = argv.slice(2); // skip bun/node and script path
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }
  // DESIGN SETUP's launch probe (B4): proves the binary starts, without auth or network.
  if (args[0] === "--version") {
    console.log(readVersionString());
    process.exit(0);
  }

  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

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
    } else {
      positionals.push(arg);
    }
  }

  return { command, flags, positionals };
}

function printUsage(): void {
  console.log("gstack design — AI-powered UI mockup generation\n");
  console.log("Commands:");
  for (const [name, info] of COMMANDS) {
    console.log(`  ${name.padEnd(12)} ${info.description}`);
    console.log(`  ${"".padEnd(12)} ${info.usage}`);
  }
  console.log(`\n${OUTPUT_CONTRACT}`);
  console.log("\nAuth: OpenAI (~/.gstack/openai.json, then OPENAI_API_KEY) when set, else Gemini (~/.gstack/gemini.json, then GEMINI_API_KEY).");
  console.log("GSTACK_DESIGN_PROVIDER=openai|gemini picks one explicitly. Free Gemini key: https://aistudio.google.com/apikey");
  console.log("If a key matches a current-directory .env file, the source is reported before billing.");
  console.log("Setup: $D setup [--provider openai|gemini] [--key-stdin]");
}

const KEY_PREFIX: Record<ProviderName, string> = { openai: "sk-", gemini: "AIza" };
const KEY_PAGE: Record<ProviderName, string> = { openai: "https://platform.openai.com/api-keys", gemini: "https://aistudio.google.com/apikey" };

async function readStdinKey(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim();
}

/**
 * Store a key (prompted, or piped with --key-stdin) and smoke-test the
 * provider it belongs to. --provider or --key-stdin stores the new key even
 * when another provider's key already resolves; with neither, an existing key
 * is smoke-tested as before.
 */
async function runSetup(flags: Record<string, string | boolean>): Promise<void> {
  const requested = flags.provider;
  if (requested !== undefined && requested !== "openai" && requested !== "gemini") {
    console.error("--provider must be openai or gemini.");
    process.exit(1);
  }
  let provider = requested as ProviderName | undefined;
  const existing = provider || flags["key-stdin"] ? null : resolveProvider();
  if (existing) {
    provider = existing.provider;
    console.log(`Existing ${provider === "gemini" ? "Gemini" : "OpenAI"} key found. Running smoke test...`);
  } else {
    if (!flags["key-stdin"] && !process.stdin.isTTY) {
      console.error("No terminal to type a key into.");
      console.error("Fix: printf %s \"$KEY\" | $D setup --provider gemini --key-stdin (or --provider openai), or set GEMINI_API_KEY / OPENAI_API_KEY.");
      process.exit(1);
    }
    if (!flags["key-stdin"]) {
      console.log(provider
        ? `Enter your ${provider === "gemini" ? "Gemini" : "OpenAI"} API key (get one at ${KEY_PAGE[provider]}).`
        : `No API key found. Enter an OpenAI key (sk-…, ${KEY_PAGE.openai}) or a free Gemini key (AIza…, ${KEY_PAGE.gemini}).`);
      process.stdout.write("API key: ");
    }
    const key = await readStdinKey();
    provider ??= key.startsWith(KEY_PREFIX.gemini) ? "gemini" : "openai";
    if (!key || !key.startsWith(KEY_PREFIX[provider])) {
      console.error(`Invalid key. A${provider === "openai" ? "n OpenAI" : " Gemini"} key starts with '${KEY_PREFIX[provider]}'.`);
      process.exit(1);
    }
    saveApiKey(key, provider);
    console.log(`Key saved to ~/.gstack/${provider}.json (0600 permissions).`);
  }

  console.log("\nRunning smoke test (generating a simple image)...");
  const shellProvider = process.env.GSTACK_DESIGN_PROVIDER;
  process.env.GSTACK_DESIGN_PROVIDER = provider;
  const smoke = await generate({
    brief: "A simple blue square centered on a white background. Minimal, geometric, clean.",
    output: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gstack-design-smoke-")), "smoke-test.png"),
    size: "1024x1024",
    quality: "low",
  });
  if (smoke.exitCode !== 0) {
    console.error(`\nSmoke test FAILED: ${smoke.failures.map(f => f.reason).join("; ")}`);
    console.error(provider === "gemini"
      ? "Check your Gemini key and its quota in Google AI Studio."
      : "Check your API key and organization verification status.");
    process.exit(1);
  }
  console.log("\nSmoke test PASSED. Design generation is working.");
  if (shellProvider === undefined) delete process.env.GSTACK_DESIGN_PROVIDER;
  else process.env.GSTACK_DESIGN_PROVIDER = shellProvider;
  let next: ProviderName | null = null;
  try { next = resolveProvider()?.provider ?? null; } catch { /* an invalid shell setting fails the next run with its own Fix line */ }
  if (next !== provider) {
    const label = provider === "gemini" ? "Gemini" : "OpenAI";
    console.log(`Note: later $D runs will not use this ${label} key yet${next ? `; ${next === "gemini" ? "Gemini" : "OpenAI"} is picked first` : ""}.`);
    console.log(`Fix: export GSTACK_DESIGN_PROVIDER=${provider} (add it to your shell profile to keep it).`);
  }
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv);

  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "generate":
      process.exitCode = (await generate({
        brief: flags.brief as string,
        briefFile: flags["brief-file"] as string,
        output: (flags.output as string) || "/tmp/gstack-mockup.png",
        check: !!flags.check,
        retry: normalizeIntFlag(flags.retry, { name: "retry", def: 0, min: 0 }),
        size: flags.size as string,
        quality: flags.quality as string,
      })).exitCode;
      break;

    case "check":
      await checkCommand(flags.image as string, flags.brief as string);
      break;

    case "compare": {
      const images = await resolveImagePaths(flags.images as string, flags["images-file"] as string | undefined);
      const outputPath = (flags.output as string) || "/tmp/gstack-design-board.html";
      compare({ images, output: outputPath });
      // If --serve flag is set, publish the board.
      //   Default: ensure the persistent daemon is up, POST the board, open
      //   the browser, exit. The daemon survives the CLI and hosts every
      //   board the user has published this day at stable URLs.
      //   --no-daemon: legacy single-process server in serve.ts (kept for
      //   tests / Windows / explicit debugging).
      if (flags.serve) {
        if (flags["no-daemon"]) {
          await serve({
            html: outputPath,
            timeout: normalizeIntFlag(flags.timeout, { name: "timeout", def: 600, min: 1 }),
          });
        } else {
          await publishToDaemon({
            html: outputPath,
            title: flags.title as string | undefined,
          });
        }
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
      await runSetup(flags);
      break;

    case "variants":
      process.exitCode = await variants({
        brief: flags.brief as string,
        briefFile: flags["brief-file"] as string,
        briefsFile: flags["briefs-file"] as string,
        // #2032: pass the RAW flag through — variants() normalizes at its
        // consumption site (a pre-parseInt here would silently truncate "3.7").
        count: flags.count,
        outputDir: (flags["output-dir"] as string) || "/tmp/gstack-variants/",
        size: flags.size as string,
        quality: flags.quality as string,
        viewports: flags.viewports as string,
      });
      break;

    case "iterate":
      process.exitCode = await iterate({
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
      process.exitCode = await evolve({
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
      if (flags["no-daemon"]) {
        await serve({
          html: flags.html as string,
          timeout: flags.timeout ? parseInt(flags.timeout as string) : 600,
        });
      } else {
        await publishToDaemon({
          html: flags.html as string,
          title: flags.title as string | undefined,
        });
      }
      break;

    case "daemon": {
      // Sub-commands: `$D daemon status` and `$D daemon stop [--force]`.
      const sub = positionals[0] || "status";
      if (sub === "status") {
        const s = await daemonStatusClient();
        if (!s.running) {
          console.log(JSON.stringify({ running: false }, null, 2));
          process.exit(0);
        }
        console.log(JSON.stringify(s, null, 2));
        break;
      }
      if (sub === "stop") {
        const r = await shutdownDaemon({ force: !!flags.force });
        if (r.stopped) {
          console.log(JSON.stringify({ stopped: true, reason: r.reason }, null, 2));
          process.exit(0);
        }
        console.error(
          `Refused to stop daemon: ${r.reason} (activeBoards=${r.activeBoards ?? 0})`,
        );
        console.error(
          `Submit/close active boards first, or pass --force to drop in-memory history.`,
        );
        process.exit(1);
      }
      console.error(`Unknown daemon sub-command: ${sub}. Use 'status' or 'stop'.`);
      process.exit(2);
    }
  }
}

/**
 * Default `$D compare --serve` path: ensure the persistent daemon is up,
 * publish the board, open the browser to its URL, then exit. The daemon
 * survives.
 *
 * Stderr lines (in order):
 *   - "DAEMON_STARTED port=N version=V"  (or "DAEMON_ATTACHED port=N ..."
 *     if a daemon was already running)
 *   - "BOARD_PUBLISHED: http://127.0.0.1:N/boards/<id>/"
 *   - "BOARD_URL: <same url>"  (alias for grep-friendliness)
 *   - "SERVE_STARTED: port=N html=<path>"  (legacy back-compat alias for
 *     any external script that scraped the pre-daemon output — note the
 *     daemon hosts boards under /boards/<id>/, not /, so scripts that
 *     ALSO POSTed /api/reload at the parsed port need to switch to
 *     BOARD_URL + ./api/reload to work end-to-end. Emitting the legacy
 *     line keeps port-only consumers from breaking outright.)
 */
async function publishToDaemon(opts: { html: string; title?: string }): Promise<void> {
  if (!opts.html) {
    console.error("--html is required (compare --serve provides --output as the html)");
    process.exit(1);
  }
  const ensured = await ensureDaemon({});
  console.error(
    `${ensured.spawned ? "DAEMON_STARTED" : "DAEMON_ATTACHED"} port=${ensured.port} version=${ensured.version}`,
  );
  const result = await publishBoard({
    port: ensured.port,
    html: opts.html,
    title: opts.title,
  });
  console.error(`BOARD_PUBLISHED: ${result.url}`);
  console.error(`BOARD_URL: ${result.url}`);
  // Legacy alias so anything still grepping `SERVE_STARTED: port=` gets the
  // port. The full back-compat story requires the caller to ALSO learn the
  // per-board path; see publishToDaemon docstring above.
  console.error(`SERVE_STARTED: port=${ensured.port} html=${opts.html}`);
  console.log(JSON.stringify({ id: result.id, url: result.url, sourceDir: result.sourceDir }, null, 2));
  openBrowser(result.url);
  // Short-lived publisher process exits; daemon keeps serving.
}

/** Open a URL in the default browser. Stays cross-platform with serve.ts. */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") cmd = "open";
  else if (platform === "linux") cmd = "xdg-open";
  else {
    console.error(`Open this URL in your browser: ${url}`);
    return;
  }
  try {
    const child = nodeSpawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    console.error(`Open this URL in your browser: ${url}`);
  }
}

// Self-execution shortcut: when invoked with --daemon-mode, this same
// binary runs as the persistent design daemon instead of the CLI. Keeps
// the production install to a single executable; daemon-client.ts spawns
// `<this binary> --daemon-mode` (or `bun run cli.ts --daemon-mode` in dev)
// rather than relying on a separate daemon.ts file at a known path.
if (process.argv.includes("--daemon-mode")) {
  const { start } = await import("./daemon");
  start();
  // start() binds Bun.serve and registers signal handlers; this branch
  // never falls through to main(). Process stays alive on the bound port.
} else {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
