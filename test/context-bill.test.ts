/**
 * gstack-context-bill — token bill-of-materials for an installed skills tree.
 *
 * Free tier, no network, no API keys. Covers the STRIPPED port:
 *   - ALWAYS-ON ledger: exact frontmatter byte sums, dead-key flag against
 *     the upstream router-key contract, foreign-host file flag
 *   - EAGER ledger: SKILL.md + forced-read refs from the "for every
 *     invocation" phrase; stripped tiers stay zero/empty (shape preserved)
 *   - the three upstream fixes: (a) root-as-container walking +
 *     node_modules/dotdir exclusion in walkMd, (b) repo-checkout subdir skip
 *     for installed trees, (c) widened ROUTER_KEYS
 *   - token estimate calibration, --json shape, --diff, --budget exit codes
 *   - --exact via injected fetch: envelope subtraction, measurement
 *     replacement, typed failures, egress receipt-before-send + fail-open
 *   - ground truth against THIS repo via test/helpers/skill-census.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { canRevokeWrites } from "./helpers/fs-caps";
import { bunIsolationArgs } from "../lib/bun-isolation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildBill,
  calibrationTable,
  checkBudget,
  contentClass,
  contextBillMain,
  diffBills,
  estimateTokens,
  findSkillDirs,
  measureExactTokens,
  renderBill,
  tokenDisclaimer,
  walkMd,
  ExactModeError,
  TOKEN_DIVISOR,
  TOKEN_DIVISORS,
} from "../lib/context-bill";
import { listReceipts, sha256Hex } from "../lib/egress-receipt";
import { skillCensus } from "./helpers/skill-census";

const ROOT = path.join(import.meta.dir, "..");
const TREE_A = path.join(import.meta.dir, "fixtures", "context-bill", "tree-a");

function markCheckout(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "VERSION"), "1.0.0\n");
  fs.writeFileSync(path.join(dir, "setup"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: gstack\ndescription: g\n---\n# gstack\n");
}

function fileBytes(...segments: string[]): number {
  return fs.statSync(path.join(...segments)).size;
}

/** Frontmatter block bytes, computed independently of the implementation. */
function frontmatterBytes(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  const close = text.indexOf("\n---\n", 3);
  return Buffer.byteLength(text.slice(0, close + 5), "utf8");
}

function capture() {
  let buf = "";
  return {
    stream: { write: (s: string) => ((buf += s), true) } as unknown as NodeJS.WriteStream,
    text: () => buf,
  };
}

