import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import { assertPathInside, resolveGstackHome, resolveRuntimePaths, shellQuote } from "./paths.js";
import { readJson } from "./storage.js";
import { setupRuntime } from "./setup.js";
import {
  configGet,
  configSet,
  configSetNetworkChoice,
  parseConfigValue,
  secretSet,
} from "./config.js";
import { discoverProjectIdentity } from "./identity.js";
import {
  beginRun,
  completeRun,
  inspectProject,
  inspectRun,
  markEffectApplied,
  markEffectNotApplied,
  resumeRun,
  runExternalEffect,
  updateRunWorkflow,
} from "./state.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { cleanupRuntime } from "./cleanup.js";
import {
  ContextClient,
  contextStatus,
  readContextKey,
  redactSensitiveText,
  validateContextKey,
} from "./context.js";
import { rollbackUpgrade } from "./upgrade.js";
import { installManagedRuntime, uninstallManagedRuntime } from "./install.js";
import { assertManagedHome, withRuntimeLifecycleLock } from "./managed-home.js";
import { errorWithCode as cliError } from "./errors.js";
import { RUNTIME_VERSION } from "./index.js";

export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? processStdin;
  const stdout = options.stdout ?? processStdout;
  const stderr = options.stderr ?? processStderr;
  const home = resolveGstackHome({ env, cwd, homeDir: options.homeDir });
  const [command, ...args] = argv;

  if (!command || ["help", "--help", "-h"].includes(command)) {
    write(stdout, usage());
    return 0;
  }
  if (["--version", "version", "-v"].includes(command)) {
    write(stdout, `gstack runtime ${RUNTIME_VERSION}\n`);
    return 0;
  }

  try {
    switch (command) {
      case "setup":
        return await setupCommand({ args, home, cwd, stdout });
      case "doctor":
        return await doctorCommand({ args, home, cwd, stdout });
      case "paths":
        return await pathsCommand({ args, home, stdout });
      case "runtime":
        return await runtimeCommand({ args, home, stdout });
      case "config":
        return await configCommand({ args, home, cwd, stdout });
      case "state":
        return await stateCommand({ args, home, cwd, env, stdout, stderr });
      case "context":
        return await contextCommand({ args, home, cwd, env, stdin, stdout, stderr });
      case "cleanup":
        return await cleanupCommand({ args, home, stdout });
      case "upgrade":
        return await upgradeCommand({ args, home, stdout, installOptions: options.installOptions });
      case "uninstall":
        return await uninstallCommand({ args, home, stdout });
      default:
        throw cliError(`Unknown command: ${command}`, "USAGE");
    }
  } catch (error) {
    const json = args.includes("--json");
    const safeMessage = redactSensitiveText(error?.message ?? String(error));
    if (json) {
      write(stderr, `${JSON.stringify({ ok: false, error: error?.code ?? "ERROR", message: safeMessage })}\n`);
    } else {
      write(stderr, `gstack: ${safeMessage}\n`);
    }
    return exitCodeFor(error);
  }
}

async function runtimeCommand({ args, home, stdout }) {
  const [action, relative, ...rest] = args;
  if (action !== "path" || !relative || rest.length > 0) {
    throw cliError("Usage: gstack runtime path <bundle-relative-path>", "USAGE");
  }
  if (relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]+/).some((part) => part === ".." || part === "")) {
    throw cliError("Runtime bundle path must be a safe relative path", "USAGE");
  }
  const paths = resolveRuntimePaths({ home });
  const pointer = await readJson(paths.versionPointer, null);
  const version = pointer?.current;
  if (!version) throw cliError("No active managed runtime; run `gstack upgrade --source <package> --version <version>`", "RUNTIME_NOT_INSTALLED");
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) {
    throw cliError("Managed runtime pointer contains an invalid version", "RUNTIME_POINTER_INVALID");
  }
  const versionRoot = assertPathInside(paths.versions, path.join(paths.versions, version));
  const target = assertPathInside(versionRoot, path.join(versionRoot, relative));
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) throw cliError(`Managed runtime asset is unavailable: ${relative}`, "RUNTIME_ASSET_MISSING");
  write(stdout, `${target}\n`);
  return 0;
}

