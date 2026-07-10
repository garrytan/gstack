/**
 * gstack design CLI — stateless CLI for AI-powered design generation.
 *
 * Unlike the browse binary (persistent Chromium daemon), the design binary
 * is stateless: each invocation makes API calls and writes files. Session
 * state for multi-turn iteration is a JSON file in /tmp.
 *
 * Flow:
 *   1. Parse command + flags from argv
 *   2. Resolve auth (~/. gstack/openai.json → OPENAI_API_KEY → guided setup)
 *   3. Execute command (API call → write PNG/HTML)
 *   4. Print result JSON to stdout
 */

import { COMMANDS } from "./commands";
import { generate } from "./generate";
import { checkCommand } from "./check";
import { compare } from "./compare";
import { variants } from "./variants";
import { iterate } from "./iterate";
import { resolveApiKey, saveApiKey } from "./auth";
import { extractDesignLanguage, updateDesignMd } from "./memory";
import { diffMockups, verifyAgainstMockup } from "./diff";
import { evolve } from "./evolve";
import { generateDesignToCodePrompt } from "./design-to-code";
import { serve } from "./serve";
import { gallery } from "./gallery";
import {
  daemonStatus as daemonStatusClient,
  ensureDaemon,
  publishBoard,
  shutdownDaemon,
} from "./daemon-client";
import { spawn as nodeSpawn } from "child_process";

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
  console.log("\nAuth: ~/.gstack/openai.json, then OPENAI_API_KEY env var");
  console.log("If OPENAI_API_KEY matches a current-directory .env file, the source is reported before billing.");
  console.log("Setup: $D setup");
}

async function runSetup(): Promise<void> {
  const existing = resolveApiKey();
  if (existing) {
    console.log("Existing API key found. Running smoke test...");
  } else {
    console.log("No API key found. Please enter your OpenAI API key.");
    console.log("Get one at: https://platform.openai.com/api-keys");
    console.log("(Needs image generation permissions)\n");

    // Read from stdin
    process.stdout.write("API key: ");
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const key = new TextDecoder().decode(value).trim();

    if (!key || !key.startsWith("sk-")) {
      console.error("Invalid key. Must start with 'sk-'.");
      process.exit(1);
    }

    saveApiKey(key);
    console.log("Key saved to ~/.gstack/openai.json (0600 permissions).");
  }

  // Smoke test
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
    console.error("Check your API key and organization verification status.");
    process.exit(1);
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
            timeout: flags.timeout ? parseInt(flags.timeout as string) : 600,
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