describe("always-on ledger", () => {
  const bill = buildBill(TREE_A);

  it("sums per-skill frontmatter bytes exactly", () => {
    const alpha = bill.skills.find((s) => s.name === "alpha")!;
    const beta = bill.skills.find((s) => s.name === "beta")!;
    expect(alpha.frontmatterBytes).toBe(frontmatterBytes(path.join(TREE_A, "alpha", "SKILL.md")));
    expect(beta.frontmatterBytes).toBe(frontmatterBytes(path.join(TREE_A, "beta", "SKILL.md")));
    expect(bill.totals.alwaysOnBytes).toBe(alpha.frontmatterBytes + beta.frontmatterBytes);
  });

  it("flags only keys outside the upstream router contract (fix c: widened ROUTER_KEYS)", () => {
    const alpha = bill.skills.find((s) => s.name === "alpha")!;
    // `triggers` is part of the upstream frontmatter contract now — flagging
    // it was the fork's contract, not this repo's.
    expect(alpha.deadKeys).toEqual(["x-dead-key"]);
    expect(bill.skills.find((s) => s.name === "beta")!.deadKeys).toEqual([]);
  });

  it("upstream contract keys are never dead: name/description/version/allowed-tools/triggers/preamble-tier", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-keys-"));
    fs.mkdirSync(path.join(tmp, "s"));
    fs.writeFileSync(
      path.join(tmp, "s", "SKILL.md"),
      "---\nname: s\ndescription: d\nversion: 1\nallowed-tools: Bash\ntriggers: t\npreamble-tier: 2\n---\n\n# S\n",
    );
    const s = buildBill(tmp).skills[0];
    expect(s.deadKeys).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("flags foreign-host skill-shaped files in scanner scope", () => {
    const beta = bill.skills.find((s) => s.name === "beta")!;
    expect(beta.foreignFiles.map((f) => f.path)).toEqual(["agents.md"]);
    expect(bill.skills.find((s) => s.name === "alpha")!.foreignFiles).toEqual([]);
  });
});

describe("eager ledger", () => {
  const bill = buildBill(TREE_A);
  const alpha = bill.skills.find((s) => s.name === "alpha")!;

  it("eager = SKILL.md + only the forced-read references", () => {
    expect(alpha.forcedRefs.map((r) => r.path)).toEqual([
      "references/CORE.md",
      "references/POLICY.md",
    ]);
    const expected =
      fileBytes(TREE_A, "alpha", "SKILL.md") +
      fileBytes(TREE_A, "alpha", "references", "CORE.md") +
      fileBytes(TREE_A, "alpha", "references", "POLICY.md");
    expect(alpha.eagerBytes).toBe(expected);
  });

  it("a skill with no forced reads bills only its SKILL.md", () => {
    const beta = bill.skills.find((s) => s.name === "beta")!;
    expect(beta.eagerBytes).toBe(fileBytes(TREE_A, "beta", "SKILL.md"));
  });

  it("stripped tiers stay zero/empty but keep their shape (re-adding is additive)", () => {
    // OPTIONAL.md is mandated under a condition and the mode table routes two
    // legacy modules — the fork billed those in CONDITIONAL and LAZY. The
    // stripped port must not bill them anywhere NOR lose the fields.
    expect(alpha.conditionalRefs).toEqual([]);
    expect(alpha.conditionalBytes).toBe(0);
    expect(alpha.transitiveRefs).toEqual([]);
    expect(alpha.transitiveBytes).toBe(0);
    expect(alpha.lazy).toEqual([]);
    expect(alpha.orphans).toEqual([]);
    expect(alpha.fastPath).toBeNull();
    expect(alpha.routeCeiling).toBeNull();
    // With those tiers stripped, per-invocation == eager.
    expect(alpha.perInvocationBytes).toBe(alpha.eagerBytes);
    expect(alpha.perInvocationTokens).toBe(alpha.eagerTokens);
  });
});

describe("upstream fix a: root-as-container + walkMd exclusions", () => {
  it("a root with its own SKILL.md is billed AND walked into (router + children)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-root-"));
    fs.writeFileSync(path.join(tmp, "SKILL.md"), "---\nname: router\ndescription: r\n---\n# Router\n");
    fs.mkdirSync(path.join(tmp, "qa"));
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.md"), "---\nname: qa\ndescription: q\n---\n# QA\n");
    const dirs = findSkillDirs(tmp).map((d) => path.relative(fs.realpathSync(tmp), fs.realpathSync(d)) || ".");
    expect(dirs.sort()).toEqual([".", "qa"]);
    // A NON-root skill dir is still a leaf: nothing nested under qa/ counts.
    fs.mkdirSync(path.join(tmp, "qa", "nested"));
    fs.writeFileSync(path.join(tmp, "qa", "nested", "SKILL.md"), "# not a skill\n");
    expect(findSkillDirs(tmp).length).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("totalMd: a container skill excludes nested child skills' bytes; the grand total sums per-skill with no overlap", () => {
    // Regression pin for the v1.63 double-count: totalMd on a skill dir that
    // CONTAINS other skill dirs (the gstack root wraps the whole tree) used to
    // swallow the children's .md bytes too, so the TOTAL line billed every
    // nested skill twice. Dropping skipNestedSkills from totalMd's walkMdFiles call
    // (lib/context-bill.ts) must fail here.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-nested-total-"));
    fs.writeFileSync(path.join(tmp, "SKILL.md"), "---\nname: parent\ndescription: p\n---\n# Parent\n");
    fs.writeFileSync(path.join(tmp, "NOTES.md"), "n".repeat(1_000));
    // A non-skill subdir (no SKILL.md) still belongs to the parent's total.
    fs.mkdirSync(path.join(tmp, "references"));
    fs.writeFileSync(path.join(tmp, "references", "GUIDE.md"), "g".repeat(2_000));
    // Nested child skill with a LARGE .md — the bytes a revert double-counts.
    fs.mkdirSync(path.join(tmp, "child"));
    fs.writeFileSync(path.join(tmp, "child", "SKILL.md"), "---\nname: child\ndescription: c\n---\n# Child\n");
    fs.writeFileSync(path.join(tmp, "child", "BIG.md"), "x".repeat(50_000));

    const bill = buildBill(tmp);
    const parent = bill.skills.find((s) => s.name !== "child")!;
    const child = bill.skills.find((s) => s.name === "child")!;
    expect(bill.skills).toHaveLength(2);

    const parentOwn =
      fileBytes(tmp, "SKILL.md") + fileBytes(tmp, "NOTES.md") + fileBytes(tmp, "references", "GUIDE.md");
    const childOwn = fileBytes(tmp, "child", "SKILL.md") + fileBytes(tmp, "child", "BIG.md");
    // Parent's total is its OWN files only — the child's 50KB is excluded.
    expect(parent.totalMdBytes).toBe(parentOwn);
    expect(child.totalMdBytes).toBe(childOwn);
    // Grand total = sum of per-skill figures, every byte billed exactly once.
    expect(bill.totals.totalMdBytes).toBe(parentOwn + childOwn);
    expect(bill.totals.totalMdBytes).toBe(parent.totalMdBytes + child.totalMdBytes);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips a git checkout inside or linked from a skill, as it skips the root's gstack/ checkout", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-nested-repo-"));
    fs.mkdirSync(path.join(tmp, "qa", "vendor", "lib", ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(tmp, "qa", "vendor", "lib", "README.md"), "VENDORED ".repeat(500));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-nested-repo-ext-"));
    fs.mkdirSync(path.join(ext, ".git"));
    fs.writeFileSync(path.join(ext, "NOTES.md"), "LINKED-REPO");
    fs.symlinkSync(ext, path.join(tmp, "qa", "linked"));
    const walked = walkMd(path.join(tmp, "qa")).map((f) => path.relative(tmp, f));
    const billed = buildBill(tmp).skills[0].totalMdBytes;
    const skillBytes = fileBytes(tmp, "qa", "SKILL.md");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
    expect(walked).toEqual([path.join("qa", "SKILL.md")]);
    expect(billed).toBe(skillBytes);
  });

  it("walkMd skips node_modules and dot-directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-walk-"));
    fs.writeFileSync(path.join(tmp, "real.md"), "x");
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "README.md"), "y".repeat(5000));
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".git", "notes.md"), "z");
    const files = walkMd(tmp).map((f) => path.basename(f));
    expect(files).toEqual(["real.md"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("upstream fix b: installed-tree layout (repo-checkout subdir skip)", () => {
  it("skips a subdir that is its own repo checkout (gstack/ inside ~/.claude/skills)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-install-"));
    // Flat installed skill dirs.
    for (const name of ["qa", "ship"]) {
      fs.mkdirSync(path.join(tmp, name));
      fs.writeFileSync(path.join(tmp, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`);
    }
    // A full repo checkout dropped into the tree: has .git and its own router
    // SKILL.md plus nested skill sources. None of it is an installed skill.
    fs.mkdirSync(path.join(tmp, "gstack", ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "gstack", "SKILL.md"), "---\nname: _router\ndescription: d\n---\n# router\n");
    fs.mkdirSync(path.join(tmp, "gstack", "review"));
    fs.writeFileSync(path.join(tmp, "gstack", "review", "SKILL.md"), "---\nname: review\ndescription: d\n---\n# r\n");

    const names = buildBill(tmp).skills.map((s) => s.name).sort();
    expect(names).toEqual(["qa", "ship"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("follows a directory symlink to a sibling skill (connect-chrome shape)", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-symlink-"));
    fs.mkdirSync(path.join(tmp, "open-browser"));
    fs.writeFileSync(path.join(tmp, "open-browser", "SKILL.md"), "---\nname: ob\ndescription: d\n---\n# ob\n");
    fs.symlinkSync(path.join(tmp, "open-browser"), path.join(tmp, "connect-chrome"));
    const names = buildBill(tmp).skills.map((s) => s.name).sort();
    // Both entries are real scanner load, so both are billed.
    expect(names).toEqual(["connect-chrome", "open-browser"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("bills an installed tree whose SKILL.md files and section dirs are symlinks into the checkout", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-installed-"));
    // The gstack checkout lives outside the skills root, as on a real install.
    const checkout = path.join(tmp, "checkout");
    markCheckout(checkout);
    for (const name of ["review", "office-hours"]) {
      fs.mkdirSync(path.join(checkout, name, "sections"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n${"body ".repeat(200)}\n`,
      );
      fs.writeFileSync(path.join(checkout, name, "sections", "flow.md"), "s".repeat(3_000));
    }
    // setup's layout: a real dir per skill, SKILL.md and sections/ as links,
    // plus a gstack/ link to the checkout itself.
    const skills = path.join(tmp, "skills");
    for (const name of ["review", "office-hours"]) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.symlinkSync(path.join(checkout, name, "SKILL.md"), path.join(skills, name, "SKILL.md"));
      fs.symlinkSync(path.join(checkout, name, "sections"), path.join(skills, name, "sections"));
    }
    fs.symlinkSync(checkout, path.join(skills, "gstack"));
    // Negative controls: a dangling SKILL.md link and a SKILL.md link to a
    // directory are not skills.
    fs.mkdirSync(path.join(skills, "dangling"));
    fs.symlinkSync(path.join(checkout, "missing", "SKILL.md"), path.join(skills, "dangling", "SKILL.md"));
    fs.mkdirSync(path.join(skills, "dirlink"));
    fs.symlinkSync(path.join(checkout, "review", "sections"), path.join(skills, "dirlink", "SKILL.md"));

    const bill = buildBill(skills);
    expect(bill.skills.map((s) => s.name).sort()).toEqual(["office-hours", "review"]);
    for (const s of bill.skills) {
      const target = path.join(checkout, s.name);
      expect(s.frontmatterBytes).toBe(frontmatterBytes(path.join(target, "SKILL.md")));
      expect(s.skillMdBytes).toBe(fileBytes(target, "SKILL.md"));
      // The linked sections/ dir is part of the skill's on-disk total.
      expect(s.totalMdBytes).toBe(fileBytes(target, "SKILL.md") + fileBytes(target, "sections", "flow.md"));
    }
    // Every path the bill (and --exact) keys on stays under the skills root.
    for (const file of walkMd(skills)) expect(file.startsWith(skills + path.sep)).toBe(true);
    // dirlink/SKILL.md links to review/sections: the one real file is walked
    // once, under the first name reached in sorted order.
    expect(walkMd(skills).map((f) => path.relative(skills, f)).sort()).toEqual([
      path.join("dirlink", "SKILL.md", "flow.md"),
      path.join("office-hours", "SKILL.md"),
      path.join("office-hours", "sections", "flow.md"),
      path.join("review", "SKILL.md"),
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a symlinked foreign-host file, but not a dangling link or a directory with that name", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-foreign-"));
    const checkout = path.join(tmp, "checkout", "qa");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(checkout, "agents.md"), "a".repeat(100));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.symlinkSync(path.join(checkout, "SKILL.md"), path.join(skills, "qa", "SKILL.md"));
    fs.symlinkSync(path.join(checkout, "agents.md"), path.join(skills, "qa", "agents.md"));
    fs.symlinkSync(path.join(tmp, "missing"), path.join(skills, "qa", ".cursorrules"));
    fs.mkdirSync(path.join(skills, "qa", "skill.json"));

    const qa = buildBill(skills).skills.find((s) => s.name === "qa")!;
    expect(qa.foreignFiles.map((f) => [f.path, f.bytes])).toEqual([["agents.md", 100]]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never follows a link that loops or climbs out of the root", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-escape-"));
    // A sibling skill outside the root, reachable only through a parent link.
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.writeFileSync(path.join(tmp, "outside", "SKILL.md"), "---\nname: outside\ndescription: d\n---\n# o\n");
    fs.writeFileSync(path.join(tmp, "outside", "SECRET.md"), "x".repeat(10_000));
    const root = path.join(tmp, "skills");
    fs.mkdirSync(path.join(root, "qa", "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(root, "qa", "references", "guide.md"), "g".repeat(500));
    fs.symlinkSync(root, path.join(root, "self"));
    fs.symlinkSync(tmp, path.join(root, "parent"));
    fs.symlinkSync(path.join(root, "qa"), path.join(root, "qa", "references", "loop"));
    fs.symlinkSync(tmp, path.join(root, "qa", "references", "up"));
    // A loop to a directory below the walk root: only the ancestor guard stops it.
    fs.symlinkSync(path.join(root, "qa", "references"), path.join(root, "qa", "references", "again"));

    expect(findSkillDirs(root).map((d) => path.relative(root, d))).toEqual(["qa"]);
    expect(walkMd(path.join(root, "qa")).map((f) => path.relative(root, f)).sort()).toEqual([
      path.join("qa", "SKILL.md"),
      path.join("qa", "references", "guide.md"),
    ]);
    const bill = buildBill(root);
    expect(bill.totals.totalMdBytes).toBe(fileBytes(root, "qa", "SKILL.md") + fileBytes(root, "qa", "references", "guide.md"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("walks a fan-out of links once per real directory and file", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-fanout-"));
    // L0..L11 sit outside the root; each level holds two links to the next, so
    // a walk that expands every link reaches leaf.md by 2^12 paths.
    const depth = 12;
    for (let d = 0; d <= depth; d++) fs.mkdirSync(path.join(tmp, `L${d}`));
    fs.writeFileSync(path.join(tmp, `L${depth}`, "leaf.md"), "l".repeat(300));
    for (let d = 0; d < depth; d++) {
      for (const name of ["a", "b"]) fs.symlinkSync(path.join(tmp, `L${d + 1}`), path.join(tmp, `L${d}`, name));
    }
    const root = path.join(tmp, "skills");
    fs.mkdirSync(path.join(root, "qa"), { recursive: true });
    fs.writeFileSync(path.join(root, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(tmp, "L0"), path.join(root, "qa", "refs"));

    const leaf = path.join("qa", "refs", ...Array(depth).fill("a"), "leaf.md");
    expect(walkMd(root).map((f) => path.relative(root, f))).toEqual([path.join("qa", "SKILL.md"), leaf]);
    const bill = buildBill(root);
    expect(bill.totals.totalMdBytes).toBe(fileBytes(root, "qa", "SKILL.md") + 300);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a symlinked skill that lives outside the root from climbing to the root's parent", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-fence-"));
    const home = path.join(tmp, "home");
    const root = path.join(home, "skills");
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "SKILL.md"), "---\nname: real\ndescription: d\n---\n# real\n");
    fs.writeFileSync(path.join(home, "private.md"), "p".repeat(1_000));
    const ext = path.join(tmp, "opt", "ext");
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, "SKILL.md"), "---\nname: ext\ndescription: d\n---\n# ext\n");
    fs.symlinkSync(home, path.join(ext, "up"));
    fs.symlinkSync(ext, path.join(root, "ext"));

    const ext_ = buildBill(root).skills.find((s) => s.name === "ext")!;
    expect(ext_.totalMdBytes).toBe(fileBytes(ext, "SKILL.md"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a container skill's own files when a nested skill sorted first links to them", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-container-"));
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: c\ndescription: d\n---\n# c\n");
    fs.mkdirSync(path.join(root, "shared"));
    fs.writeFileSync(path.join(root, "shared", "big.md"), "b".repeat(4_000));
    fs.mkdirSync(path.join(root, "a-skill"));
    fs.writeFileSync(path.join(root, "a-skill", "SKILL.md"), "---\nname: a\ndescription: d\n---\n# a\n");
    fs.symlinkSync(path.join(root, "shared"), path.join(root, "a-skill", "shared"));

    const bill = buildBill(root);
    const container = bill.skills.find((s) => s.name === path.basename(root))!;
    const nested = bill.skills.find((s) => s.name === "a-skill")!;
    expect(container.totalMdBytes).toBe(fileBytes(root, "SKILL.md") + 4_000);
    expect(nested.totalMdBytes).toBe(fileBytes(root, "a-skill", "SKILL.md") + 4_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a root container from billing a nested skill that a deeper directory link reaches", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-container-deep-"));
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: c\ndescription: d\n---\n# c\n");
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "SKILL.md"), "---\nname: s\ndescription: d\n---\n# s\n");
    fs.writeFileSync(path.join(root, "sub", "big.md"), "b".repeat(10_000));
    fs.mkdirSync(path.join(root, "refs"));
    fs.writeFileSync(path.join(root, "refs", "note.md"), "n");
    fs.symlinkSync(path.join(root, "sub"), path.join(root, "refs", "alias"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-container-outside-"));
    fs.mkdirSync(path.join(outside, "deep"));
    fs.writeFileSync(path.join(outside, "deep", "SKILL.md"), "---\nname: o\ndescription: d\n---\n# o\n");
    fs.writeFileSync(path.join(outside, "deep", "o.md"), "o".repeat(5_000));
    fs.mkdirSync(path.join(root, "linked"));
    fs.symlinkSync(outside, path.join(root, "linked", "via"));

    const bill = buildBill(root);
    const byName = Object.fromEntries(bill.skills.map((s) => [s.name, s]));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    expect(Object.keys(byName).sort()).toEqual([path.basename(root), path.join("linked", "via", "deep"), path.join("refs", "alias"), "sub"].sort());
    expect(byName[path.basename(root)].totalMdBytes).toBe("---\nname: c\ndescription: d\n---\n# c\n".length + 1);
    expect(byName[path.join("refs", "alias")].totalMdBytes).toBe(byName.sub.totalMdBytes);
  });

  it("walks a chain of links deeper than the kernel's link limit without losing files", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-deep-chain-"));
    const depth = 50;
    for (let i = 0; i < depth; i++) {
      fs.mkdirSync(path.join(tmp, "levels", `L${i}`), { recursive: true });
      fs.writeFileSync(path.join(tmp, "levels", `L${i}`, `f${i}.md`), "x");
    }
    for (let i = 0; i < depth - 1; i++) {
      fs.symlinkSync(path.join(tmp, "levels", `L${i + 1}`), path.join(tmp, "levels", `L${i}`, "next"));
    }
    const root = path.join(tmp, "skills");
    fs.mkdirSync(path.join(root, "qa"), { recursive: true });
    fs.writeFileSync(path.join(root, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(tmp, "levels", "L0"), path.join(root, "qa", "next"));

    expect(walkMd(path.join(root, "qa")).length).toBe(depth + 1);
    const qa = buildBill(root).skills.find((s) => s.name === "qa")!;
    expect(qa.totalMdBytes).toBe(fileBytes(root, "qa", "SKILL.md") + depth);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("discovers a skill behind a chain of directory links deeper than the kernel's limit", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-deep-skill-"));
    const root = path.join(tmp, "root");
    fs.mkdirSync(root);
    const depth = 45;
    for (let i = 0; i < depth; i++) fs.mkdirSync(path.join(tmp, `d${i}`));
    fs.symlinkSync(path.join(tmp, "d0"), path.join(root, "c0"));
    for (let i = 0; i < depth - 1; i++) fs.symlinkSync(path.join(tmp, `d${i + 1}`), path.join(tmp, `d${i}`, `c${i + 1}`));
    fs.writeFileSync(path.join(tmp, `d${depth - 1}`, "SKILL.md"), "---\nname: deep\ndescription: d\n---\n# deep\n");
    const dirs = findSkillDirs(root);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(dirs.length).toBe(1);
  });

  it("refuses skill discovery past its entry cap instead of walking on", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-discovery-cap-"));
    fs.mkdirSync(path.join(root, "vendor"));
    for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(root, "vendor", `d${i}`));
    expect(() => findSkillDirs(root, 5)).toThrow(/more than 5 entries to walk/);
    expect(findSkillDirs(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bills a subdirectory whose SKILL.md is a directory to its container, as discovery does not count it as a skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-skilldir-"));
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: c\ndescription: d\n---\n# c\n");
    fs.mkdirSync(path.join(root, "sub", "SKILL.md"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "notes.md"), "n".repeat(500));
    const bill = buildBill(root);
    fs.rmSync(root, { recursive: true, force: true });
    expect(bill.skills.map((s) => s.name)).toEqual([path.basename(root)]);
    expect(bill.skills[0].totalMdBytes).toBe(bill.skills[0].skillMdBytes + 500);
  });

  it("refuses a parent link when the root's own name starts with '..'", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-dotdot-"));
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.writeFileSync(path.join(tmp, "outside", "SKILL.md"), "---\nname: outside\ndescription: d\n---\n# o\n");
    const root = path.join(tmp, "..skills");
    fs.mkdirSync(path.join(root, "qa"), { recursive: true });
    fs.writeFileSync(path.join(root, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(tmp, path.join(root, "up"));

    expect(findSkillDirs(root).map((d) => path.relative(root, d))).toEqual(["qa"]);
    expect(walkMd(root).map((f) => path.relative(root, f))).toEqual([path.join("qa", "SKILL.md")]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers ./skills, then .agents/skills, then .claude/skills, project before user", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-detect-"));
    const home = path.join(tmp, "home");
    const proj = path.join(tmp, "proj");
    const plant = (dir: string, name: string) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.cpSync(TREE_A, path.join(dir, name), { recursive: true });
      return path.join(dir, name);
    };
    const homeClaude = plant(home, path.join(".claude", "skills"));
    const homeAgents = plant(home, path.join(".agents", "skills"));
    const projClaude = plant(proj, path.join(".claude", "skills"));
    const projAgents = plant(proj, path.join(".agents", "skills"));

    const run = async () => {
      const out = capture();
      const code = await contextBillMain([], { cwd: proj, homeDir: home, stdout: out.stream, stderr: out.stream });
      expect(code).toBe(0);
      return out.text().split("\n")[0];
    };

    expect(await run()).toContain(projAgents);
    fs.rmSync(projAgents, { recursive: true, force: true });
    expect(await run()).toContain(projClaude);
    fs.rmSync(projClaude, { recursive: true, force: true });
    expect(await run()).toContain(homeAgents);
    fs.rmSync(homeAgents, { recursive: true, force: true });
    expect(await run()).toContain(homeClaude);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names every candidate it tried when no tree exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-none-"));
    const out = capture();
    const code = await contextBillMain([], { cwd: tmp, homeDir: tmp, stdout: out.stream, stderr: out.stream });
    expect(code).toBe(2);
    expect(out.text()).toContain(path.join(tmp, ".agents", "skills"));
    expect(out.text()).toContain(path.join(tmp, ".claude", "skills"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("token estimate calibration", () => {
  it("uses the corpus-wide divisor for path-less callers, rounded", () => {
    expect(estimateTokens(3900)).toBe(1000);
    expect(estimateTokens(TOKEN_DIVISOR * 2)).toBe(2);
  });

  it("charges each content class its own measured divisor", () => {
    expect(contentClass("/x/plan/SKILL.md")).toBe("skillmd");
    expect(contentClass("/x/plan/references/legacy/office.md")).toBe("legacy");
    expect(contentClass("/x/plan/references/RUNTIME.md")).toBe("reference");
    expect(contentClass("/x/plan/references/artifacts/qa/t.md")).toBe("artifact");
    expect(contentClass("/x/plan/SKILL.md#frontmatter")).toBe("frontmatter");
    expect(TOKEN_DIVISORS.legacy).toBeLessThan(TOKEN_DIVISORS.skillmd);
    const alpha = buildBill(TREE_A).skills.find((s) => s.name === "alpha")!;
    expect(alpha.skillMdTokens).toBeCloseTo(alpha.skillMdBytes / TOKEN_DIVISORS.skillmd, 6);
    expect(alpha.forcedRefs[0].tokens).toBeCloseTo(alpha.forcedRefs[0].bytes / TOKEN_DIVISORS.reference, 6);
  });

  it("never claims more precision than it has: no divisor is a measurement", () => {
    const bill = buildBill(TREE_A);
    expect(bill.tokenEstimateErrorPct).toBeGreaterThan(0);
    expect(bill.tokenSource).toContain("estimate");
    expect(bill.calibration).toBeUndefined();
  });

  it("names the measured error band rather than a vague 'estimates'", () => {
    const text = tokenDisclaimer(buildBill(TREE_A));
    expect(text).toContain("ESTIMATES");
    expect(text).toMatch(/worst single file 40%/);
    expect(text).toContain("--exact");
    expect(text).toContain("Bytes are always exact");
    const exactText = tokenDisclaimer({
      tokenEstimateErrorPct: 0,
      tokenSource: "count_tokens (claude-opus-5-5)",
    });
    expect(exactText).toContain("measured with count_tokens");
    expect(exactText).not.toContain("ESTIMATES");
  });
});

describe("rendering", () => {
  it("text output carries the live ledgers plus flags", () => {
    const text = renderBill(buildBill(TREE_A));
    expect(text).toContain("ALWAYS-ON (every session): 2 skills");
    expect(text).toContain("EAGER (per invocation)");
    expect(text).toContain("frontmatter key(s) the router never reads: x-dead-key");
    expect(text).toContain("foreign-host file in scanner scope: agents.md");
    expect(text).toContain("TOTAL on disk:");
    expect(text).toContain("Token source: estimate");
    expect(text).toContain("Token counts are ESTIMATES");
  });

  it("states the always-on row's exclusion of the host's per-skill wrapper", () => {
    const text = renderBill(buildBill(TREE_A));
    const alwaysOn = text.slice(text.indexOf("ALWAYS-ON"), text.indexOf("EAGER ("));
    expect(alwaysOn).toContain("excludes the host's per-skill available_skills XML wrapper");
  });

  it("--json shape is stable (stripped tiers keep their fields)", async () => {
    const out = capture();
    const code = await contextBillMain([TREE_A, "--json"], { stdout: out.stream, stderr: out.stream });
    expect(code).toBe(0);
    const bill = JSON.parse(out.text());
    expect(bill.tokenEstimate).toEqual(TOKEN_DIVISORS);
    expect(bill.tokenEstimateErrorPct).toBe(40);
    expect(Object.keys(bill.totals).sort()).toEqual([
      "alwaysOnBytes",
      "alwaysOnTokens",
      "eagerBytesBySkill",
      "eagerTokensBySkill",
      "perInvocationBytesBySkill",
      "perInvocationTokensBySkill",
      "skillCount",
      "totalMdBytes",
      "totalMdTokens",
    ]);
    const skill = bill.skills[0];
    for (const key of ["name", "frontmatterBytes", "frontmatterTokens", "deadKeys", "skillMdBytes", "skillMdTokens", "forcedRefs", "eagerBytes", "eagerTokens", "fastPath", "conditionalRefs", "conditionalBytes", "conditionalTokens", "transitiveRefs", "transitiveBytes", "transitiveTokens", "perInvocationBytes", "perInvocationTokens", "routeCeiling", "lazy", "orphans", "foreignFiles", "totalMdTokens"]) {
      expect(skill).toHaveProperty(key);
    }
    for (const r of skill.forcedRefs) expect(typeof r.tokens).toBe("number");
  });
});

describe("--diff", () => {
  it("reports exactly the grown row and exits 2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-"));
    const treeB = path.join(tmp, "tree-b");
    fs.cpSync(TREE_A, treeB, { recursive: true });
    fs.appendFileSync(path.join(treeB, "alpha", "SKILL.md"), "x".repeat(43000));

    const diff = diffBills(buildBill(TREE_A), buildBill(treeB));
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]).toMatchObject({ ledger: "eager", label: "alpha", delta: 43000 });
    expect(diff.grew).toBe(true);

    const out = capture();
    const code = await contextBillMain(["--diff", TREE_A, treeB], { stdout: out.stream, stderr: out.stream });
    expect(code).toBe(2);
    expect(out.text()).toContain("eager");
    expect(out.text()).toContain("GREW");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("identical trees diff clean and exit 0", async () => {
    const out = capture();
    const code = await contextBillMain(["--diff", TREE_A, TREE_A], { stdout: out.stream, stderr: out.stream });
    expect(code).toBe(0);
    expect(out.text()).toContain("No context-cost changes");
  });
});

describe("--budget", () => {
  const alphaEagerTok = Math.round(buildBill(TREE_A).skills.find((s) => s.name === "alpha")!.eagerTokens);

  it("exits 0 under budget, 2 over budget with offending files listed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-budget-"));
    const okBudget = path.join(tmp, "ok.json");
    const tightBudget = path.join(tmp, "tight.json");
    fs.writeFileSync(okBudget, JSON.stringify({ alwaysOnTotal: 10000, eagerPerInvocation: { alpha: alphaEagerTok } }));
    fs.writeFileSync(tightBudget, JSON.stringify({ eagerPerInvocation: { alpha: alphaEagerTok - 1 } }));

    const ok = capture();
    expect(await contextBillMain([TREE_A, "--budget", okBudget], { stdout: ok.stream, stderr: ok.stream })).toBe(0);
    expect(ok.text()).toContain("Within budget");

    const over = capture();
    expect(await contextBillMain([TREE_A, "--budget", tightBudget], { stdout: over.stream, stderr: over.stream })).toBe(2);
    expect(over.text()).toContain("OVER BUDGET: eagerPerInvocation.alpha");
    expect(over.text()).toContain("alpha/SKILL.md");
    expect(over.text()).toContain("references/CORE.md");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("perInvocation and routeCeiling keys stay accepted (they gate the eager figure while tiers are stripped)", () => {
    const bill = buildBill(TREE_A);
    expect(checkBudget(bill, { perInvocation: { alpha: alphaEagerTok } })).toEqual([]);
    expect(checkBudget(bill, { perInvocation: { alpha: alphaEagerTok - 1 } })).toHaveLength(1);
    expect(checkBudget(bill, { routeCeiling: { alpha: alphaEagerTok } })).toEqual([]);
  });

  it("checkBudget flags a budgeted skill missing from the tree", () => {
    const violations = checkBudget(buildBill(TREE_A), { eagerPerInvocation: { ghost: 100 } });
    expect(violations).toHaveLength(1);
    expect(violations[0].ceiling).toBe("eagerPerInvocation.ghost");
  });

  // The context-budget ratchet (test/context-budget-ratchet.test.ts) made
  // this branch load-bearing in CI; it previously had only under-budget
  // coverage.
  it("checkBudget flags an alwaysOnTotal violation with every skill's frontmatter listed", () => {
    const bill = buildBill(TREE_A);
    const violations = checkBudget(bill, { alwaysOnTotal: 0 });
    expect(violations).toHaveLength(1);
    expect(violations[0].ceiling).toBe("alwaysOnTotal");
    expect(violations[0].actual).toBe(Math.round(bill.totals.alwaysOnTokens));
    expect(violations[0].files.length).toBe(bill.skills.length);
  });
});

describe("--exact (opt-in measurement; offline here via an injected fetch)", () => {
  let egressHome: string;
  let savedStateRoot: string | undefined;
  beforeAll(() => {
    egressHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-egress-"));
    savedStateRoot = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = path.join(egressHome, "state");
  });
  afterAll(() => {
    if (savedStateRoot === undefined) delete process.env.GSTACK_STATE_ROOT;
    else process.env.GSTACK_STATE_ROOT = savedStateRoot;
    try { fs.chmodSync(path.join(egressHome, "security"), 0o700); } catch {}
    fs.rmSync(egressHome, { recursive: true, force: true });
  });

  const ENVELOPE = 7;
  /** Deterministic stand-in for count_tokens: 1 token per 3 chars, plus envelope. */
  function fakeFetch(calls: { body: string }[] = []) {
    return (async (_url: string, init: { body: string }) => {
      calls.push({ body: init.body });
      const { messages } = JSON.parse(init.body);
      const text: string = messages[0].content;
      return {
        ok: true,
        json: async () => ({ input_tokens: Math.ceil(text.length / 3) + ENVELOPE }),
      };
    }) as never;
  }

  it("writes the egress receipt BEFORE the first count_tokens POST", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-receipt-"));
    let receiptsAtFirstPost = -1;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      if (receiptsAtFirstPost === -1) receiptsAtFirstPost = listReceipts(home).length;
      const { messages } = JSON.parse(init.body);
      return { ok: true, json: async () => ({ input_tokens: Math.ceil(messages[0].content.length / 3) + ENVELOPE }) };
    }) as never;
    await measureExactTokens(TREE_A, { model: "m", apiKey: "sk-test", fetchImpl, egressHome: home });
    expect(receiptsAtFirstPost).toBe(1); // the receipt existed before any POST
    const receipts = listReceipts(home);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sink).toBe("context-bill-exact");
    expect(receipts[0].host).toBe("api.anthropic.com");
    expect(receipts[0].sha256).toBeNull();
    expect(receipts[0].bytes).toBeGreaterThan(0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fail-open: an unwritable ledger degrades --exact to the offline estimate, sending nothing", async () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-refuse-"));
    fs.mkdirSync(path.join(home, "security"), { recursive: true, mode: 0o500 });
    let called = false;
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([TREE_A, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: (() => ((called = true), Promise.reject(new Error("must not send")))) as never,
      egressHome: home,
    });
    expect(code).toBe(0); // the run still answers, with the estimate
    expect(called).toBe(false); // NOTHING was sent unrecorded
    expect(stderr.text()).toContain("exact_egress_receipt_failed");
    expect(stderr.text()).toContain("Falling back to the offline estimate");
    expect(JSON.parse(stdout.text()).tokenSource).toContain("estimate");
    fs.chmodSync(path.join(home, "security"), 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("subtracts the request envelope so small files are not overcharged", async () => {
    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(TREE_A, {
      model: "test-model",
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    expect(measured.tokenSource).toBe("count_tokens (test-model)");
    const core = path.join(TREE_A, "alpha", "references", "CORE.md");
    const text = fs.readFileSync(core, "utf8");
    expect(measured.tokensOf(core, text.length)).toBe(Math.ceil(text.length / 3));
    // One probe call for the envelope, then one per measured text.
    expect(calls.length).toBe(measured.measuredFiles + 1);
  });

  it("measures the frontmatter block, not the whole SKILL.md, for the always-on row", async () => {
    const measured = await measureExactTokens(TREE_A, {
      model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome,
    });
    const skillMd = path.join(TREE_A, "alpha", "SKILL.md");
    const fmTokens = measured.tokensOf(`${skillMd}#frontmatter`, 0);
    const bodyTokens = measured.tokensOf(skillMd, 0);
    expect(fmTokens).toBeGreaterThan(0);
    expect(fmTokens).toBeLessThan(bodyTokens);
  });

  it("exact tokens replace the estimate everywhere the bill prices content", async () => {
    const measured = await measureExactTokens(TREE_A, {
      model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome,
    });
    const bill = buildBill(TREE_A, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    const alpha = bill.skills.find((s) => s.name === "alpha")!;
    expect(alpha.eagerTokens).toBeGreaterThanOrEqual(alpha.eagerBytes / 3);
    expect(alpha.eagerTokens).toBeLessThan(alpha.eagerBytes / 3 + 4);
    expect(alpha.eagerTokens / (alpha.eagerBytes / TOKEN_DIVISOR)).toBeGreaterThan(1.2);
    expect(alpha.eagerTokens).toBe(alpha.skillMdTokens + alpha.forcedRefs.reduce((n, r) => n + r.tokens, 0));
    expect(bill.tokenEstimateErrorPct).toBe(0);
    expect(renderBill(bill)).toContain("Token counts measured with count_tokens");
    expect(renderBill(bill)).not.toMatch(/\(~\d/);
  });

  it("measures against a relative root too, instead of silently estimating", async () => {
    const relative = path.relative(process.cwd(), TREE_A);
    const measured = await measureExactTokens(relative, {
      model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome,
    });
    const bill = buildBill(relative, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    for (const s of bill.skills) {
      expect(s.totalMdBytes / s.totalMdTokens).toBeLessThan(3.2);
    }
    expect(measured.missedKeys.size).toBe(0);
  });

  it("on an installed layout, measures every billed file and sends nothing behind gstack/ or a .md-named link to another file", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-exact-installed-"));
    const checkout = path.join(tmp, "checkout");
    markCheckout(checkout);
    fs.mkdirSync(path.join(checkout, "qa"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(checkout, "README.md"), "checkout only");
    fs.writeFileSync(path.join(tmp, "notes.txt"), "not markdown");
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.symlinkSync(path.join(checkout, "qa", "SKILL.md"), path.join(skills, "qa", "SKILL.md"));
    fs.symlinkSync(path.join(tmp, "notes.txt"), path.join(skills, "qa", "notes.md"));
    fs.symlinkSync(checkout, path.join(skills, "gstack"));

    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(calls), egressHome });
    const sent = calls.map((c) => JSON.parse(c.body).messages[0].content);
    expect(sent).not.toContain("checkout only");
    expect(sent).not.toContain("not markdown");
    const bill = buildBill(skills, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    expect(bill.skills.map((s) => s.name)).toEqual(["qa"]);
    expect([...measured.missedKeys]).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sends each real file once and prices every link to it with that measurement", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-exact-once-"));
    const checkout = path.join(tmp, "checkout");
    fs.mkdirSync(path.join(checkout, "shared"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "twin"));
    fs.writeFileSync(path.join(checkout, "twin", "SKILL.md"), "---\nname: twin\ndescription: d\n---\n# twin\n");
    fs.writeFileSync(path.join(checkout, "shared", "guide.md"), "SHARED-GUIDE ".repeat(20));
    const skills = path.join(tmp, "skills");
    for (const name of ["a", "b"]) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.symlinkSync(path.join(checkout, "twin", "SKILL.md"), path.join(skills, name, "SKILL.md"));
      fs.symlinkSync(path.join(checkout, "shared"), path.join(skills, name, "refs"));
    }
    markCheckout(checkout);
    fs.symlinkSync(checkout, path.join(skills, "gstack"));

    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(calls), egressHome });
    const sent = calls.map((c) => JSON.parse(c.body).messages[0].content as string);
    expect(sent.filter((t) => t.startsWith("SHARED-GUIDE")).length).toBe(1);
    expect(sent.filter((t) => t.includes("# twin")).length).toBe(1);
    const bill = buildBill(skills, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    expect(bill.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect([...measured.missedKeys]).toEqual([]);
    const [a, b] = bill.skills;
    expect(a.totalMdTokens).toBe(b.totalMdTokens);
    expect(a.frontmatterTokens).toBe(b.frontmatterTokens);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("counts anything it could not measure instead of passing it off as measured", async () => {
    const measured = await measureExactTokens(TREE_A, {
      model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome,
    });
    expect(measured.missedKeys.size).toBe(0);
    const ghost = path.join(TREE_A, "alpha", "nope.md");
    expect(measured.tokensOf(ghost, 4150)).toBeGreaterThan(0);
    expect(measured.missedKeys.has(ghost)).toBe(true);
  });

  it("grades its own estimate: calibrationTable reports the residual per file", async () => {
    const measured = await measureExactTokens(TREE_A, {
      model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome,
    });
    const table = calibrationTable(measured.counts, TREE_A);
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(row).toHaveProperty("contentClass");
      expect(row.estimatedTokens).toBeGreaterThan(0);
      expect(row.tokens).toBeGreaterThan(0);
      expect(row.errorPct).toBeCloseTo(((row.estimatedTokens - row.tokens) / row.tokens) * 100, 1);
    }
    expect(typeof table.worstErrorPct).toBe("number");
    expect(typeof table.biasPct).toBe("number");
  });

  it("refuses to go to the network without a key, and says nothing was sent", async () => {
    let called = false;
    await expect(
      measureExactTokens(TREE_A, {
        model: "m",
        apiKey: "",
        fetchImpl: (() => ((called = true), Promise.reject(new Error("should not run")))) as never,
        egressHome,
      }),
    ).rejects.toMatchObject({ code: "exact_missing_api_key" });
    expect(called).toBe(false);
  });

  it("maps HTTP failures to typed codes", async () => {
    const status = (code: number) => (async () => ({ ok: false, status: code, text: async () => "nope" })) as never;
    for (const [code, expected] of [
      [401, "exact_auth_rejected"],
      [403, "exact_auth_rejected"],
      [500, "exact_request_failed"],
    ] as const) {
      await expect(
        measureExactTokens(TREE_A, { model: "m", apiKey: "k", fetchImpl: status(code), egressHome }),
      ).rejects.toMatchObject({ code: expected });
    }
    await expect(
      measureExactTokens(TREE_A, {
        model: "m", apiKey: "k",
        fetchImpl: (() => Promise.reject(new Error("offline"))) as never,
        egressHome,
      }),
    ).rejects.toBeInstanceOf(ExactModeError);
  });

  it("offline by default: no --exact means no network call at all", async () => {
    const out = capture();
    let called = false;
    const code = await contextBillMain([TREE_A, "--json"], {
      stdout: out.stream,
      stderr: out.stream,
      fetchImpl: (() => ((called = true), Promise.reject(new Error("no")))) as never,
      apiKey: "sk-test",
      egressHome,
    });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(JSON.parse(out.text()).tokenSource).toContain("estimate");
  });

  it("discloses what --exact sends before sending it", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([TREE_A, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(),
      egressHome,
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain("api.anthropic.com");
    expect(stderr.text()).toMatch(/sending the content of \d+ \.md file\(s\)/);
    const bill = JSON.parse(stdout.text());
    expect(bill.tokenSource).toContain("count_tokens");
    expect(bill.calibration.rows.length).toBeGreaterThan(0);
  });

  it("says how many of the files it sends come from the gstack checkout", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-notice-"));
    fs.mkdirSync(path.join(tmp, "checkout", "qa", "sections"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "checkout", "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(tmp, "checkout", "qa", "sections", "flow.md"), "f");
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "checkout", "qa", "SKILL.md"), path.join(skills, "qa", "SKILL.md"));
    fs.symlinkSync(path.join(tmp, "checkout", "qa", "sections"), path.join(skills, "qa", "sections"));
    fs.writeFileSync(path.join(skills, "qa", "notes.md"), "n");
    markCheckout(path.join(tmp, "checkout"));
    fs.symlinkSync(path.join(tmp, "checkout"), path.join(skills, "gstack"));
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: capture().stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(),
      egressHome,
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain("sending the content of 3 .md file(s)");
    expect(stderr.text()).toContain(`(2 of them in the gstack checkout ${fs.realpathSync(path.join(tmp, "checkout"))})`);
    expect(stderr.text()).not.toContain("not sending");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sends nothing the bill does not price, even what the root walk reaches", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-send-set-"));
    const skills = path.join(tmp, "skills");
    const ext = path.join(tmp, "ext");
    fs.mkdirSync(skills);
    fs.mkdirSync(path.join(ext, "cc"), { recursive: true });
    fs.mkdirSync(path.join(ext, "private"));
    fs.writeFileSync(path.join(ext, "cc", "SKILL.md"), "---\nname: cc\ndescription: d\n---\n# cc\n");
    fs.writeFileSync(path.join(ext, "private", "notes.md"), "PRIVATE-NOTES");
    fs.symlinkSync(ext, path.join(ext, "cc", "up"));
    fs.symlinkSync(path.join(ext, "cc"), path.join(skills, "cc"));
    markCheckout(ext);
    fs.symlinkSync(ext, path.join(skills, "gstack"));
    const calls: { body: string }[] = [];
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: capture().stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    expect(code).toBe(0);
    expect(stderr.text()).not.toContain("--exact unavailable");
    expect(calls.some((c) => c.body.includes("# cc"))).toBe(true);
    expect(calls.some((c) => c.body.includes("PRIVATE-NOTES"))).toBe(false);
    expect(stderr.text()).toContain("sending the content of 1 .md file(s)");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("walks for --exact only what the bill walks, so no file is keyed through a link no skill bills", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-send-walk-"));
    const dev = path.join(tmp, "dev");
    for (const name of ["m", "zz"]) {
      fs.mkdirSync(path.join(dev, name), { recursive: true });
      fs.writeFileSync(path.join(dev, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`);
    }
    fs.mkdirSync(path.join(dev, "other"));
    fs.writeFileSync(path.join(dev, "other", "n1.md"), "n");
    fs.symlinkSync(dev, path.join(dev, "m", "up"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(skills);
    fs.symlinkSync(path.join(dev, "m"), path.join(skills, "m"));
    fs.symlinkSync(path.join(dev, "zz"), path.join(skills, "zz"));
    markCheckout(dev);
    fs.symlinkSync(dev, path.join(skills, "gstack"));
    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(calls), egressHome });
    const keys = [...measured.counts.keys()].map((k) => path.relative(skills, k)).sort();
    expect(keys).toEqual([
      path.join("m", "SKILL.md"),
      path.join("m", "SKILL.md#frontmatter"),
      path.join("zz", "SKILL.md"),
      path.join("zz", "SKILL.md#frontmatter"),
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sends nothing and writes no receipt for an existing tree with no skills", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-no-skills-"));
    fs.mkdirSync(path.join(tmp, "docs"));
    fs.writeFileSync(path.join(tmp, "docs", "a.md"), "a");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-no-skills-egress-"));
    const out = capture();
    const calls: { body: string }[] = [];
    const code = await contextBillMain([tmp, "--exact"], {
      stdout: out.stream,
      stderr: out.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome: home,
    });
    const receipts = fs.readdirSync(home, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    expect(code).toBe(2);
    expect(out.text()).toContain("No SKILL.md files found");
    expect(out.text()).not.toContain("--exact: sending");
    expect(out.text()).not.toContain("no markdown skill file");
    expect(calls.length).toBe(0);
    expect(receipts).toEqual([]);
  });

  it("says the estimate was used when a tree has skills but nothing --exact can send", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-nothing-to-send-"));
    fs.mkdirSync(path.join(tmp, "qa"));
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.txt"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(tmp, "qa", "SKILL.txt"), path.join(tmp, "qa", "SKILL.md"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-nothing-to-send-egress-"));
    const stderr = capture();
    const calls: { body: string }[] = [];
    const code = await contextBillMain([tmp, "--exact", "--json"], {
      stdout: capture().stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome: home,
    });
    const receipts = fs.readdirSync(home, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(stderr.text()).toContain("offline estimate");
    expect(calls.length).toBe(0);
    expect(receipts).toEqual([]);
  });

  it("measures frontmatter only where the bill prices it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-fm-priced-"));
    fs.mkdirSync(path.join(tmp, "qa", "references"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(tmp, "qa", "references", "r.md"), "---\ntitle: ref\n---\nbody\n");
    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(tmp, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(calls), egressHome });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(measured.counts.has(path.join(tmp, "qa", "references", "r.md#frontmatter"))).toBe(false);
    expect(calls.length).toBe(4);
  });

  it("sends only the files the walk approved, even when links or files change during --diff", async () => {
    if (process.platform === "win32") return;
    const run = async (swap: (store: string, qa: string) => void) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-swap-"));
      for (const tree of ["a", "b"]) {
        fs.mkdirSync(path.join(tmp, tree, "qa"), { recursive: true });
        fs.writeFileSync(path.join(tmp, tree, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
      }
      const store = path.join(tmp, "b", "store");
      fs.mkdirSync(store);
      fs.writeFileSync(path.join(store, "safe.md"), "safe");
      fs.writeFileSync(path.join(store, "secret.env"), "SYNTHETIC_PRIVATE_NONMARKDOWN");
      const qa = path.join(tmp, "b", "qa");
      fs.symlinkSync(path.join(store, "safe.md"), path.join(qa, "ref.md"));
      const calls: { body: string }[] = [];
      const inner = fakeFetch(calls) as unknown as (u: string, i: { body: string }) => Promise<unknown>;
      let swapped = false;
      const fetchImpl = (async (u: string, i: { body: string }) => {
        if (!swapped) {
          swapped = true;
          swap(store, qa);
        }
        return inner(u, i);
      }) as never;
      const err = capture();
      const code = await contextBillMain(["--diff", path.join(tmp, "a"), path.join(tmp, "b"), "--exact", "--json"], {
        stdout: capture().stream,
        stderr: err.stream,
        apiKey: "sk-test",
        fetchImpl,
        egressHome,
      });
      fs.rmSync(tmp, { recursive: true, force: true });
      return { code, calls, err: err.text() };
    };

    const retargeted = await run((store, qa) => {
      fs.unlinkSync(path.join(qa, "ref.md"));
      fs.symlinkSync(path.join(store, "secret.env"), path.join(qa, "ref.md"));
    });
    expect(retargeted.calls.some((c) => c.body.includes("SYNTHETIC_PRIVATE"))).toBe(false);

    const replaced = await run((store) => {
      fs.unlinkSync(path.join(store, "safe.md"));
      fs.symlinkSync(path.join(store, "secret.env"), path.join(store, "safe.md"));
    });
    expect(replaced.calls.some((c) => c.body.includes("SYNTHETIC_PRIVATE"))).toBe(false);
    expect(replaced.code).toBe(1);
    expect(replaced.err).toContain("changed after it was walked");

    const hardlinked = await run((store) => {
      fs.unlinkSync(path.join(store, "safe.md"));
      fs.linkSync(path.join(store, "secret.env"), path.join(store, "safe.md"));
    });
    expect(hardlinked.calls.some((c) => c.body.includes("SYNTHETIC_PRIVATE"))).toBe(false);
    expect(hardlinked.code).toBe(1);
    expect(hardlinked.err).toContain("changed after it was walked");

    const parentSwapped = await run((store) => {
      const decoy = `${store}-decoy`;
      fs.mkdirSync(decoy);
      fs.writeFileSync(path.join(decoy, "safe.md"), "SYNTHETIC_PRIVATE_DECOY");
      fs.renameSync(store, `${store}-old`);
      fs.symlinkSync(decoy, store);
    });
    expect(parentSwapped.calls.some((c) => c.body.includes("SYNTHETIC_PRIVATE"))).toBe(false);
    expect(parentSwapped.code).toBe(1);
    expect(parentSwapped.err).toContain("changed after it was walked");

    const sameFileMoved = await run((store) => {
      fs.renameSync(store, `${store}-old`);
      fs.symlinkSync(`${store}-old`, store);
    });
    expect(sameFileMoved.code).toBe(1);
    expect(sameFileMoved.err).toContain("changed after it was walked");
  });

  it("never reuses a measurement for a file retargeted or rewritten after it was measured", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-stale-"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "small.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(tmp, "big.md"), "---\nname: qa\ndescription: d\n---\n" + "z".repeat(60_000));
    fs.symlinkSync(path.join(tmp, "small.md"), path.join(skills, "qa", "SKILL.md"));
    fs.writeFileSync(path.join(skills, "qa", "ref.md"), "r");
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome });
    fs.unlinkSync(path.join(skills, "qa", "SKILL.md"));
    fs.symlinkSync(path.join(tmp, "big.md"), path.join(skills, "qa", "SKILL.md"));
    fs.writeFileSync(path.join(skills, "qa", "ref.md"), "r".repeat(9_000));
    const bill = buildBill(skills, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    fs.rmSync(tmp, { recursive: true, force: true });
    const skillMd = path.join(skills, "qa", "SKILL.md");
    const ref = path.join(skills, "qa", "ref.md");
    expect(measured.missedKeys.has(skillMd)).toBe(true);
    expect(measured.missedKeys.has(ref)).toBe(true);
    expect(bill.skills[0].skillMdTokens).toBeGreaterThan(10_000);
    expect(bill.skills[0].totalMdTokens).toBeGreaterThan(12_000);
  });

  it("never reuses a measurement for a file replaced by one with the same size and mtime", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-same-stat-"));
    fs.mkdirSync(path.join(tmp, "qa"));
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    const ref = path.join(tmp, "qa", "ref.md");
    fs.writeFileSync(ref, "a".repeat(3_000));
    const mtime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(ref, mtime, mtime);
    const measured = await measureExactTokens(tmp, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome });
    const replacement = path.join(tmp, "qa", ".replacement");
    fs.writeFileSync(replacement, "b".repeat(3_000));
    fs.utimesSync(replacement, mtime, mtime);
    fs.renameSync(replacement, ref);
    buildBill(tmp, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource, missedKeys: measured.missedKeys });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(measured.missedKeys.has(ref)).toBe(true);
  });

  it("keeps a bill measured when a skill has no frontmatter or a reference is empty", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-zero-"));
    fs.mkdirSync(path.join(tmp, "alpha"));
    fs.writeFileSync(path.join(tmp, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n# alpha\n");
    fs.writeFileSync(path.join(tmp, "alpha", "empty.md"), "");
    fs.mkdirSync(path.join(tmp, "beta"));
    fs.writeFileSync(path.join(tmp, "beta", "SKILL.md"), "# beta has no frontmatter\n");
    const inner = fakeFetch() as unknown as (u: string, i: { body: string }) => Promise<unknown>;
    const strict = (async (u: string, i: { body: string }) =>
      !/\S/.test(JSON.parse(i.body).messages[0].content)
        ? { ok: false, status: 400, text: async () => "messages: text content blocks must contain non-whitespace text" }
        : inner(u, i)) as never;
    const measured = await measureExactTokens(tmp, { model: "m", apiKey: "sk-test", fetchImpl: strict, egressHome });
    const bill = buildBill(tmp, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource, missedKeys: measured.missedKeys });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect([...measured.missedKeys]).toEqual([]);
    expect(bill.tokenEstimateErrorPct).toBe(0);
    expect(bill.tokenSource).toBe("count_tokens (m)");
  });

  it("sends nothing and writes no receipt when every file it could send is blank", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-blank-"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "");
    const home = path.join(tmp, "egress");
    const calls: { body: string }[] = [];
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(calls), egressHome: home });
    buildBill(skills, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource, missedKeys: measured.missedKeys });
    const run = async () => {
      const stderr = capture();
      const code = await contextBillMain([skills, "--exact", "--json"], {
        stdout: capture().stream,
        stderr: stderr.stream,
        apiKey: "sk-test",
        fetchImpl: fakeFetch(calls),
        egressHome: home,
      });
      return { code, err: stderr.text() };
    };
    const blank = await run();
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.writeFileSync(path.join(tmp, "outside", "doc.md"), "OUTSIDE-DOC");
    fs.symlinkSync(path.join(tmp, "outside"), path.join(skills, "qa", "notes"));
    const withRefused = await run();
    const receipts = listReceipts(home).length;
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(calls).toEqual([]);
    expect(receipts).toBe(0);
    expect([...measured.missedKeys]).toEqual([]);
    expect(blank.code).toBe(0);
    expect(blank.err).not.toContain("sending the content");
    expect(blank.err).toContain(`every .md file --exact could send under ${skills} is blank; nothing was sent`);
    expect(withRefused.code).toBe(0);
    expect(withRefused.err).toContain(`is blank, and the rest are outside the folders it sends from; nothing was sent`);
  });

  it("estimates a whitespace-only file instead of sending it, and counts only the files it sends", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-whitespace-"));
    fs.mkdirSync(path.join(tmp, "qa"));
    fs.writeFileSync(path.join(tmp, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(tmp, "qa", "spaces.md"), " \n".repeat(4_000));
    const calls: { body: string }[] = [];
    const inner = fakeFetch(calls) as unknown as (u: string, i: { body: string }) => Promise<unknown>;
    const strict = (async (u: string, i: { body: string }) =>
      !/\S/.test(JSON.parse(i.body).messages[0].content)
        ? { ok: false, status: 400, text: async () => "messages: text content blocks must contain non-whitespace text" }
        : inner(u, i)) as never;
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([tmp, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: strict,
      egressHome,
    });
    const measured = await measureExactTokens(tmp, { model: "m", apiKey: "sk-test", fetchImpl: strict, egressHome });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(stderr.text()).toContain("sending the content of 1 .md file(s)");
    const bill = JSON.parse(stdout.text());
    expect(bill.tokenSource).toStartWith("mixed: ");
    expect(bill.skills[0].totalMdTokens).toBeGreaterThan(1_000);
    expect(measured.measuredFiles).toBe(2);
  });

  it("trusts $GSTACK_STATE_ROOT/render when no state root is passed in", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-render-env-"));
    const saved = process.env.GSTACK_STATE_ROOT;
    const calls: { body: string }[] = [];
    const stderr = capture();
    let code: number;
    try {
      process.env.GSTACK_STATE_ROOT = path.join(tmp, "state");
      const rendered = path.join(tmp, "state", "render", "claude", "qa");
      fs.mkdirSync(rendered, { recursive: true });
      fs.writeFileSync(path.join(rendered, "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# RENDER-ENV\n");
      fs.mkdirSync(path.join(tmp, "skills", "qa"), { recursive: true });
      fs.symlinkSync(path.join(rendered, "SKILL.md"), path.join(tmp, "skills", "qa", "SKILL.md"));
      code = await contextBillMain([path.join(tmp, "skills"), "--exact", "--json"], {
        stdout: capture().stream,
        stderr: stderr.stream,
        apiKey: "sk-test",
        fetchImpl: fakeFetch(calls),
        egressHome,
      });
    } finally {
      process.env.GSTACK_STATE_ROOT = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    expect(code).toBe(0);
    expect(calls.some((c) => c.body.includes("RENDER-ENV"))).toBe(true);
    expect(stderr.text()).toContain("in gstack's render folder");
  });

  it("still bills the tree when the state root is not a readable directory", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-stateroot-file-"));
    const stateRoot = path.join(tmp, "statefile");
    fs.writeFileSync(stateRoot, "not a directory");
    fs.mkdirSync(path.join(tmp, "skills", "qa"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "skills", "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    const stdout = capture();
    const code = await contextBillMain([path.join(tmp, "skills"), "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: capture().stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(),
      egressHome,
      stateRoot,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text()).tokenSource).toBe("count_tokens (claude-opus-5-5)");
  });

  it("refuses a walked file swapped for a FIFO instead of hanging", () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-fifo-"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.writeFileSync(path.join(skills, "qa", "a.md"), "A");
    const script = path.join(tmp, "probe.ts");
    fs.writeFileSync(
      script,
      [
        `import fs from "node:fs";`,
        `import { spawnSync } from "node:child_process";`,
        `import { exactSendSet, measureExactTokens } from ${JSON.stringify(path.join(ROOT, "lib", "context-bill.ts"))};`,
        `const root = ${JSON.stringify(skills)};`,
        `const sendSet = exactSendSet(root, ${JSON.stringify(path.join(tmp, "state"))});`,
        `fs.unlinkSync(${JSON.stringify(path.join(skills, "qa", "a.md"))});`,
        `spawnSync("mkfifo", [${JSON.stringify(path.join(skills, "qa", "a.md"))}], { timeout: 5_000 });`,
        `if (!fs.lstatSync(${JSON.stringify(path.join(skills, "qa", "a.md"))}).isFIFO()) { console.log("NOFIFO"); process.exit(0); }`,
        `const fetchImpl = (async () => ({ ok: true, json: async () => ({ input_tokens: 9 }) })) as never;`,
        `try { await measureExactTokens(root, { sendSet, model: "m", apiKey: "sk-test", fetchImpl, egressHome: ${JSON.stringify(tmp)} }); console.log("SENT"); }`,
        `catch (error) { console.log("REFUSED " + (error as Error).message); }`,
      ].join("\n"),
    );
    const result = Bun.spawnSync([process.execPath, ...bunIsolationArgs(), script], { timeout: 15_000 });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("NOFIFO");
    expect(result.stdout.toString()).toContain("REFUSED");
    expect(result.stdout.toString()).toContain("changed after it was walked");
  });

  it("sends files in the root and the linked gstack checkout, and refuses and names anything else a link reaches", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-egress-"));
    const checkout = path.join(tmp, "checkout");
    markCheckout(checkout);
    fs.mkdirSync(path.join(checkout, "qa", "sections"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# CHECKOUT-QA\n");
    fs.writeFileSync(path.join(checkout, "qa", "sections", "flow.md"), "CHECKOUT-FLOW");
    const documents = path.join(tmp, "Documents");
    fs.mkdirSync(path.join(documents, "vault"), { recursive: true });
    fs.writeFileSync(path.join(documents, "vault", "diary.md"), "PRIVATE-DIARY");
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.symlinkSync(checkout, path.join(skills, "gstack"));
    fs.symlinkSync(path.join(checkout, "qa", "SKILL.md"), path.join(skills, "qa", "SKILL.md"));
    fs.symlinkSync(path.join(checkout, "qa", "sections"), path.join(skills, "qa", "sections"));
    fs.symlinkSync(documents, path.join(skills, "qa", "notes"));

    const calls: { body: string }[] = [];
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    const err = stderr.text();
    const documentsReal = fs.realpathSync(path.join(documents, "vault"));
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(calls.some((c) => c.body.includes("CHECKOUT-QA"))).toBe(true);
    expect(calls.some((c) => c.body.includes("CHECKOUT-FLOW"))).toBe(true);
    expect(calls.some((c) => c.body.includes("PRIVATE-DIARY"))).toBe(false);
    expect(err).toContain(`not sending 1 .md file(s)`);
    expect(err).toContain(documentsReal);
    expect(err).toContain(path.join("qa", "notes", "vault", "diary.md"));
    expect(err).toContain("estimated");
    const bill = JSON.parse(stdout.text());
    const skillMd = "---\nname: qa\ndescription: d\n---\n# CHECKOUT-QA\n";
    expect(bill.skills[0].totalMdBytes).toBe(skillMd.length + "CHECKOUT-FLOW".length + "PRIVATE-DIARY".length);
  });

  it("labels a bill with any estimated item as mixed, in --json and in text", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-mixed-"));
    const outside = path.join(tmp, "outside", "ext");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: ext\ndescription: d\n---\n" + "e".repeat(6_000));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(outside, path.join(skills, "ext"));
    const run = async (args: string[]) => {
      const stdout = capture();
      const code = await contextBillMain([skills, "--exact", ...args], {
        stdout: stdout.stream,
        stderr: capture().stream,
        apiKey: "sk-test",
        fetchImpl: fakeFetch(),
        egressHome,
      });
      return { code, out: stdout.text() };
    };
    const json = await run(["--json"]);
    const text = await run([]);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(json.code).toBe(0);
    const bill = JSON.parse(json.out);
    expect(bill.tokenSource).toStartWith("mixed: count_tokens");
    expect(bill.tokenSource).toContain("estimated offline");
    expect(bill.tokenEstimateErrorPct).toBeGreaterThan(0);
    expect(text.out).toContain("Token counts are MIXED");
    expect(text.out).not.toContain("Token counts measured with");
  });

  async function exactRun(skills: string) {
    const calls: { body: string }[] = [];
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: capture().stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    return { code, calls, err: stderr.text() };
  }

  it("sends a render install's files from gstack's render folder, and refuses a link out of it", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-render-"));
    const stateRoot = path.join(tmp, "state");
    const rendered = path.join(stateRoot, "render", "claude", "review");
    fs.mkdirSync(path.join(rendered, "sections"), { recursive: true });
    fs.writeFileSync(path.join(rendered, "SKILL.md"), "---\nname: review\ndescription: d\n---\n# RENDER-SKILL\n");
    fs.writeFileSync(path.join(rendered, "sections", "a.md"), "RENDER-SECTION");
    fs.mkdirSync(path.join(tmp, "Documents"));
    fs.writeFileSync(path.join(tmp, "Documents", "diary.md"), "PRIVATE-DIARY");
    fs.symlinkSync(path.join(tmp, "Documents", "diary.md"), path.join(rendered, "notes.md"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "review"), { recursive: true });
    for (const name of ["SKILL.md", "sections", "notes.md"]) fs.symlinkSync(path.join(rendered, name), path.join(skills, "review", name));

    const calls: { body: string }[] = [];
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
      stateRoot,
    });
    const renderReal = fs.realpathSync(path.join(stateRoot, "render"));
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = stderr.text();
    expect(code).toBe(0);
    expect(calls.some((c) => c.body.includes("RENDER-SKILL"))).toBe(true);
    expect(calls.some((c) => c.body.includes("RENDER-SECTION"))).toBe(true);
    expect(calls.some((c) => c.body.includes("PRIVATE-DIARY"))).toBe(false);
    expect(err).toContain(`2 in gstack's render folder ${renderReal}`);
    expect(err).toContain("not sending 1 .md file(s)");
    expect(err).toContain(`  ${path.join("review", "notes.md")}\n`);
    expect(JSON.parse(stdout.text()).tokenSource).toStartWith("mixed: ");
  });

  it("does not trust a render folder that is itself a link", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-render-link-"));
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "notes.md"), "PRIVATE-NOTES");
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot);
    fs.symlinkSync(elsewhere, path.join(stateRoot, "render"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(elsewhere, "notes.md"), path.join(skills, "qa", "notes.md"));
    const calls: { body: string }[] = [];
    const stderr = capture();
    const code = await contextBillMain([skills, "--exact", "--json"], {
      stdout: capture().stream,
      stderr: stderr.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
      stateRoot,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(calls.some((c) => c.body.includes("PRIVATE-NOTES"))).toBe(false);
    expect(stderr.text()).toContain("not sending 1 .md file(s)");
  });

  it("names each outside directory once, collapsing nested ones, and lists every refused file", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-egress-dirs-"));
    const docs = path.join(tmp, "Documents");
    fs.mkdirSync(path.join(docs, "vault", "sub"), { recursive: true });
    fs.mkdirSync(path.join(docs, "vault-b"), { recursive: true });
    fs.writeFileSync(path.join(docs, "vault", "a.md"), "A");
    fs.writeFileSync(path.join(docs, "vault", "sub", "b.md"), "B");
    fs.writeFileSync(path.join(docs, "vault-b", "c.md"), "C");
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
    fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(docs, "vault"), path.join(skills, "qa", "v1"));
    fs.symlinkSync(path.join(docs, "vault-b"), path.join(skills, "qa", "v2"));
    const vault = fs.realpathSync(path.join(docs, "vault"));
    const vaultB = fs.realpathSync(path.join(docs, "vault-b"));
    const run = await exactRun(skills);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(run.err).toContain(`not sending 3 .md file(s)`);
    expect(run.err).toContain(`(under ${vault}, ${vaultB})`);
    for (const f of [path.join("qa", "v1", "a.md"), path.join("qa", "v1", "sub", "b.md"), path.join("qa", "v2", "c.md")]) {
      expect(run.err).toContain(`  ${f}\n`);
    }
  });

  it("does not take a gstack/ entry as the checkout unless it is a gstack checkout", async () => {
    if (process.platform === "win32") return;
    const cases: Array<(tmp: string, skills: string, docs: string) => void> = [
      (_tmp, skills, docs) => fs.symlinkSync(docs, path.join(skills, "gstack")),
      (_tmp, skills, docs) => {
        fs.mkdirSync(path.join(docs, ".git"));
        fs.symlinkSync(docs, path.join(skills, "gstack"));
      },
      (tmp, skills) => {
        fs.mkdirSync(path.join(tmp, ".git"));
        fs.writeFileSync(path.join(tmp, "VERSION"), "1.0.0\n");
        fs.writeFileSync(path.join(tmp, "setup"), "#!/bin/sh\n");
        fs.writeFileSync(path.join(tmp, "SKILL.md"), "---\nname: my-project\ndescription: p\n---\n# p\n");
        fs.symlinkSync(tmp, path.join(skills, "gstack"));
      },
      (_tmp, skills, docs) => {
        markCheckout(docs);
        fs.rmSync(path.join(docs, ".git"), { recursive: true });
        fs.symlinkSync(docs, path.join(skills, "gstack"));
      },
    ];
    for (const plant of cases) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-not-checkout-"));
      const docs = path.join(tmp, "Documents");
      fs.mkdirSync(path.join(docs, "vault"), { recursive: true });
      fs.writeFileSync(path.join(docs, "vault", "diary.md"), "PRIVATE-DIARY");
      const skills = path.join(tmp, "skills");
      fs.mkdirSync(path.join(skills, "qa"), { recursive: true });
      fs.writeFileSync(path.join(skills, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
      fs.symlinkSync(path.join(docs, "vault"), path.join(skills, "qa", "notes"));
      plant(tmp, skills, docs);
      const run = await exactRun(skills);
      fs.rmSync(tmp, { recursive: true, force: true });
      expect(run.code).toBe(0);
      expect(run.calls.some((c) => c.body.includes("PRIVATE-DIARY"))).toBe(false);
      expect(run.err).toMatch(/not sending \d+ \.md file\(s\)/);
      expect(run.err).toContain("diary.md");
      expect(run.err).not.toContain("in the gstack checkout");
    }
  });

  it("sends a dev-setup tree's files from the gstack checkout that contains it", async () => {
    if (process.platform === "win32") return;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-dev-setup-"));
    markCheckout(repo);
    fs.mkdirSync(path.join(repo, "review"));
    fs.writeFileSync(path.join(repo, "review", "SKILL.md"), "---\nname: review\ndescription: d\n---\n# REVIEW-SKILL\n");
    const skills = path.join(repo, ".claude", "skills");
    fs.mkdirSync(path.join(skills, "review"), { recursive: true });
    fs.symlinkSync(repo, path.join(skills, "gstack"));
    fs.symlinkSync(path.join(repo, "review", "SKILL.md"), path.join(skills, "review", "SKILL.md"));
    const run = await exactRun(skills);
    fs.rmSync(repo, { recursive: true, force: true });
    expect(run.code).toBe(0);
    expect(run.calls.some((c) => c.body.includes("REVIEW-SKILL"))).toBe(true);
    expect(run.err).not.toContain("not sending");
  });

  it("says every billed file was refused, not that there was none, when nothing is left to send", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-all-refused-"));
    fs.mkdirSync(path.join(tmp, "ext", "qa"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "ext", "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(skills);
    fs.symlinkSync(path.join(tmp, "ext", "qa"), path.join(skills, "qa"));
    const run = await exactRun(skills);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(run.calls.length).toBe(0);
    expect(run.err).toContain("not sending 1 .md file(s)");
    expect(run.err).toContain("every billed .md file is outside");
    expect(run.err).not.toContain("no markdown skill file");
  });

  it("--exact measures every file behind a link chain deeper than the kernel's limit", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-exact-deep-"));
    const levels = path.join(tmp, "levels");
    const depth = 50;
    for (let i = 0; i < depth; i++) {
      fs.mkdirSync(path.join(levels, `L${i}`), { recursive: true });
      fs.writeFileSync(path.join(levels, `L${i}`, `f${i}.md`), `F${i}-${"x".repeat(30)}`);
    }
    for (let i = 0; i < depth - 1; i++) fs.symlinkSync(path.join(levels, `L${i + 1}`), path.join(levels, `L${i}`, "next"));
    markCheckout(levels);
    const root = path.join(tmp, "skills");
    fs.mkdirSync(path.join(root, "qa"), { recursive: true });
    fs.writeFileSync(path.join(root, "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    fs.symlinkSync(path.join(levels, "L0"), path.join(root, "qa", "next"));
    fs.symlinkSync(levels, path.join(root, "gstack"));
    const measured = await measureExactTokens(root, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome });
    buildBill(root, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    const rows = calibrationTable(measured.counts, root, measured.realOf).rows.length;
    fs.rmSync(tmp, { recursive: true, force: true });
    expect([...measured.missedKeys]).toEqual([]);
    expect([...measured.counts.keys()].filter((k) => !k.endsWith("#frontmatter")).length).toBe(depth + 1);
    expect(rows).toBe(depth + 1);
  });

  it("prices a second skill's links into a chain deeper than the kernel's limit from the one measurement", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-exact-shared-deep-"));
    const levels = path.join(tmp, "levels");
    const depth = 50;
    for (let i = 0; i < depth; i++) {
      fs.mkdirSync(path.join(levels, `L${i}`), { recursive: true });
      fs.writeFileSync(path.join(levels, `L${i}`, `f${i}.md`), `F${i}-${"x".repeat(30)}`);
    }
    for (let i = 0; i < depth - 1; i++) fs.symlinkSync(path.join(levels, `L${i + 1}`), path.join(levels, `L${i}`, "next"));
    markCheckout(levels);
    const root = path.join(tmp, "skills");
    for (const name of ["qa", "qb"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`);
      fs.symlinkSync(path.join(levels, "L0"), path.join(root, name, "next"));
    }
    fs.symlinkSync(levels, path.join(root, "gstack"));
    const measured = await measureExactTokens(root, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome });
    const bill = buildBill(root, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect([...measured.missedKeys]).toEqual([]);
    const [qa, qb] = ["qa", "qb"].map((n) => bill.skills.find((s) => s.name === n)!);
    expect(qb.totalMdBytes).toBe(qa.totalMdBytes);
    expect(qb.totalMdTokens).toBe(qa.totalMdTokens);
  });

  it("names a missing tree, without a raw ENOENT or any request", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-missing-"));
    const out = capture();
    const calls: { body: string }[] = [];
    const code = await contextBillMain([path.join(parent, "absent"), "--exact"], {
      stdout: out.stream,
      stderr: out.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    fs.rmSync(parent, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(out.text()).toContain("No such tree:");
    expect(out.text()).not.toContain("ENOENT");
    expect(calls.length).toBe(0);
  });

  it("--diff with a missing second tree sends nothing from the first", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-diff-missing-"));
    fs.mkdirSync(path.join(parent, "a", "qa"), { recursive: true });
    fs.writeFileSync(path.join(parent, "a", "qa", "SKILL.md"), "---\nname: qa\ndescription: d\n---\n# qa\n");
    const out = capture();
    const calls: { body: string }[] = [];
    const code = await contextBillMain(["--diff", path.join(parent, "a"), path.join(parent, "absent"), "--exact"], {
      stdout: out.stream,
      stderr: out.stream,
      apiKey: "sk-test",
      fetchImpl: fakeFetch(calls),
      egressHome,
    });
    fs.rmSync(parent, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(out.text()).toContain("No such tree:");
    expect(calls.length).toBe(0);
  });

  it("measures a skill's frontmatter even when its file was first walked under another name", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-fm-alias-"));
    const skills = path.join(tmp, "skills");
    fs.mkdirSync(path.join(skills, "aaa"), { recursive: true });
    fs.mkdirSync(path.join(skills, "zskill"), { recursive: true });
    fs.writeFileSync(path.join(skills, "aaa", "SKILL.md"), "---\nname: aaa\ndescription: d\n---\n# a\n");
    fs.writeFileSync(path.join(skills, "aaa", "notes.md"), "---\nname: zskill\ndescription: d\n---\n# z\n");
    fs.symlinkSync(path.join(skills, "aaa", "notes.md"), path.join(skills, "zskill", "SKILL.md"));
    const measured = await measureExactTokens(skills, { model: "m", apiKey: "sk-test", fetchImpl: fakeFetch(), egressHome });
    const bill = buildBill(skills, { tokensOf: measured.tokensOf, tokenSource: measured.tokenSource });
    expect(bill.skills.map((s) => s.name)).toEqual(["aaa", "zskill"]);
    expect(measured.counts.has(path.join(skills, "aaa", "notes.md#frontmatter"))).toBe(true);
    expect([...measured.missedKeys]).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("degrades to the estimate when exact mode is unavailable, naming the code", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await contextBillMain([TREE_A, "--exact", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      apiKey: "",
      fetchImpl: (() => Promise.reject(new Error("should not run"))) as never,
      egressHome,
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain("exact_missing_api_key");
    expect(JSON.parse(stdout.text()).tokenSource).toContain("estimate");
  });

  it("--help discloses --exact's egress and recalibration", async () => {
    const out = capture();
    expect(await contextBillMain(["--help"], { stdout: out.stream, stderr: out.stream })).toBe(0);
    expect(out.text()).toContain("api.anthropic.com");
    expect(out.text()).toContain("egress receipt");
    expect(out.text()).toContain("recalibrates");
  });
});

describe("ground truth against THIS repo (skill-census parity)", () => {
  const census = skillCensus(ROOT);
  const dirs = findSkillDirs(ROOT);
  const rels = dirs.map((d) => path.relative(ROOT, d) || ".");

  it("the walker reaches every physical SKILL.md the census counts", () => {
    // physicalSkillFiles is the walker's expectation: every depth-1 skill dir
    // (symlinked dirs included) plus the root router.
    for (const rel of census.physicalSkillFiles) {
      const dirRel = rel === "SKILL.md" ? "." : path.dirname(rel);
      expect(rels, `walker missed ${rel}`).toContain(dirRel);
    }
  });

  it("the root router SKILL.md is billed (fix a live on the real repo)", () => {
    expect(census.physicalSkillFiles).toContain("SKILL.md"); // guard the guard
    expect(rels).toContain(".");
  });

  it("a real skill's frontmatter bytes match an independent computation", () => {
    const qaDir = dirs.find((d) => path.relative(ROOT, d) === "qa")!;
    expect(qaDir).toBeTruthy();
    const bill = buildBill(qaDir);
    expect(bill.skills).toHaveLength(1);
    expect(bill.skills[0].frontmatterBytes).toBe(frontmatterBytes(path.join(qaDir, "SKILL.md")));
    expect(bill.skills[0].frontmatterBytes).toBeGreaterThan(0);
  });

  it("skill count is at least the census count (deeper trees may add more, never fewer)", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(census.physicalSkillFiles.length);
  });

  it("no skill dir is billed twice", () => {
    expect(new Set(rels).size).toBe(rels.length);
  });
});

describe("CLI plumbing", () => {
  it("unknown flag and missing tree are usage errors (exit 2)", async () => {
    const a = capture();
    expect(await contextBillMain(["--nope"], { stdout: a.stream, stderr: a.stream })).toBe(2);
    const b = capture();
    expect(await contextBillMain(["--diff", TREE_A], { stdout: b.stream, stderr: b.stream })).toBe(2);
    const c = capture();
    expect(await contextBillMain([path.join(os.tmpdir(), "does-not-exist-xyz")], { stdout: c.stream, stderr: c.stream })).toBe(1);
  });

  it("bin/gstack-context-bill runs standalone", () => {
    const result = Bun.spawnSync([path.join(ROOT, "bin", "gstack-context-bill"), TREE_A], { timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ALWAYS-ON");
    expect(result.stdout.toString()).toContain("EAGER");
  });
});
