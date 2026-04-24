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
        "CEO review, eng manager, designer, QA, release engineer — all /commands.",
      "about",
    );
  } else {
    p.note(`Already installed at ${paths.gstackDir}.`, "detected");
  }

  type Mode = "install" | "init" | "uninstall" | "doctor";
  const mode = await p.select<{ value: Mode; label: string; hint?: string }[], Mode>({
    message: "What do you want to do?",
    options: [
      {
        value: "install",
        label: alreadyInstalled ? "Update global install" : "Install globally (on this machine)",
        hint: "~/.claude/skills/gstack",
      },
      {
        value: "init",
        label: "Add to this project (team mode)",
        hint: inRepo ? "teammates auto-update on session start" : "must be inside a git repo",
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
    type UninstallTarget = "global" | "project";
    const target = await p.select<{ value: UninstallTarget; label: string; hint?: string }[], UninstallTarget>({
      message: "Uninstall from where?",
      options: [
        { value: "global", label: "Global (~/.claude/skills/gstack)" },
        {
          value: "project",
          label: "This project only",
          hint: inRepo ? "" : "not in a git repo",
        },
      ],
      initialValue: "global",
    });
    assertValue(target);
    const { uninstall } = await import("./commands/uninstall.js");
    await uninstall({
      project: target === "project",
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
          hint: "block sessions without gstack",
        },
        {
          value: "optional",
          label: "Optional",
          hint: "nudge teammates, don't block",
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
