/**
 * gstack-post executable against stub gh/glab (B4). The stubs record each
 * argv element and stdin byte for byte, proving the real spawn layer sends
 * values as arguments: shell metacharacters in the text never run, and a
 * title that looks like a flag arrives as one `--title=` element.
 * POSIX only (shebang stubs); test/gstack-post.test.ts covers the logic on
 * Windows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const POST = path.join(ROOT, "bin", "gstack-post");
let tmp = "";
let repo = "";
let stubs = "";
let state = "";
let gitEnv: Record<string, string> = {};

function stub(name: string) {
  const file = path.join(stubs, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash
log="$STUB_LOG/${name}.$(date +%s%N)"
for a in "$@"; do printf '%s\\0' "$a"; done > "$log.args"
cat > "$log.stdin"
case "$1 $2" in
  "repo view") echo "\${STUB_VISIBILITY:-PRIVATE}" ;;
  "pr view") cat "$STUB_LOG/title" 2>/dev/null ;;
  "pr edit") for a in "$@"; do case "$a" in --title=*) printf '%s\\n' "\${a#--title=}" > "$STUB_LOG/title" ;; esac; done ;;
  "pr create") echo "https://github.com/acme/widget/pull/77" ;;
esac
exit 0
`, { mode: 0o755 });
}

function calls(log: string, name: string) {
  return fs.readdirSync(log).filter(f => f.startsWith(name + ".") && f.endsWith(".args")).sort().map(f => ({
    args: fs.readFileSync(path.join(log, f), "utf8").split("\0").slice(0, -1),
    stdin: fs.readFileSync(path.join(log, f.replace(/\.args$/, ".stdin")), "utf8"),
  })).filter(c => c.args[1] !== "view");
}

function post(args: string[], extraEnv: Record<string, string> = {}) {
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const r = spawnSync(process.execPath, [POST, ...args], {
    cwd: repo, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ...gitEnv, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, STUB_LOG: log, GSTACK_STATE_ROOT: state, GSTACK_HOME: state, ...extraEnv },
  });
  return { ...r, log };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-post-cli-"));
  repo = path.join(tmp, "repo");
  stubs = path.join(tmp, "bin");
  state = path.join(tmp, "state");
  fs.mkdirSync(repo);
  fs.mkdirSync(stubs);
  fs.mkdirSync(state);
  // The fixture ignores the machine's git config: a global url.insteadOf
  // rewrite would change what `git remote get-url origin` reports.
  fs.writeFileSync(path.join(tmp, "gitconfig"), "");
  gitEnv = { GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, timeout: 10_000, env: { ...process.env, ...gitEnv } });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  git(["config", "user.email", "me@acme-corp.io"]);
  stub("gh");
  stub("glab");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, text: string) {
  const file = path.join(repo, name);
  fs.writeFileSync(file, text);
  return file;
}

describe("gstack-post executable", () => {
  test("body bytes arrive on stdin unchanged and nothing in them runs", () => {
    const body = "Fixed in `touch pwned-backtick`. $(touch pwned-subst) \"q\" 'single' \\ end\n";
    const r = post(["pr-comment", "12", "--body-file", write("body.md", body)]);
    expect(r.status).toBe(0);
    expect(calls(r.log, "gh")).toEqual([{ args: ["pr", "comment", "12", "--body-file=-"], stdin: body }]);
    expect(fs.existsSync(path.join(repo, "pwned-backtick"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "pwned-subst"))).toBe(false);
  });

  test("a title of --repo evil/x is one --title= argument and reads back", () => {
    const r = post(["pr-title", "7", "--title-file", write("title.txt", "--repo evil/x\n")]);
    expect(r.status).toBe(0);
    expect(calls(r.log, "gh")).toEqual([{ args: ["pr", "edit", "7", "--title=--repo evil/x"], stdin: "" }]);
  });

  test("pr-create prints the new URL", () => {
    const r = post(["pr-create", "--base", "main", "--draft", "--title-file", write("t2.txt", "v1.0.0 feat: x"), "--body-file", write("b2.md", "body")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://github.com/acme/widget/pull/77");
    expect(calls(r.log, "gh")[0]!.args).toEqual(["pr", "create", "--base=main", "--title=v1.0.0 feat: x", "--body-file=-", "--draft"]);
  });

  test("HIGH is refused and MEDIUM waits for its token, on a public repo", () => {
    const high = post(["pr-comment", "1", "--body-file", write("h.md", "key AKIA" + "1234567890ABCDEF\n")], { STUB_VISIBILITY: "PUBLIC" });
    expect(high.status).toBe(1);
    expect(calls(high.log, "gh")).toEqual([]);
    const file = write("m.md", "cc jane.roe@acme-corp.io\n");
    const medium = post(["pr-comment", "1", "--body-file", file], { STUB_VISIBILITY: "PUBLIC" });
    expect(medium.status).toBe(2);
    expect(medium.stdout).toContain("REPO_VISIBILITY: public");
    expect(medium.stdout).toContain("RULE: pii.email LINE: 1 PART: body");
    expect(calls(medium.log, "gh")).toEqual([]);
    const t = /^TOKEN: (\S+)$/m.exec(medium.stdout)![1]!;
    fs.writeFileSync(file, "cc john.doe@acme-corp.io\n");
    const changed = post(["pr-comment", "1", "--body-file", file, "--confirm", t], { STUB_VISIBILITY: "PUBLIC" });
    expect(changed.status).toBe(2);
    expect(calls(changed.log, "gh")).toEqual([]);
    const t2 = /^TOKEN: (\S+)$/m.exec(changed.stdout)![1]!;
    const sent = post(["pr-comment", "1", "--body-file", file, "--confirm", t2], { STUB_VISIBILITY: "PUBLIC" });
    expect(sent.status).toBe(0);
    expect(calls(sent.log, "gh")).toEqual([{ args: ["pr", "comment", "1", "--body-file=-"], stdin: "cc john.doe@acme-corp.io\n" }]);
  });

  test("GitLab sends the body as one --description= argument", () => {
    const body = "multi\nline $(id)\n";
    const r = post(["pr-body", "4", "--host", "gitlab", "--body-file", write("g.md", body)], { STUB_VISIBILITY: "" });
    expect(r.status).toBe(0);
    expect(calls(r.log, "glab")).toEqual([{ args: ["mr", "update", "4", `--description=${body}`], stdin: "" }]);
  });
});