async function pathsCommand({ args, home, stdout }) {
  rejectUnknown(args, ["--json", "--shell"]);
  if (args.includes("--json") && args.includes("--shell")) {
    throw cliError("Choose either --json or --shell", "USAGE");
  }
  const paths = resolveRuntimePaths({ home });
  const result = {
    GSTACK_STATE_ROOT: paths.home,
    PLAN_ROOT: paths.plans,
    TMP_ROOT: paths.tmp,
  };
  if (args.includes("--shell")) {
    for (const [key, value] of Object.entries(result)) write(stdout, `${key}=${shellQuote(value)}\n`);
  } else {
    write(stdout, `${JSON.stringify(result, null, 2)}\n`);
  }
  return 0;
}

async function setupCommand({ args, home, cwd, stdout }) {
  rejectUnknown(args, []);
  const result = await setupRuntime({ home, cwd });
  write(stdout, `gstack is ready\nhome: ${result.paths.home}\nproject: ${result.identity.projectId}\nnetwork: off\nContext.dev key setup: https://www.context.dev/auth.md\n`);
  return 0;
}

async function doctorCommand({ args, home, cwd, stdout }) {
  rejectUnknown(args, ["--json"]);
  const report = await runDoctor({ home, cwd });
  write(stdout, args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
  return report.ok ? 0 : 1;
}

async function configCommand({ args, home, cwd, stdout }) {
  const [action, ...tail] = args;
  if (action === "get") {
    const key = tail.find((arg) => !arg.startsWith("--"));
    rejectUnknown(tail.filter((arg) => arg !== key), ["--json"]);
    const result = await configGet(home, key);
    if (result === undefined) throw cliError(`Config key not found: ${key}`, "CONFIG_KEY_NOT_FOUND");
    write(stdout, `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (action === "set") {
    const [key, value, ...rest] = tail;
    if (!key || value === undefined || rest.length) throw cliError("Usage: gstack config set <key> <value>", "USAGE");
    await setupRuntime({ home, cwd });
    const result = await withOwnedRuntimeMutation(home, () => configSet(home, key, parseConfigValue(value)));
    write(stdout, `${key} = ${typeof result === "string" ? result : JSON.stringify(result)}\n`);
    return 0;
  }
  throw cliError("Usage: gstack config get [key] | gstack config set <key> <value>", "USAGE");
}

async function stateCommand({ args, home, cwd, env, stdout, stderr }) {
  const [action, ...rest] = args;
  const identity = await discoverProjectIdentity(cwd);
  if (action === "inspect") {
    const parsed = parseStateArguments(rest, { flags: ["--json"] });
    if (parsed.positionals.length > 1) throw cliError("Usage: gstack state inspect [run-id] [--json]", "USAGE");
    const runId = parsed.positionals[0];
    const result = runId
      ? await inspectRun(home, identity.projectId, runId)
      : await inspectProject(home, identity);
    write(stdout, `${JSON.stringify(runId ? {
      projectId: identity.projectId,
      run: result.run,
      reconstruction: result.reconstruction,
    } : result.state, null, 2)}\n`);
    return 0;
  }
  if (action === "resume") {
    const parsed = parseStateArguments(rest, { flags: ["--json"] });
    if (parsed.positionals.length > 1) throw cliError("Usage: gstack state resume [run-id] [--json]", "USAGE");
    const runId = parsed.positionals[0];
    const result = await withOwnedRuntimeMutation(home, () => resumeRun(home, identity.projectId, runId));
    const output = { projectId: identity.projectId, run: result.run, reconstruction: result.reconstruction };
    write(stdout, `${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  if (action === "begin") {
    const parsed = parseStateArguments(rest, {
      flags: ["--json"],
      values: ["--run-id", "--goal", "--plan", "--stage", "--depth", "--mutation", "--modules"],
    });
    if (parsed.positionals.length !== 1) {
      throw cliError("Usage: gstack state begin <workflow> [metadata options] [--json]", "USAGE");
    }
    const [workflow] = parsed.positionals;
    const options = {
      runId: parsed.values.get("--run-id"),
      originalGoal: parsed.values.get("--goal"),
      currentPlanPointer: parsed.values.get("--plan"),
      currentWorkflowStage: parsed.values.get("--stage"),
      selectedDepth: parsed.values.get("--depth"),
      mutationAuthority: parsed.values.get("--mutation"),
      activeModules: parsed.values.has("--modules") ? parseModuleList(parsed.values.get("--modules")) : undefined,
    };
    await setupRuntime({ home, cwd });
    const result = await withOwnedRuntimeMutation(home, () => beginRun(home, identity.projectId, workflow, options));
    const output = { projectId: identity.projectId, run: result.run, reconstruction: result.reconstruction };
    write(stdout, parsed.flags.has("--json") ? `${JSON.stringify(output, null, 2)}\n` : `${result.run.id}\n`);
    return 0;
  }
  if (action === "update") {
    const parsed = parseStateArguments(rest, {
      flags: ["--json", "--clear-plan", "--pop-detour"],
      values: [
        "--plan", "--stage", "--depth", "--mutation", "--modules", "--push-detour",
        "--evidence-freshness", "--evidence-source", "--evidence-reference", "--evidence-captured-at",
        "--add-approval", "--approval-summary", "--resolve-approval",
      ],
    });
    if (parsed.positionals.length !== 1) {
      throw cliError("Usage: gstack state update <run-id> [workflow transition options] [--json]", "USAGE");
    }
    if (parsed.flags.has("--clear-plan") && parsed.values.has("--plan")) {
      throw cliError("Choose either --plan or --clear-plan", "USAGE");
    }
    const transition = {};
    if (parsed.values.has("--plan")) transition.currentPlanPointer = parsed.values.get("--plan");
    if (parsed.flags.has("--clear-plan")) transition.currentPlanPointer = null;
    if (parsed.values.has("--stage")) transition.currentWorkflowStage = parsed.values.get("--stage");
    if (parsed.values.has("--depth")) transition.selectedDepth = parsed.values.get("--depth");
    if (parsed.values.has("--mutation")) transition.mutationAuthority = parsed.values.get("--mutation");
    if (parsed.values.has("--modules")) transition.activeModules = parseModuleList(parsed.values.get("--modules"));
    if (parsed.values.has("--push-detour")) transition.pushDetour = parsed.values.get("--push-detour");
    if (parsed.flags.has("--pop-detour")) transition.popDetour = true;
    if (parsed.values.has("--evidence-freshness")) {
      transition.evidenceFreshness = parsed.values.get("--evidence-freshness");
    }
    const evidenceFields = ["--evidence-source", "--evidence-reference", "--evidence-captured-at"];
    const hasEvidence = evidenceFields.some((flag) => parsed.values.has(flag));
    if (hasEvidence) {
      if (!parsed.values.has("--evidence-source") || !parsed.values.has("--evidence-reference")) {
        throw cliError("Evidence provenance requires --evidence-source and --evidence-reference", "USAGE");
      }
      transition.addEvidenceProvenance = {
        source: parsed.values.get("--evidence-source"),
        reference: parsed.values.get("--evidence-reference"),
        capturedAt: parsed.values.get("--evidence-captured-at"),
      };
      if (transition.addEvidenceProvenance.capturedAt === undefined) {
        delete transition.addEvidenceProvenance.capturedAt;
      }
    }
    if (parsed.values.has("--approval-summary") && !parsed.values.has("--add-approval")) {
      throw cliError("--approval-summary requires --add-approval", "USAGE");
    }
    if (parsed.values.has("--add-approval")) {
      const summary = parsed.values.get("--approval-summary");
      if (!summary) throw cliError("--add-approval requires --approval-summary", "USAGE");
      transition.addApprovalGate = { id: parsed.values.get("--add-approval"), summary };
    }
    if (parsed.values.has("--resolve-approval")) {
      transition.resolveApprovalGate = parsed.values.get("--resolve-approval");
    }
    const [runId] = parsed.positionals;
    const result = await withOwnedRuntimeMutation(home, () =>
      updateRunWorkflow(home, identity.projectId, runId, transition));
    write(stdout, `${JSON.stringify({
      projectId: identity.projectId,
      run: result.run,
      reconstruction: result.reconstruction,
    }, null, 2)}\n`);
    return 0;
  }
  if (action === "effect") {
    const delimiter = rest.indexOf("--");
    if (delimiter !== 2 || rest.length < 4) {
      throw cliError("Usage: gstack state effect <run-id> <effect-key> -- <executable> [args...]", "USAGE");
    }
    const [runId, effectKey] = rest;
    const command = rest.slice(delimiter + 1);
    const result = await withOwnedRuntimeMutation(home, () => runExternalEffect(home, identity.projectId, runId, effectKey, async ({ idempotencyKey }) =>
      runExternalCommand(command, {
        cwd,
        env: { ...env, GSTACK_IDEMPOTENCY_KEY: idempotencyKey },
        stdout,
        stderr,
      })));
    if (result.status === "uncertain") {
      throw cliError(
        `External effect ${effectKey} was already claimed. Inspect the external system, then reconcile explicitly; it was not repeated.`,
        "EXTERNAL_EFFECT_UNCERTAIN",
      );
    }
    write(stdout, `${JSON.stringify({ status: result.status, effectKey, idempotencyKey: result.idempotencyKey ?? null, result: result.result })}\n`);
    return 0;
  }
  if (action === "reconcile-not-applied") {
    const [runId, effectKey, confirmation, ...tail] = rest;
    if (!runId || !effectKey || confirmation !== "--confirm-not-applied" || tail.length) {
      throw cliError("Usage: gstack state reconcile-not-applied <run-id> <effect-key> --confirm-not-applied", "USAGE");
    }
    const result = await withOwnedRuntimeMutation(home, () => markEffectNotApplied(home, identity.projectId, runId, effectKey));
    write(stdout, `${JSON.stringify(result.result)}\n`);
    return 0;
  }
  if (action === "reconcile-applied") {
    const [runId, effectKey, confirmation, evidenceFlag, evidence, ...tail] = rest;
    if (!runId || !effectKey || confirmation !== "--confirm-applied" || evidenceFlag !== "--evidence" || !evidence || tail.length) {
      throw cliError("Usage: gstack state reconcile-applied <run-id> <effect-key> --confirm-applied --evidence <reference>", "USAGE");
    }
    const result = await withOwnedRuntimeMutation(home, () => markEffectApplied(home, identity.projectId, runId, effectKey, evidence));
    write(stdout, `${JSON.stringify(result.result)}\n`);
    return 0;
  }
  if (action === "complete") {
    const [runId, ...tail] = rest;
    if (!runId || tail.length) throw cliError("Usage: gstack state complete <run-id>", "USAGE");
    const result = await withOwnedRuntimeMutation(home, () => completeRun(home, identity.projectId, runId));
    write(stdout, `${JSON.stringify({ projectId: identity.projectId, run: result.run })}\n`);
    return 0;
  }
  throw cliError("Usage: gstack state inspect|begin|update|effect|resume|reconcile-applied|reconcile-not-applied|complete", "USAGE");
}

async function runExternalCommand(command, { cwd, env, stdout, stderr }) {
  const [executable, ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => write(stdout, chunk));
    child.stderr?.on("data", (chunk) => write(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ exitCode: 0, executable: path.basename(executable) });
        return;
      }
      const error = cliError(
        `External command ${path.basename(executable)} ${signal ? `ended by ${signal}` : `exited ${code}`}`,
        "EXTERNAL_COMMAND_FAILED",
      );
      reject(error);
    });
  });
}

