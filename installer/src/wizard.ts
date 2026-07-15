import * as p from "@clack/prompts";
import { HOSTS, type HostId } from "./lib/hosts.js";
import { detectInstalledHosts } from "./lib/system.js";
import { findGitRoot, resolveInstallPaths, isInstalled } from "./lib/paths.js";
import { installGlobal } from "./commands/install.js";
import { initProject } from "./commands/init.js";

function assertValue<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Aborted.");
    process.exit(0);
  }
}

export async function runWizard(): Promise<void> {
  const paths = resolveInstallPaths();
  const inRepo = findGitRoot(process.cwd()) !== null;
  const alreadyInstalled = isInstalled(paths);
  const detectedHosts = await detectInstalledHosts();

  p.intro("gstack installer");

  if (!alreadyInstalled) {
    p.note(
      "gstack turns Claude Code into a virtual engineering team.\n" +
        "CEO review, eng manager, designer, QA, release engineer — all /commands.\n\n" +
        "Two install modes:\n" +
        "  • Machine install — just for you, manual upgrades\n" +
        "  • Team mode     — machine install + repo config so teammates auto-update",
      "about",
    );
  } else {
    p.note(
      `Already installed at ${paths.gstackDir}.\n\n` +
        "Team mode adds auto-update + repo-level config on top of this install.",
      "detected",
    );
  }

  type Mode = "install" | "init" | "local" | "uninstall" | "doctor";
  const mode = await p.select<{ value: Mode; label: string; hint?: string }[], Mode>({
    message: "What do you want to do?",
    options: [
      {
        value: "install",
        label: alreadyInstalled ? "Update global install" : "Install gstack on this machine",
        hint: "installs to ~/.claude/skills/gstack — just you, manual upgrades",
      },
      {
        value: "init",
        label: "Enable team mode for this repo",
        hint: inRepo
          ? "global install + commits team-sync config to this repo so teammates auto-update"
          : "must be inside a git repo",
      },
      {
        value: "local",
        label: "Install inside this project only (vendored)",
        hint: "installs to <repo>/.claude/skills/gstack — deprecated, prefer team mode",
      },
      { value: "uninstall", label: "Uninstall", hint: "remove gstack" },
      { value: "doctor", label: "Doctor", hint: "diagnose install issues" },
    ],
    initialValue: alreadyInstalled && inRepo ? "init" : "install",
  });
  assertValue(mode);

  if (mode === "doctor") {
    const { doctor } = await import("./commands/doctor.js");
    await doctor({ quiet: false });
    return;
  }

  if (mode === "uninstall") {
    type UninstallTarget = "global" | "project" | "local";
    const target = await p.select<
      { value: UninstallTarget; label: string; hint?: string }[],
      UninstallTarget
    >({
      message: "Uninstall from where?",
      options: [
        { value: "global", label: "Global (~/.claude/skills/gstack)" },
        {
          value: "project",
          label: "Team-mode config in this repo",
          hint: "removes .claude/hooks/check-gstack.sh, settings.json hook, CLAUDE.md block",
        },
        {
          value: "local",
          label: "Project-local (vendored) install",
          hint: "removes <repo>/.claude/skills/gstack",
        },
      ],
      initialValue: "global",
    });
    assertValue(target);
    const { uninstall } = await import("./commands/uninstall.js");
    await uninstall({
      project: target === "project",
      local: target === "local",
      yes: false,
      keepClaudeMd: false,
      quiet: false,
    });
    return;
  }

  const hosts = await selectHosts(detectedHosts);

  type PrefixChoice = "flat" | "prefixed";
  const prefixChoice = await p.select<{ value: PrefixChoice; label: string; hint?: string }[], PrefixChoice>({
    message: "Skill naming",
    options: [
      { value: "flat", label: "Flat: /qa, /review, /ship", hint: "clean, recommended" },
      {
        value: "prefixed",
        label: "Namespaced: /gstack-qa, /gstack-review",
        hint: "use if you run other skill packs",
      },
    ],
    initialValue: "flat",
  });
  assertValue(prefixChoice);

  const writeClaudeMdChoice = await p.confirm({
    message: "Add gstack section to CLAUDE.md?",
    initialValue: true,
  });
  assertValue(writeClaudeMdChoice);

  if (mode === "install") {
    await installGlobal({
      hosts,
      prefix: prefixChoice === "prefixed",
      writeClaudeMd: writeClaudeMdChoice,
      quiet: false,
      reinstall: false,
    });
    p.outro("Done. Open Claude Code and try /office-hours.");
    return;
  }

  if (mode === "local") {
    const confirmLocal = await p.confirm({
      message:
        "Project-only install is deprecated upstream. You give up cross-project auto-update and vendor ~100MB into this project. Continue?",
      initialValue: false,
    });
    assertValue(confirmLocal);
    if (!confirmLocal) {
      p.outro("Aborted. Use `gstack install` (global) or `gstack init` (team mode) instead.");
      return;
    }
    await installGlobal({
      hosts: ["claude"],
      prefix: prefixChoice === "prefixed",
      writeClaudeMd: writeClaudeMdChoice,
      quiet: false,
      reinstall: false,
      local: true,
      projectDir: process.cwd(),
    });
    p.outro("Done. Project-local install complete.");
    return;
  }

  if (mode === "init") {
    if (!inRepo) {
      p.log.error("Not inside a git repository. Run `git init` first.");
      process.exit(1);
    }

    type Tier = "required" | "optional";
    const tier = await p.select<{ value: Tier; label: string; hint?: string }[], Tier>({
      message: "Team mode tier",
      options: [
        {
          value: "required",
          label: "Required",
          hint: "PreToolUse hook blocks Claude Code work until teammate runs gstack install",
        },
        {
          value: "optional",
          label: "Optional",
          hint: "CLAUDE.md nudge only — teammate can ignore",
        },
      ],
      initialValue: "required",
    });
    assertValue(tier);

    const commit = await p.confirm({
      message: 'Commit as "require gstack for AI-assisted work"?',
      initialValue: true,
    });
    assertValue(commit);

    await initProject({
      tier,
      commit,
      quiet: false,
      writeClaudeMd: writeClaudeMdChoice,
      globalArgs: {
        hosts,
        prefix: prefixChoice === "prefixed",
        writeClaudeMd: writeClaudeMdChoice,
        quiet: false,
        reinstall: false,
      },
    });
    p.outro(`Done. Tier: ${tier}.`);
  }
}

async function selectHosts(detected: HostId[]): Promise<HostId[]> {
  const choice = await p.multiselect({
    message: "Which AI coding tools should gstack register with?",
    options: HOSTS.map((h) => ({
      value: h.id,
      label: h.label,
      hint: detected.includes(h.id) ? "detected" : h.description,
    })),
    initialValues: detected.length > 0 ? detected : (["claude"] as HostId[]),
    required: true,
  });
  assertValue(choice);
  return choice as HostId[];
}
