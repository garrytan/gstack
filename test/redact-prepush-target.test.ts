import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scan } from "../lib/redact-engine";

const REDACT = path.resolve(import.meta.dir, "../bin/gstack-redact");
const roots: string[] = [];
const key = ["AKIA", "1234567890ABCDEF"].join("");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(initialSecret = true, sha256 = false): { repo: string; origin: string; publish: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-target-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const publish = path.join(root, "publish.git");
  fs.mkdirSync(repo);
  const format = sha256 ? ["--object-format=sha256"] : [];
  git(root, "init", "--bare", "-q", "-b", "main", ...format, origin);
  git(root, "init", "--bare", "-q", "-b", "main", ...format, publish);
  git(repo, "init", "-q", "-b", "main", ...format);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.test");
  fs.writeFileSync(path.join(repo, "config.txt"), initialSecret ? `key ${key}\n` : "clean\n");
  git(repo, "add", "config.txt");
  git(repo, "commit", "-qm", "seed");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "add", "publish", publish);
  const install = spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  expect(install.status).toBe(0);
  return { repo, origin, publish, head };
}

function seedIndependentRemote(repo: string, publish: string): string {
  const producer = path.join(path.dirname(repo), "producer");
  fs.mkdirSync(producer);
  git(producer, "init", "-q", "-b", "main");
  git(producer, "config", "user.name", "Fixture");
  git(producer, "config", "user.email", "fixture@example.test");
  fs.writeFileSync(path.join(producer, "clean.txt"), "different history\n");
  git(producer, "add", "clean.txt");
  git(producer, "commit", "-qm", "remote tip");
  git(producer, "remote", "add", "publish", publish);
  git(producer, "push", "-q", "publish", "main");
  return git(publish, "rev-parse", "refs/heads/main");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("installed pre-push guard uses the actual destination", () => {
  test("origin tracking at HEAD cannot excuse the same credential on first push to publish", () => {
    const { repo, publish, head } = fixture();
    expect(git(repo, "rev-parse", "origin/main")).toBe(head);
    const push = spawnSync("git", ["push", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(publish, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  test("a configured remote's different push URL cannot reuse its fetch tracking tip", () => {
    const { repo, publish } = fixture();
    git(repo, "remote", "set-url", "--push", "origin", publish);
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(publish, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  for (const [name, symbolicHead] of [
    ["a local branch cannot shadow the target's qualified remote-tracking base", true],
    ["the main fallback cannot resolve to a colliding local branch", false],
  ] as const) {
    test(name, () => {
      const { repo, publish, head: base } = fixture(false);
      fs.writeFileSync(path.join(repo, "leak.txt"), `key ${key}\n`);
      git(repo, "add", "leak.txt");
      git(repo, "commit", "-qm", "secret after target base");
      const tip = git(repo, "rev-parse", "HEAD");
      git(repo, "update-ref", "refs/remotes/publish/main", base);
      if (symbolicHead) git(repo, "symbolic-ref", "refs/remotes/publish/HEAD", "refs/remotes/publish/main");
      git(repo, "update-ref", "refs/heads/publish/main", tip);
      expect(git(repo, "rev-parse", "publish/main")).toBe(tip);
      expect(git(repo, "rev-parse", "refs/remotes/publish/main")).toBe(base);
      const push = spawnSync("git", ["push", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
      expect(push.status).toBe(1);
      expect(push.stderr).toContain("aws.access_key");
      expect(git(publish, "for-each-ref", "--format=%(refname)")).toBe("");
    });
  }

  test("the second fetch URL is not represented by the first URL's tracking ref", () => {
    const { repo, origin, publish } = fixture();
    const second = path.join(path.dirname(repo), "second.git");
    git(path.dirname(repo), "init", "--bare", "-q", "-b", "main", second);
    git(publish, "fetch", "-q", origin, "main:refs/heads/main");
    git(repo, "fetch", "-q", "publish");
    expect(git(repo, "rev-parse", "refs/remotes/publish/main")).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "remote", "set-url", "--add", "publish", second);
    expect(git(repo, "remote", "get-url", "publish")).toBe(publish);
    const push = spawnSync("git", ["push", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(second, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  test("direct URL push cannot borrow origin's tracking history", () => {
    const { repo, publish } = fixture();
    const push = spawnSync("git", ["push", publish, "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(publish, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  test("an advertised remote tip absent from local objects cannot justify a guessed base", () => {
    const { repo, publish } = fixture();
    const remoteTip = seedIndependentRemote(repo, publish);
    expect(spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: repo, timeout: 30_000 }).status).not.toBe(0);
    const push = spawnSync("git", ["push", "--force", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(publish, "rev-parse", "refs/heads/main")).toBe(remoteTip);
  });

  test("an absent advertised tip permits a clean forced update after conservative scanning", () => {
    const { repo, publish, head } = fixture(false);
    const remoteTip = seedIndependentRemote(repo, publish);
    expect(spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: repo, timeout: 30_000 }).status).not.toBe(0);
    const push = spawnSync("git", ["push", "--force", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(git(publish, "rev-parse", "refs/heads/main")).toBe(head);
  });

  test("new SHA-256 branch scans the correct empty tree and allows a clean push", () => {
    const { repo, publish } = fixture(false, true);
    const push = spawnSync("git", ["push", "publish", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(git(publish, "rev-parse", "refs/heads/main")).toHaveLength(64);
    fs.writeFileSync(path.join(repo, "leak.txt"), `key ${key}\n`);
    git(repo, "add", "leak.txt");
    git(repo, "commit", "-qm", "new secret");
    const blocked = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("aws.access_key");
  });

  test("one leaky ref blocks a multi-ref push without updating its clean neighbor", () => {
    const { repo, origin, head } = fixture(false);
    git(repo, "checkout", "-q", "-b", "leak");
    fs.writeFileSync(path.join(repo, "leak.txt"), `key ${key}\n`);
    git(repo, "add", "leak.txt");
    git(repo, "commit", "-qm", "leaky branch");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "clean.txt"), "safe update\n");
    git(repo, "add", "clean.txt");
    git(repo, "commit", "-qm", "clean branch");
    const push = spawnSync("git", ["push", "origin", "main", "leak"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/leak")).toBe("");
  });

  test("a deleted ref alongside a clean update is permitted", () => {
    const { repo, origin } = fixture(false);
    git(repo, "checkout", "-q", "-b", "disposable");
    fs.writeFileSync(path.join(repo, "disposable.txt"), "safe\n");
    git(repo, "add", "disposable.txt");
    git(repo, "commit", "-qm", "temporary branch");
    git(repo, "push", "-q", "origin", "disposable");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "clean.txt"), "safe update\n");
    git(repo, "add", "clean.txt");
    git(repo, "commit", "-qm", "clean update");
    const head = git(repo, "rev-parse", "HEAD");
    const push = spawnSync("git", ["push", "origin", "main", ":disposable"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/disposable")).toBe("");
  });

  test("installed wrapper forwards refs and rejects malformed input instead of passing it on", () => {
    const { repo, origin, head } = fixture(false);
    const hook = git(repo, "rev-parse", "--git-path", "hooks/pre-push");
    const result = spawnSync("bash", [hook, "origin", origin], {
      cwd: repo, input: "refs/heads/main malformed\n", encoding: "utf8", timeout: 30_000,
    });
    expect(result.status, result.stderr || result.error?.message).toBe(1);
    expect(result.stderr).toContain("could not parse a pre-push ref line");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
  });

  test("a HIGH proximity finding across line-aligned scan slices cannot pass", () => {
    const { repo } = fixture(false);
    const value = ["AbCdEfGhIjKlMnOpQrStU", "vWxYz0123456789AbCd"].join("");
    const payload = `${"x".repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${value}\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).toContain("aws.secret_key");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "near seam");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.secret_key");
  });

  test("an unlabeled high-entropy value near a seam stays clean", () => {
    const { repo } = fixture(false);
    const value = ["AbCdEfGhIjKlMnOpQrStU", "vWxYz0123456789AbCd"].join("");
    const payload = `${"x".repeat(768 * 1024 - 43)}\nordinary description\n${value}\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).not.toContain("aws.secret_key");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "unlabeled seam");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(push.stderr).not.toContain("aws.secret_key");
  });

  test("overlap does not count a single finding twice", () => {
    const { repo } = fixture(false);
    const payload = `${"x".repeat(768 * 1024 - 75)}\nkey ${key}\n${"x".repeat(100)}\n`;
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "one finding at seam");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr.match(/HIGH  aws\.access_key/g)).toHaveLength(1);
  });

  test("supplementary NFKC expansion cannot move a seam finding out of its owning core", () => {
    const { repo, origin, head } = fixture(false);
    const prefix = "\uFA6C".repeat(64);
    const credential = `key ${key}\n`;
    const padding = "x".repeat(768 * 1024 - Buffer.byteLength(prefix) - credential.length - 1);
    const payload = `${prefix}${padding}\n${credential}${"z".repeat(100)}\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).toContain("aws.access_key");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "supplementary normalization seam");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr.match(/HIGH  aws\.access_key/g)).toHaveLength(1);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
  });

  test("a partial-line overlap cannot manufacture an anchored assignment finding", () => {
    const { repo } = fixture(false);
    const value = ["8Fk2pQ9vXz4wL7mN", "3rT6yB1cD5eG0hJq"].join("");
    const assignment = `API_KEY=${value} `;
    const suffix = "z".repeat(16 * 1024 - assignment.length - 6);
    const first = "!" + "x".repeat(768 * 1024 - 61 - assignment.length - suffix.length) + assignment + suffix;
    const payload = `${first}\nshort\n${"z".repeat(100)}\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).not.toContain("env.kv");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "mid-line control");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(push.stderr).not.toContain("MEDIUM finding");
  });

  test("mid-line carry cannot create a HIGH word boundary around an embedded key", () => {
    const { repo, origin, head } = fixture(false);
    const first = "x".repeat(768 * 1024 - 1 - 16_384) + key + " ".repeat(16_384 - key.length);
    const payload = `${first}\nordinary\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).not.toContain("aws.access_key");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "embedded key control");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(push.stderr).not.toContain("aws.access_key");
    expect(git(origin, "rev-parse", "refs/heads/main")).not.toBe(head);
  });

  test("a long Bearer span retains its later Authorization context across the seam", () => {
    const { repo, origin } = fixture(false);
    const alphabet = "7pFb4ZaCuG8wDsVk2EnHy6Qt9Jr5Lx0M";
    const token = Array.from({ length: 20_480 }, (_, i) => alphabet[(i * 7 + Math.floor(i / 31)) % 32]).join("");
    const bearerLine = `Bearer ${token}`;
    const payload = `${"x".repeat(768 * 1024 - bearerLine.length - 2)}\n${bearerLine}\nAuthorization\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).toContain("auth.bearer");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "long bearer advisory");
    const tip = git(repo, "rev-parse", "HEAD");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(push.stderr).toContain("MEDIUM finding");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(tip);
  });

  test("zero-width padding cannot move normalized proximity context out of the overlap", () => {
    const { repo } = fixture(false);
    const value = ["AbCdEfGhIjKlMnOpQrStU", "vWxYz0123456789AbCd"].join("");
    const payload = `${"x".repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${"\u200b".repeat(35_000)}\n${value}\n`;
    expect(scan(payload).findings.map((finding) => finding.id)).toContain("aws.secret_key");
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "invisible seam");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.secret_key");
  });

  test("context needing more than the engine byte cap blocks instead of scanning a truncated window", () => {
    const { repo, origin, head } = fixture(false);
    const value = ["AbCdEfGhIjKlMnOpQrStU", "vWxYz0123456789AbCd"].join("");
    const payload = `${"x".repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${"\u200b".repeat(450_000)}\n${value}\n`;
    fs.writeFileSync(path.join(repo, "payload.txt"), payload);
    git(repo, "add", "payload.txt");
    git(repo, "commit", "-qm", "unscannable context");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("engine.input_too_large");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
  });

  for (const [name, label, expected] of [
    ["HTML entity", "aws&amp;secret_access_key=", true],
    ["fullwidth Unicode", "aws＿secret_access_key=", true],
    ["broken entity separated by zero-width", "aws&\u200bamp;secret_access_key=", false],
  ] as const) {
    test(`${name} near a seam keeps the detector's exact normalization semantics`, () => {
      const { repo } = fixture(false);
      const value = ["AbCdEfGhIjKlMnOpQrStU", "vWxYz0123456789AbCd"].join("");
      const payload = `${"x".repeat(768 * 1024 - 43)}\n${label}\n${value}\n`;
      expect(scan(payload).findings.some((finding) => finding.id === "aws.secret_key")).toBe(expected);
      fs.writeFileSync(path.join(repo, "payload.txt"), payload);
      git(repo, "add", "payload.txt");
      git(repo, "commit", "-qm", "normalization seam");
      const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
      expect(push.status).toBe(expected ? 1 : 0);
      expect(push.stderr.includes("aws.secret_key")).toBe(expected);
    });
  }

  test("a large clean diff and a sub-cap long line pass, while an over-cap line fails closed", () => {
    const { repo, origin, head } = fixture(false);
    fs.writeFileSync(path.join(repo, "large.txt"), "ordinary content\n".repeat(160_000));
    git(repo, "add", "large.txt");
    git(repo, "commit", "-qm", "large clean diff");
    let push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
    expect(push.status).toBe(0);
    fs.writeFileSync(path.join(repo, "long.txt"), "x".repeat(900_000) + "\n");
    git(repo, "add", "long.txt");
    git(repo, "commit", "-qm", "long clean line");
    push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
    expect(push.status).toBe(0);
    const priorTip = git(origin, "rev-parse", "refs/heads/main");
    expect(priorTip).not.toBe(head);
    fs.writeFileSync(path.join(repo, "too-long.txt"), "x".repeat(1_100_000) + "\n");
    git(repo, "add", "too-long.txt");
    git(repo, "commit", "-qm", "over cap line");
    push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("engine.input_too_large");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(priorTip);
  });

  test("a detectable credential at the end of a long single line is still blocked", () => {
    const { repo, origin, head } = fixture(false);
    fs.writeFileSync(path.join(repo, "long.txt"), `${"x".repeat(900_000)} key ${key}\n`);
    git(repo, "add", "long.txt");
    git(repo, "commit", "-qm", "long line with key");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("aws.access_key");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
  });

  test("neighboring individually scannable long clean lines do not force an oversize failure", () => {
    const { repo, origin } = fixture(false);
    fs.writeFileSync(path.join(repo, "long.txt"), `${"x".repeat(900_000)}\n${"y".repeat(900_000)}\n`);
    git(repo, "add", "long.txt");
    git(repo, "commit", "-qm", "neighboring long lines");
    const tip = git(repo, "rev-parse", "HEAD");
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(push.status).toBe(0);
    expect(push.stderr).not.toContain("engine.input_too_large");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(tip);
  });
});
