import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

describe("release and CI hardening", () => {
  test("every workflow has explicit permissions and immutable action refs", () => {
    const workflowRoot = path.join(ROOT, ".github", "workflows");
    for (const name of fs.readdirSync(workflowRoot).filter((entry) => entry.endsWith(".yml"))) {
      const source = fs.readFileSync(path.join(workflowRoot, name), "utf8");
      expect(source, `${name} must declare top-level permissions`).toMatch(/^permissions:\s*$/m);
      expect(source, `${name} must declare workflow concurrency`).toMatch(/^concurrency:\s*$/m);
      for (const match of source.matchAll(/\buses:\s*[^\s@]+@([^\s#]+)/g)) {
        expect(match[1], `${name} contains a mutable action ref`).toMatch(/^[a-f0-9]{40}$/);
      }
    }
  });

  test("paid eval secrets cannot run against fork PR code", () => {
    const source = read(".github/workflows/evals.yml");
    const guard = "github.event.pull_request.head.repo.full_name == github.repository";
    expect(source.match(new RegExp(guard.replaceAll(".", "\\."), "g"))?.length).toBeGreaterThanOrEqual(3);
  });

  test("public dependency and repository security workflows stay enabled and least-privileged", () => {
    const dependencyReview = read(".github/workflows/dependency-review.yml");
    expect(dependencyReview).toContain("actions/dependency-review-action@");
    expect(dependencyReview).toContain("fail-on-severity: high");
    expect(dependencyReview).not.toContain("pull_request_target:");

    const osv = read(".github/workflows/osv-scanner.yml");
    expect(osv).toContain("google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@");
    expect(osv).toContain("security-events: write");
    expect(osv).toContain("schedule:");

    const scorecard = read(".github/workflows/scorecard.yml");
    expect(scorecard).toContain("ossf/scorecard-action@");
    expect(scorecard).toContain("github/codeql-action/upload-sarif@");
    expect(scorecard).toContain("publish_results: false");
    expect(scorecard).not.toContain("id-token: write");
  });

  test("npm package is an explicit small runtime-control surface", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe(read("VERSION").trim());
    expect(pkg.gstack).toEqual({ packageRole: "runtime-control", runtimeVersion: "2.0.0", skillApi: "2.0" });
    expect(pkg.bin).toEqual({
      gstack: "./bin/gstack",
      "gstack-runtime-bootstrap": "./runtime/runtime-bootstrap.mjs",
    });
    expect(pkg.files).toEqual(["bin/gstack", "runtime", "README.md", "LICENSE", "VERSION"]);
    expect(pkg.dependencies["puppeteer-core"]).toBeUndefined();
  });

  test("runtime identity is aligned independently of the legacy four-slot release counter", () => {
    for (const file of ["runtime/index.js", "runtime/install.js", "runtime/runtime-bootstrap.mjs"]) {
      expect(read(file), file).toContain('"2.0.0"');
    }
    expect(read("docs/gstack-2/RELEASE-INTEGRITY.md")).toContain("intentionally different namespaces");
  });

  test("release workflow emits all six signed byte-counted artifacts", () => {
    const workflow = read(".github/workflows/release-artifacts.yml");
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"]) {
      expect(workflow).toContain(`target: ${target}`);
    }
    expect(workflow).toContain("cosign sign-blob --yes --bundle");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).toContain("versions/current.json");
    expect(workflow).not.toContain('active="$GSTACK_HOME/versions/2.0.0"');
    expect(workflow).toContain(".gstack-runtime-browsers");
    expect(workflow).toContain('chromium.launch({ headless: true, channel: "chromium" })');
    expect(workflow).not.toContain("--with-deps");
    expect(workflow).toContain(".gstack-runtime-tools/bun");
    expect(workflow).toContain('"$GSTACK_HOME/bin/bun" --version');
    expect(workflow).toContain("BUN-LICENSE-1.3.14.md");
    expect(workflow).toContain("command -v bun");
    expect(workflow).toContain("GSTACK_NODE=\"$node_command\"");
    expect(workflow).toContain("goto about:blank");
    const manifest = read(".github/scripts/create-runtime-release-manifest.mjs");
    expect(manifest).toContain("bytes: stat.size");
    expect(manifest).toContain('certificateOidcIssuer: "https://token.actions.githubusercontent.com"');
  });

  test("redistributed Bun is pinned and carries the exact tagged license inventory", () => {
    const workflow = read(".github/workflows/release-artifacts.yml");
    expect(workflow).toContain("bun-version: 1.3.14");
    const license = read("runtime/licenses/BUN-LICENSE-1.3.14.md");
    expect(createHash("sha256").update(license).digest("hex"))
      .toBe("2cb858b2db8fc793bca2093489c5bc8eee615d002cc4924254904044c27a0afa");
    const source = read("runtime/licenses/BUN-SOURCE.md");
    expect(source).toContain("2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741");
    expect(source).toContain("bun-v1.3.14");
    const installer = read("runtime/install.js");
    expect(installer).toContain('entry("runtime")');
    expect(installer).toContain('entry(managedBunRelativePath(), "managed-bun", true)');
    const browser = read("browse/src/cli.ts");
    expect(browser).toContain("Every installed/compiled client must use the adjacent Node-compatible daemon");
    expect(browser).toContain("if (IS_COMPILED && !NODE_SERVER_SCRIPT)");
  });

  test("Windows setup lane installs, doctors, and uninstalls rather than only building", () => {
    const workflow = read(".github/workflows/windows-setup-e2e.yml");
    expect(workflow).toContain("--dry-run --capabilities browser");
    expect(workflow).toContain("--install-now --yes --capabilities browser");
    expect(workflow).toContain("doctor --json");
    expect(workflow).toContain("runtime/cli.js uninstall");
  });

  test("physical-iOS docs match the immutable five-iteration artifact", () => {
    const artifact = JSON.parse(read("docs/gstack-2/evidence/ios-physical-device-2026-07-20T17-49-19-302Z.json"));
    expect(artifact.passed).toBe(true);
    expect(artifact.requiredIterations).toBe(5);
    expect(artifact.passedIterations).toBe(5);
    expect(artifact.iterations).toHaveLength(5);
    expect(artifact.iterations.every((iteration: { passed: boolean }) => iteration.passed)).toBe(true);
    for (const file of ["STATUS.md", "TEST-EVIDENCE.md", "ARCHITECTURE.md", "HOST-COMPATIBILITY.md", "IOS-PHYSICAL-DEVICE.md"]) {
      expect(read(`docs/gstack-2/${file}`), file).toContain("ios-physical-device-2026-07-20T17-49-19-302Z.json");
    }
  });

  test("public-tool decisions stay inside the accepted architecture", () => {
    const adr = read("docs/gstack-2/adr/0001-public-infrastructure-tools.md");
    expect(adr).toContain("Vercel Agent Skills CLI");
    expect(adr).toContain("Sigstore Cosign");
    expect(adr).toContain("No cloud-browser provider");
  });

  test("unavailable governance/static gates are explicit rather than claimed green", () => {
    const policy = read("docs/gstack-2/RELEASE-INTEGRITY.md");
    expect(policy).toContain("not claimed by the current six-artifact release matrix");
    expect(policy).toContain("typecheck as not yet enforceable");
    expect(policy).toContain("No `CODEOWNERS` file is invented");
    expect(read(".github/workflows/quality-gate.yml")).toContain("gate-secret-scan.mjs");
  });
});