async function withOwnedRuntimeMutation(home, callback) {
  return withRuntimeLifecycleLock(home, async () => {
    await assertManagedHome(home);
    return callback();
  });
}

async function contextCommand({ args, home, cwd, env, stdin, stdout, stderr }) {
  const [action, ...rest] = args;
  if (action === "status") {
    rejectUnknown(rest, ["--json"]);
    const status = await contextStatus(home, env);
    if (rest.includes("--json")) write(stdout, `${JSON.stringify(status, null, 2)}\n`);
    else {
      write(stdout, `Context.dev: ${status.contextReady ? "ready" : "not ready"}\nkey: ${status.configured ? `configured (${status.keySource})` : "missing"}\nweb context: ${status.selection ?? "not selected"}\nconsent: ${status.consent ? "yes" : "no"}\n`);
    }
    return status.ready ? 0 : 1;
  }
  if (action === "options") {
    rejectUnknown(rest, []);
    write(stdout, "GStack needs public web context.\n\nA) Set up Context.dev free (recommended)\nB) Use this host's built-in public web search, if available\nC) Use GStack's local browser\nD) Continue without web research\n\nNo URL or credential is sent until Context.dev is explicitly selected and consented.\n");
    return 0;
  }
  if (action === "select") {
    const [choice, ...tail] = rest;
    rejectUnknown(tail, []);
    const modes = { host: "host", browser: "local-browser", "local-browser": "local-browser", none: "off", off: "off" };
    const mode = modes[choice];
    if (!mode) throw cliError("Usage: gstack context select host|local-browser|none", "USAGE");
    await setupRuntime({ home, cwd });
    await withOwnedRuntimeMutation(home, () => configSetNetworkChoice(home, {
        mode,
        consent: false,
        selection: mode === "off" ? "none" : mode,
      }));
    write(stdout, `Web context mode set to ${mode}; Context.dev network export remains off.\n`);
    return 0;
  }
  if (action === "setup") {
    if (rest.some((arg) => /key|token|secret/i.test(arg) || /^ctxt_secret_/i.test(arg))) {
      throw cliError("API keys must be supplied through hidden stdin or CONTEXT_DEV_API_KEY, never argv", "KEY_ON_COMMAND_LINE");
    }
    rejectUnknown(rest, ["--consent"]);
    await setupRuntime({ home, cwd });
    let consent = rest.includes("--consent");
    if (!consent) {
      if (!stdin.isTTY) {
        throw cliError("Explicit consent is required; rerun with --consent when piping a key", "CONSENT_REQUIRED");
      }
      const answer = await askLine(stdin, stderr,
        "Enable Context.dev network requests? This may consume API credits. Type yes to continue: ");
      consent = answer.trim().toLowerCase() === "yes";
    }
    if (!consent) throw cliError("Context.dev setup cancelled; network remains off", "CONSENT_REQUIRED");

    let key;
    try {
      key = (await readContextKey({ home, env })).key;
    } catch (error) {
      if (error?.code !== "CONTEXT_KEY_MISSING") throw error;
      key = stdin.isTTY
        ? await readHidden(stdin, stderr, "Context.dev API key: ")
        : (await readStream(stdin)).trim();
    }
    validateContextKey(key);
    await withOwnedRuntimeMutation(home, async () => {
      await secretSet(home, "context.apiKey", key);
      await configSetNetworkChoice(home, {
        mode: "context",
        consent: true,
        selection: "context",
      });
    });
    write(stdout, "Context.dev configured. The key is stored privately; network mode is context.\nKey source: https://www.context.dev/auth.md\n");
    return 0;
  }
  if (action === "smoke") {
    const parsed = parseFlags(rest, new Set(["--url", "--json"]));
    const url = parsed.values.get("--url") ?? "https://www.context.dev";
    const client = new ContextClient({ home, env });
    const response = await client.scrapeMarkdown(url, { useMainContentOnly: true, maxAgeMs: 86_400_000 });
    const result = {
      ok: true,
      endpoint: "/web/scrape/markdown",
      url,
      creditsRemaining: response.key_metadata?.credits_remaining ?? null,
    };
    write(stdout, parsed.flags.has("--json") ? `${JSON.stringify(result, null, 2)}\n` :
      `Context.dev smoke test passed for ${url}${result.creditsRemaining == null ? "" : ` (${result.creditsRemaining} credits remaining)`}\n`);
    return 0;
  }
  throw cliError("Usage: gstack context status|options|select|setup|smoke", "USAGE");
}

