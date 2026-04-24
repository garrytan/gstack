#!/usr/bin/env node
import { createRequire } from "node:module";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
import { runWizard } from "./wizard.js";
import { installGlobal } from "./commands/install.js";
import { initProject } from "./commands/init.js";
import { uninstall } from "./commands/uninstall.js";
import { upgrade } from "./commands/upgrade.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { list } from "./commands/list.js";
import { enable, disable } from "./commands/toggle.js";
import { HOSTS, type HostId, hostById } from "./lib/hosts.js";
import { createLogger, colors } from "./lib/logger.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  list: Record<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const list: Record<string, string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let key: string;
      let value: string | undefined;
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i++;
        }
      }
      if (value === undefined) {
        flags[key] = true;
      } else if (key === "host") {
        list.host = list.host ?? [];
        list.host.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        flags[key] = value;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, list };
}

function parseHosts(args: ParsedArgs): HostId[] {
  const raw = args.list.host ?? [];
  const hosts: HostId[] = [];
  for (const r of raw) {
    if (r === "auto") {
      return ["claude"];
    }
    const meta = hostById(r);
    if (!meta) {
      console.error(colors.red(`Unknown host: ${r}`));
      console.error(`Valid: ${HOSTS.map((h) => h.id).join(", ")}`);
      process.exit(2);
    }
    hosts.push(meta.id);
  }
  return hosts;
}

function bool(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

const HELP = `${colors.bold("gstack")} — installer for Garry Tan's gstack skill pack

${colors.bold("Usage:")}
  npx @garrytan/gstack                   interactive wizard
  npx @garrytan/gstack <command> [opts]

${colors.bold("Commands:")}
  install        Install gstack globally (~/.claude/skills/gstack)
  init           Add gstack to the current project (team mode)
  uninstall      Remove gstack (global; add --project for just this repo)
  upgrade        Pull latest gstack and rebuild
  doctor         Diagnose install issues
  status         Show install version, hosts, and settings
  list           List available skills
  enable <name>  Enable a skill in the current project
  disable <name> Disable a skill in the current project

${colors.bold("Common options:")}
  --host <id>    Register with host (repeatable, comma-separated).
                 Valid: ${HOSTS.map((h) => h.id).join(", ")}
  --prefix       Use gstack-* skill names
  --no-prefix    Use flat skill names (default)
  --no-claude-md Don't write gstack section to CLAUDE.md
  --yes, -y      Skip confirmation prompts
  --reinstall    Remove existing install before installing
  --quiet, -q    Suppress non-essential output
  --tier <t>     init only: "required" or "optional" (default: required)
  --no-commit    init only: stage but don't commit changes
  --project      uninstall only: remove from current project, not global
  --keep-claude-md  uninstall only: leave CLAUDE.md section in place

${colors.bold("Examples:")}
  npx @garrytan/gstack install --host claude,codex
  npx @garrytan/gstack init --tier optional
  npx @garrytan/gstack uninstall --project --yes
  npx @garrytan/gstack doctor
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const quiet = bool(args, "quiet", bool(args, "q", false));

  if (args.flags.version || args.flags.v) {
    console.log(getVersion());
    return;
  }
  if (args.flags.help || args.flags.h) {
    console.log(HELP);
    return;
  }

  const cmd = args.positional[0];

  if (!cmd) {
    await runWizard();
    return;
  }

  const hosts = parseHosts(args);
  const prefix = args.flags.prefix === true ? true : args.flags["no-prefix"] === true ? false : false;
  const writeClaudeMd = !bool(args, "no-claude-md", false);
  const yes = bool(args, "yes", bool(args, "y", false));
  const reinstall = bool(args, "reinstall", false);

  switch (cmd) {
    case "install":
      await installGlobal({
        hosts: hosts.length > 0 ? hosts : (["claude"] as HostId[]),
        prefix,
        writeClaudeMd,
        quiet,
        reinstall,
      });
      break;
    case "init": {
      const tierFlag = typeof args.flags.tier === "string" ? args.flags.tier : "required";
      if (tierFlag !== "required" && tierFlag !== "optional") {
        console.error(colors.red(`Invalid --tier: ${tierFlag} (expected "required" or "optional")`));
        process.exit(2);
      }
      await initProject({
        tier: tierFlag,
        commit: !bool(args, "no-commit", false),
        quiet,
        writeClaudeMd,
        globalArgs: {
          hosts: hosts.length > 0 ? hosts : (["claude"] as HostId[]),
          prefix,
          writeClaudeMd,
          quiet,
          reinstall,
        },
      });
      break;
    }
    case "uninstall":
      await uninstall({
        project: bool(args, "project", false),
        yes,
        keepClaudeMd: bool(args, "keep-claude-md", false),
        quiet,
      });
      break;
    case "upgrade":
      await upgrade({ quiet });
      break;
    case "doctor":
      await doctor({ quiet });
      break;
    case "status":
      await status({ quiet });
      break;
    case "list":
      await list({ quiet });
      break;
    case "enable": {
      const name = args.positional[1];
      if (!name) {
        console.error(colors.red("Usage: gstack enable <skill>"));
        process.exit(2);
      }
      await enable({ skillName: name, quiet });
      break;
    }
    case "disable": {
      const name = args.positional[1];
      if (!name) {
        console.error(colors.red("Usage: gstack disable <skill>"));
        process.exit(2);
      }
      await disable({ skillName: name, quiet });
      break;
    }
    default: {
      const log = createLogger(false);
      log.error(`Unknown command: ${cmd}`);
      console.log("");
      console.log(HELP);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  const log = createLogger(false);
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
