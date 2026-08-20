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
    // nested skill twice. A revert of the topSeg/SKILL.md skip in totalMd
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
      tokenSource: "count_tokens (claude-opus-4-5)",
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
});

describe("--exact (opt-in measurement; offline here via an injected fetch)", () => {
  let egressHome: string;
  beforeAll(() => {
    egressHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-bill-egress-"));
  });
  afterAll(() => {
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
    if (process.platform === "win32" || process.getuid?.() === 0) return;
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
    const result = Bun.spawnSync([path.join(ROOT, "bin", "gstack-context-bill"), TREE_A]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ALWAYS-ON");
    expect(result.stdout.toString()).toContain("EAGER");
  });
});