async function cleanupCommand({ args, home, stdout }) {
  const parsed = parseFlags(args, new Set(["--dry-run", "--older-than-hours", "--json"]));
  const hoursRaw = parsed.values.get("--older-than-hours");
  const hours = hoursRaw == null ? 24 : Number(hoursRaw);
  if (!Number.isFinite(hours) || hours < 0) throw cliError("--older-than-hours must be a non-negative number", "USAGE");
  const result = await cleanupRuntime(home, {
    dryRun: parsed.flags.has("--dry-run"),
    olderThanMs: hours * 60 * 60 * 1000,
  });
  if (parsed.flags.has("--json")) write(stdout, `${JSON.stringify(result, null, 2)}\n`);
  else write(stdout, `${result.dryRun ? "Would remove" : "Removed"} ${result.removed.length} stale item(s), ${result.bytesReclaimed} byte(s)\n`);
  return 0;
}

async function upgradeCommand({ args, home, stdout, installOptions = {} }) {
  const parsed = parseFlags(args, new Set(["--source", "--version", "--rollback", "--json"]));
  if (parsed.flags.has("--rollback")) {
    if (parsed.values.has("--source") || parsed.values.has("--version")) throw cliError("--rollback cannot be combined with staging options", "USAGE");
    const pointer = await rollbackUpgrade(home);
    write(stdout, parsed.flags.has("--json") ? `${JSON.stringify(pointer, null, 2)}\n` : `Rolled back to ${pointer.current}\n`);
    return 0;
  }
  const sourceDir = parsed.values.get("--source");
  const version = parsed.values.get("--version");
  if (!sourceDir || !version) {
    throw cliError("Usage: gstack upgrade --source <complete-gstack-package> --version <version> | --rollback", "USAGE");
  }
  const result = await installManagedRuntime({
    home,
    sourceDir,
    version,
    ...installOptions,
    buildMissing: false,
    rejectSourceRootLink: true,
    requirePackageIdentity: true,
  });
  write(stdout, parsed.flags.has("--json") ? `${JSON.stringify(result, null, 2)}\n` : `Activated ${result.pointer.current}\n`);
  return 0;
}

