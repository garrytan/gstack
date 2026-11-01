/**
 * $D CLI persistence contract with the image API stubbed (no spend): paid
 * images are never overwritten, every saved image is reported, a local save
 * failure never buys a second image, and JSON is printed on every exit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const RUN_FIELDS = ["requested", "saved", "selected", "failures", "recovered"];

let dir: string;
let calls: string;
let preload: string;
const sessions: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-cli-persist-"));
  calls = path.join(dir, "calls.log");
  preload = path.join(dir, "stub.ts");
  fs.writeFileSync(preload, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const seq = (name: string) => (process.env[name] || "").split(",").filter(Boolean);
globalThis.fetch = (async (url: unknown) => {
  const pathname = new URL(String(url)).pathname;
  const log = process.env.CALLS!;
  const prior = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(l => l === pathname).length : 0;
  appendFileSync(log, pathname + "\\n");
  if (pathname === "/v1/responses") {
    const step = seq("IMAGES")[prior] ?? "ok";
    if (step === "fail") return new Response("upstream unavailable", { status: 503 });
    const result = step === "empty" ? "====" : Buffer.from("image " + prior).toString("base64");
    return Response.json({ id: "resp-" + prior, output: [{ type: "image_generation_call", result }] });
  }
  const step = seq("CHECKS")[prior] ?? "PASS";
  if (step === "throw") throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  return Response.json({ choices: [{ message: { content: step === "PASS" ? "PASS" : "FAIL: illegible title" } }] });
}) as typeof fetch;
`);
});

afterEach(() => {
  for (const s of sessions.splice(0)) fs.rmSync(s, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-env-file", "--preload", preload, CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH!, HOME: dir, GSTACK_HOME: path.join(dir, "state"), TMPDIR: dir,
      OPENAI_API_KEY: "fixture-not-a-real-key", CALLS: calls, ...env,
    },
  });
  const json = JSON.parse(r.stdout);
  for (const a of json.attempts ?? []) if (a.sessionFile) sessions.push(a.sessionFile);
  return { status: r.status, stderr: r.stderr, json };
}

const apiCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(l => l === "/v1/responses").length : 0;

describe("never overwrite", () => {
  // Value: protects=a second generate into the same --output keeps the first image and reports the bumped path with the exact notice;
  //   fails_when=generate writes with writeFileSync again or reports the requested path; why_new=#1529 had no CLI coverage; seam=none
  test("generate bumps, prints the notice and leaves the original bytes", () => {
    const out = path.join(dir, "mock.png");
    const first = run(["generate", "--brief", "dashboard", "--output", out]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json.outputPath).toBe(out);
    const second = run(["generate", "--brief", "dashboard", "--output", out]);
    const bumped = path.join(dir, "mock-2.png");
    expect(second.status, second.stderr).toBe(0);
    expect(second.json.outputPath).toBe(bumped);
    expect(second.json.saved).toEqual([bumped]);
    expect(second.stderr).toContain(`note: ${out} exists; saved to ${bumped} (existing file kept)`);
    expect(fs.readFileSync(out, "utf8")).toBe("image 0");
    expect(fs.readFileSync(bumped, "utf8")).toBe("image 1");
    for (const key of [...RUN_FIELDS, "outputPath", "attempts"]) expect(second.json).toHaveProperty(key);
  });

  // Value: protects=a second variants round keeps round one, reports variant-X-2 paths, and both branches print one key set;
  //   fails_when=variants overwrites or the --viewports branch drops count/errors/failures; why_new=#1529 overwrite path; seam=none
  test("variants (both branches) bump per file with one shared key set", () => {
    const outDir = path.join(dir, "designs");
    const r1 = run(["variants", "--brief", "dashboard", "--count", "2", "--output-dir", outDir]);
    expect(r1.json.paths).toEqual([path.join(outDir, "variant-A.png"), path.join(outDir, "variant-B.png")]);
    const r2 = run(["variants", "--brief", "dashboard", "--count", "2", "--output-dir", outDir]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.json.paths).toEqual([path.join(outDir, "variant-A-2.png"), path.join(outDir, "variant-B-2.png")]);
    expect(r2.stderr).toContain(`note: ${path.join(outDir, "variant-A.png")} exists; saved to ${path.join(outDir, "variant-A-2.png")} (existing file kept)`);
    expect(fs.readFileSync(path.join(outDir, "variant-A.png"), "utf8")).toBe("image 0");
    run(["variants", "--brief", "dashboard", "--viewports", "desktop", "--output-dir", outDir]);
    const again = run(["variants", "--brief", "dashboard", "--viewports", "desktop", "--output-dir", outDir]);
    expect(again.json.paths).toEqual([path.join(outDir, "responsive-desktop-2.png")]);
    expect(fs.readFileSync(path.join(outDir, "responsive-desktop.png"), "utf8")).toBe("image 4");
    const keys = (o: object) => Object.keys(o).filter(k => k !== "viewports").sort();
    expect(keys(again.json)).toEqual(keys(r2.json));
    expect(again.json).toMatchObject({ count: 1, succeeded: 1, failed: 0, errors: [], failures: [], viewports: ["desktop"] });
    for (const key of [...RUN_FIELDS, "outputDir", "count", "succeeded", "failed", "paths", "errors"]) expect(r2.json).toHaveProperty(key);
  });
});

describe("accounting and exit codes", () => {
  // Value: protects=each --retry attempt is its own saved, counted image; fails_when=retries overwrite one --output or attempts drop rejected images;
  //   why_new=the retry premise was wrong in #1737; seam=none
  test("generate --check --retry keeps the rejected and the passing image", () => {
    const out = path.join(dir, "retry.png");
    const r = run(["generate", "--brief", "dashboard", "--output", out, "--check", "--retry", "1"], { CHECKS: "FAIL,PASS" });
    expect(r.status, r.stderr).toBe(0);
    const second = path.join(dir, "retry-2.png");
    expect(r.json.saved).toEqual([out, second]);
    expect(r.json.attempts.map((a: any) => [a.path, a.check.pass])).toEqual([[out, false], [second, true]]);
    expect(r.json.outputPath).toBe(second);
    expect(fs.existsSync(out) && fs.existsSync(second)).toBe(true);
  });

  // Value: protects=an interrupted retry exits 3 with JSON listing the earlier saved attempt; fails_when=the error escapes as exit 1 without JSON;
  //   why_new=new exit contract; seam=none
  test("interrupted retry exits 3 and still prints every saved path", () => {
    const out = path.join(dir, "retry.png");
    const r = run(["generate", "--brief", "dashboard", "--output", out, "--check", "--retry", "2"], { CHECKS: "FAIL", IMAGES: "ok,fail" });
    expect(r.status).toBe(3);
    expect(r.json).toMatchObject({ outputPath: null, selected: null, saved: [out], requested: 1 });
    expect(r.json.failures).toHaveLength(1);
    expect(r.json.failures[0].reason).toContain("503");
  });

  // Value: protects=a quality-check timeout after a save still prints partial JSON and exits 3; fails_when=a check exception loses the saved path;
  //   why_new=DX contract case; seam=none
  test("quality-check timeout after a save exits 3 with partial JSON", () => {
    const out = path.join(dir, "checked.png");
    const r = run(["generate", "--brief", "dashboard", "--output", out, "--check"], { CHECKS: "throw" });
    expect(r.status).toBe(3);
    expect(r.json.saved).toEqual([out]);
    expect(r.json.failures[0].reason).toContain("aborted");
  });

  // Value: protects=zero saved images exit 2 with JSON naming every failure; fails_when=all-fail exits 0 or prints nothing;
  //   why_new=skills route on this code; seam=none
  test("variants with zero successes exits 2 with JSON", () => {
    const outDir = path.join(dir, "designs");
    const r = run(["variants", "--brief", "dashboard", "--count", "2", "--output-dir", outDir], { IMAGES: "fail,fail" });
    expect(r.status).toBe(2);
    expect(r.json).toMatchObject({ requested: 2, saved: [], paths: [], errors: ["variant-A.png", "variant-B.png"] });
    expect(r.json.failures.map((f: any) => path.basename(f.file))).toEqual(["variant-A.png", "variant-B.png"]);
  });

  // Value: protects=a partial batch exits 0 and names the failed basename; fails_when=one failure fails the whole round;
  //   why_new=partial accounting is new; seam=none
  test("partial variants batch exits 0", () => {
    const outDir = path.join(dir, "designs");
    const r = run(["variants", "--brief", "dashboard", "--count", "2", "--output-dir", outDir], { IMAGES: "ok,fail" });
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ succeeded: 1, failed: 1, paths: [path.join(outDir, "variant-A.png")], errors: ["variant-B.png"] });
  });

  // Value: protects=an empty image from the API is a failure, never a 0-byte PNG; fails_when=persistImage writes empty bytes;
  //   why_new=CEO empty-b64 warning; seam=none
  test("empty image bytes exit 2 with no file", () => {
    const out = path.join(dir, "empty.png");
    const r = run(["generate", "--brief", "dashboard", "--output", out], { IMAGES: "empty" });
    expect(r.status).toBe(2);
    expect(fs.existsSync(out)).toBe(false);
    expect(r.json.failures[0].reason).toContain("empty image");
  });

  // Value: protects=a missing API key still prints the run JSON before exiting non-zero; fails_when=the key check exits the process directly;
  //   why_new=JSON on every exit path; seam=none
  test("missing API key prints JSON and exits 2", () => {
    const r = run(["evolve", "--screenshot", path.join(dir, "none.png"), "--brief", "calmer", "--output", path.join(dir, "e.png")], { OPENAI_API_KEY: "" });
    expect(r.status).toBe(2);
    expect(r.json.failures[0].reason).toContain("No image API key found (OpenAI or Gemini)");
    for (const key of [...RUN_FIELDS, "outputPath", "attempts"]) expect(r.json).toHaveProperty(key);
  });
});

describe("no re-purchase on a local save failure", () => {
  // Value: protects=a write failure after a paid response makes exactly one API call per variant and keeps a recovery copy;
  //   fails_when=the save sits inside the 429 retry loop again; why_new=Codex DX finding 1; seam=none
  test("variants (both branches): one API call, recovery copy, exit 2", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    for (const extra of [["--count", "1"], ["--viewports", "desktop"]]) {
      const before = apiCalls();
      const r = run(["variants", "--brief", "dashboard", ...extra, "--output-dir", path.join(blocker, "designs")]);
      expect(r.status).toBe(2);
      expect(apiCalls() - before).toBe(1);
      expect(r.stderr).not.toContain("Rate limited");
      expect(r.json.recovered).toHaveLength(1);
      expect(fs.existsSync(r.json.recovered[0].path)).toBe(true);
      expect(r.json.failures[0].reason).toContain("cannot save paid image to");
    }
  });

  // Value: protects=iterate makes one claim per run, and a save failure never triggers the fallback purchase;
  //   fails_when=the write moves back inside the threaded try; why_new=eng loop restructure; seam=none
  test("iterate: threaded failure claims once; save failure buys nothing more", () => {
    const gen = run(["generate", "--brief", "dashboard", "--output", path.join(dir, "base.png")]);
    const session = gen.json.sessionFile;
    const out = path.join(dir, "refined.png");

    const before = apiCalls();
    const fallback = run(["iterate", "--session", session, "--feedback", "bigger", "--output", out], { IMAGES: "ok,fail,ok" });
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(apiCalls() - before).toBe(2);
    expect(fallback.json.saved).toEqual([out]);
    expect(fs.readdirSync(dir).filter(f => f.startsWith("refined"))).toEqual(["refined.png"]);

    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "file");
    const mid = apiCalls();
    const failed = run(["iterate", "--session", session, "--feedback", "bigger", "--output", path.join(blocker, "x.png")]);
    expect(failed.status).toBe(2);
    expect(apiCalls() - mid).toBe(1);
    expect(failed.stderr).not.toContain("Falling back");
    expect(failed.json.recovered).toHaveLength(1);
    for (const key of [...RUN_FIELDS, "outputPath", "attempts", "sessionFile", "iteration"]) expect(failed.json).toHaveProperty(key);
  });
});
