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
import fs from "fs";
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

async function main(argv = process.argv): Promise<void> {
  const { command, flags, positionals } = parseArgs(argv);

  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "generate":
      await generateWithRoundArtifacts({
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
      await iterateWithRoundArtifacts({
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

const ROUND_MANIFEST = ".gstack-design-rounds.json";
const ROUND_MANIFEST_LOCK = ".gstack-design-rounds.lock";
const ROUND_RESERVATION_LIMIT = 1000;

interface RoundAttempt {
  label: string;
  path: string;
  success: boolean;
  error?: string;
  reserved?: boolean;
}

type RoundManifest = Record<string, RoundAttempt[]>;

interface RoundArtifactPlan {
  aliasOutput: string;
  primaryOutput: string;
  roundKey: string;
  label: string;
}

function roundBaseName(outputPath: string): string | null {
  const parsed = path.parse(outputPath);
  if (parsed.ext !== ".png") return null;
  if (parsed.name === "variant-recommended") return parsed.name;
  if (/^variant-iteration-\d+$/.test(parsed.name)) return parsed.name;
  return null;
}

function labelForIndex(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < alphabet.length) return alphabet[index];
  return `${index + 1}`;
}

function roundKey(outputPath: string, baseName: string): string {
  return path.join(path.dirname(outputPath), baseName);
}

function readRoundManifest(dir: string): RoundManifest {
  const manifestPath = path.join(dir, ROUND_MANIFEST);
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as RoundManifest;
  } catch {
    return {};
  }
}

function writeRoundManifest(dir: string, manifest: RoundManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, ROUND_MANIFEST);
  const tempPath = path.join(dir, `${ROUND_MANIFEST}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tempPath, manifestPath);
}

function withRoundManifestLock<T>(dir: string, action: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, ROUND_MANIFEST_LOCK);
  let lockFd: number | undefined;

  for (let attempt = 0; attempt < ROUND_RESERVATION_LIMIT; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, "wx");
      break;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }

  if (lockFd === undefined) {
    throw new Error(`Timed out reserving design round artifacts in ${dir}`);
  }

  try {
    return action();
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lockPath);
  }
}

function planRoundArtifacts(outputPath: string): RoundArtifactPlan | null {
  const baseName = roundBaseName(outputPath);
  if (!baseName) return null;

  const dir = path.dirname(outputPath);
  const key = roundKey(outputPath, baseName);
  return withRoundManifestLock(dir, () => {
    const manifest = readRoundManifest(dir);
    const attempts = manifest[key] || [];

    for (let index = attempts.length; index < attempts.length + ROUND_RESERVATION_LIMIT; index++) {
      const label = labelForIndex(index);
      const primaryOutput = path.join(dir, `${baseName}-${label}.png`);
      try {
        fs.closeSync(fs.openSync(primaryOutput, "wx"));
      } catch (err: any) {
        if (err.code === "EEXIST") continue;
        throw err;
      }

      attempts.push({ label, path: primaryOutput, success: false, reserved: true });
      manifest[key] = attempts;
      writeRoundManifest(dir, manifest);
      return { aliasOutput: outputPath, primaryOutput, roundKey: key, label };
    }

    throw new Error(`Unable to reserve a design round artifact after ${ROUND_RESERVATION_LIMIT} attempts`);
  });
}

function recordRoundAttempt(plan: RoundArtifactPlan, success: boolean, error?: string): void {
  const dir = path.dirname(plan.aliasOutput);
  withRoundManifestLock(dir, () => {
    const manifest = readRoundManifest(dir);
    const attempts = manifest[plan.roundKey] || [];
    const existing = attempts.find(attempt => attempt.label === plan.label);
    const attempt = { label: plan.label, path: plan.primaryOutput, success, error };
    if (existing) {
      Object.assign(existing, attempt);
    } else {
      attempts.push(attempt);
    }
    manifest[plan.roundKey] = attempts;
    writeRoundManifest(dir, manifest);

    if (!success && fs.existsSync(plan.primaryOutput) && fs.statSync(plan.primaryOutput).size === 0) {
      fs.unlinkSync(plan.primaryOutput);
    }
  });
}

function copyRoundAlias(plan: RoundArtifactPlan): void {
  if (plan.primaryOutput === plan.aliasOutput) return;
  fs.copyFileSync(plan.primaryOutput, plan.aliasOutput);
}

async function generateWithRoundArtifacts(options: Parameters<typeof generate>[0]): Promise<void> {
  const plan = planRoundArtifacts(options.output);
  if (!plan) {
    await generate(options);
    return;
  }

  try {
    await generate({ ...options, output: plan.primaryOutput });
    recordRoundAttempt(plan, true);
    copyRoundAlias(plan);
  } catch (err: any) {
    recordRoundAttempt(plan, false, err.message || String(err));
    throw err;
  }
}

async function iterateWithRoundArtifacts(options: Parameters<typeof iterate>[0]): Promise<void> {
  const plan = planRoundArtifacts(options.output);
  if (!plan) {
    await iterate(options);
    return;
  }

  try {
    await iterate({ ...options, output: plan.primaryOutput });
    recordRoundAttempt(plan, true);
    copyRoundAlias(plan);
  } catch (err: any) {
    recordRoundAttempt(plan, false, err.message || String(err));
    throw err;
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
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const imagePath of input.split(",").map(p => p.trim()).filter(Boolean)) {
    const roundImages = resolveRoundImageAlias(imagePath);
    if (roundImages) {
      resolved.push(...roundImages.paths);
      missing.push(...roundImages.missing);
    } else {
      resolved.push(imagePath);
      if (!fs.existsSync(imagePath)) missing.push(path.basename(imagePath));
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing generated design variants: ${missing.join(", ")}`);
  }

  return resolved;
}

function resolveRoundImageAlias(imagePath: string): { paths: string[]; missing: string[] } | null {
  const baseName = roundBaseName(imagePath);
  if (!baseName) return null;

  const dir = path.dirname(imagePath);
  const manifest = readRoundManifest(dir);
  const attempts = manifest[roundKey(imagePath, baseName)] || [];

  if (attempts.length > 0) {
    return {
      paths: attempts.filter(attempt => attempt.success && fs.existsSync(attempt.path)).map(attempt => attempt.path),
      missing: attempts
        .filter(attempt => !attempt.success || !fs.existsSync(attempt.path))
        .map(attempt => `${baseName}-${attempt.label}.png`),
    };
  }

  const discovered = discoverRoundImages(dir, baseName);
  if (discovered.paths.length > 0 || discovered.missing.length > 0) {
    return discovered;
  }

  if (fs.existsSync(imagePath)) {
    return { paths: [imagePath], missing: [] };
  }

  return { paths: [], missing: [path.basename(imagePath)] };
}

function discoverRoundImages(dir: string, baseName: string): { paths: string[]; missing: string[] } {
  if (!fs.existsSync(dir)) return { paths: [], missing: [] };

  const matches = fs.readdirSync(dir)
    .map(name => {
      const match = name.match(new RegExp(`^${escapeRegExp(baseName)}-([A-Z])\\.png$`));
      return match ? { label: match[1], name } : null;
    })
    .filter((match): match is { label: string; name: string } => match !== null)
    .sort((a, b) => a.label.localeCompare(b.label));

  if (matches.length === 0) return { paths: [], missing: [] };

  const highestIndex = matches[matches.length - 1].label.charCodeAt(0) - 65;
  const byLabel = new Map(matches.map(match => [match.label, match.name]));
  const paths: string[] = [];
  const missing: string[] = [];

  for (let i = 0; i <= highestIndex; i++) {
    const label = labelForIndex(i);
    const name = byLabel.get(label);
    if (name) {
      paths.push(path.join(dir, name));
    } else {
      missing.push(`${baseName}-${label}.png`);
    }
  }

  return { paths, missing };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Self-execution shortcut: when invoked with --daemon-mode, this same
// binary runs as the persistent design daemon instead of the CLI. Keeps
// the production install to a single executable; daemon-client.ts spawns
// `<this binary> --daemon-mode` (or `bun run cli.ts --daemon-mode` in dev)
// rather than relying on a separate daemon.ts file at a known path.
if (import.meta.main && process.argv.includes("--daemon-mode")) {
  const { start } = await import("./daemon");
  start();
  // start() binds Bun.serve and registers signal handlers; this branch
  // never falls through to main(). Process stays alive on the bound port.
} else if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export {
  main,
  resolveImagePaths,
  planRoundArtifacts,
  recordRoundAttempt,
  resolveRoundImageAlias,
};