async function uninstallCommand({ args, home, stdout }) {
  rejectUnknown(args, ["--purge", "--yes", "--json"]);
  const purge = args.includes("--purge");
  if (purge && !args.includes("--yes")) {
    throw cliError("Purging config, secrets, and project state requires both --purge and --yes", "CONFIRMATION_REQUIRED");
  }
  const result = await uninstallManagedRuntime(home, { purge });
  write(stdout, args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` :
    purge ? `Purged gstack state at ${home}\n` : "Removed managed runtime versions; config and project state were preserved.\n");
  return 0;
}

function parseStateArguments(args, options = {}) {
  const valueFlags = new Set(options.values ?? []);
  const booleanFlags = new Set(options.flags ?? []);
  const values = new Map();
  const flags = new Set();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      if (values.has(arg)) throw cliError(`Duplicate option: ${arg}`, "USAGE");
      const value = args[++index];
      if (value == null || value.startsWith("--")) throw cliError(`${arg} requires a value`, "USAGE");
      values.set(arg, value);
      continue;
    }
    if (booleanFlags.has(arg)) {
      if (flags.has(arg)) throw cliError(`Duplicate option: ${arg}`, "USAGE");
      flags.add(arg);
      continue;
    }
    throw cliError(`Unknown option: ${arg}`, "USAGE");
  }
  return { flags, values, positionals };
}

function parseModuleList(value) {
  if (value === "") return [];
  const modules = value.split(",").map((entry) => entry.trim());
  if (modules.some((entry) => !entry)) throw cliError("--modules must be a comma-separated list", "USAGE");
  return modules;
}

function parseFlags(args, allowed) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg)) throw cliError(`Unknown option: ${arg}`, "USAGE");
    if (["--source", "--version", "--url", "--older-than-hours"].includes(arg)) {
      const value = args[++index];
      if (value == null || value.startsWith("--")) throw cliError(`${arg} requires a value`, "USAGE");
      values.set(arg, value);
    } else flags.add(arg);
  }
  return { flags, values };
}

function rejectUnknown(args, allowed) {
  for (const arg of args) if (!allowed.includes(arg)) throw cliError(`Unknown option: ${arg}`, "USAGE");
}

async function askLine(input, output, prompt) {
  const interface_ = readline.createInterface({ input, output, terminal: true });
  try {
    return await interface_.question(prompt);
  } finally {
    interface_.close();
  }
}

async function readHidden(input, output, prompt) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return (await readStream(input)).trim();
  write(output, prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      write(output, "\n");
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(cliError("Context.dev setup cancelled", "CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}

async function readStream(stream) {
  let value = "";
  for await (const chunk of stream) value += chunk.toString("utf8");
  return value;
}

function write(stream, value) {
  stream.write(value);
}

function exitCodeFor(error) {
  if (error?.code === "USAGE") return 2;
  if (["CONTEXT_KEY_MISSING", "CONTEXT_KEY_INVALID", "CONTEXT_EMAIL_UNVERIFIED", "CONTEXT_CREDITS_EXHAUSTED", "CONTEXT_RATE_LIMITED", "CONTEXT_TIMEOUT", "CONTEXT_BLOCKED", "CONTEXT_BAD_RESPONSE"].includes(error?.code)) return 3;
  return 1;
}

function usage() {
  return `gstack ${RUNTIME_VERSION}\n\n` +
    "Usage:\n" +
    "  gstack setup\n" +
    "  gstack doctor [--json]\n" +
    "  gstack paths [--json|--shell]\n" +
    "  gstack runtime path <bundle-relative-path>\n" +
    "  gstack config get [key]\n" +
    "  gstack config set <key> <value>\n" +
    "  gstack state inspect [run-id]\n" +
    "  gstack state begin <workflow> [--run-id <id>] [--goal <goal>] [--plan <pointer>] [--stage <stage>] [--depth quick|standard|deep] [--mutation <authority>] [--modules <a,b>]\n" +
    "  gstack state update <run-id> [--plan <pointer>|--clear-plan] [--stage <stage>] [--depth quick|standard|deep] [--mutation <authority>] [--modules <a,b>] [--push-detour <goal>|--pop-detour]\n" +
    "      [--evidence-freshness unknown|fresh|stale] [--evidence-source <source> --evidence-reference <reference> [--evidence-captured-at <ISO>]]\n" +
    "      [--add-approval <id> --approval-summary <summary>|--resolve-approval <id>]\n" +
    "  gstack state effect <run-id> <effect-key> -- <executable> [args...]\n" +
    "  gstack state resume [run-id]\n" +
    "  gstack state reconcile-applied <run-id> <effect-key> --confirm-applied --evidence <reference>\n" +
    "  gstack state reconcile-not-applied <run-id> <effect-key> --confirm-not-applied\n" +
    "  gstack state complete <run-id>\n" +
    "  gstack context status\n" +
    "  gstack context options\n" +
    "  gstack context select host|local-browser|none\n" +
    "  gstack context setup [--consent]   # key from hidden stdin or env\n" +
    "  gstack context smoke [--url <public-url>]\n" +
    "  gstack cleanup [--dry-run] [--older-than-hours N]\n" +
    "  gstack upgrade --source <complete-gstack-package> --version <version> | --rollback\n" +
    "  gstack uninstall [--purge --yes]\n";
}
