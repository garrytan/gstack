import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const RUNNER = path.join(ROOT, "bin", "gstack-run-migrations");
const SETUP = path.join(ROOT, "setup");
const UPGRADE_SKILL_TEMPLATE = path.join(ROOT, "gstack-upgrade", "SKILL.md.tmpl");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function run(root: string, home: string, from: string, to: string, options: { bashEnv?: string } = {}) {
  return Bun.spawnSync({
    cmd: ["bash", RUNNER, "--root", root, "--from", from, "--to", to],
    env: { ...process.env, HOME: home, BASH_ENV: options.bashEnv ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gstack-run-migrations", () => {
  test("setup delegates existing-install migrations to the shared runner, including same-version retries", () => {
    const setup = fs.readFileSync(SETUP, "utf8");
    const upgradeSkill = fs.readFileSync(UPGRADE_SKILL_TEMPLATE, "utf8");
    const runner = fs.readFileSync(RUNNER, "utf8");

    expect(setup).toContain('MIGRATION_RUNNER="$SOURCE_GSTACK_DIR/bin/gstack-run-migrations"');
    expect(setup).toContain('&& [ -f "$HOME/.gstack/.last-setup-version" ]');
    expect(setup).toContain('bash "$MIGRATION_RUNNER" --root "$SOURCE_GSTACK_DIR" --from "$LAST_SETUP_VERSION" --to "$CURRENT_VERSION"');
    expect(setup).not.toContain('find "$MIGRATIONS_DIR" -maxdepth 1 -name \'v*.sh\'');
    expect(upgradeSkill).toContain('`./setup` is the single migration dispatcher');
    expect(upgradeSkill).not.toContain('MIGRATIONS_DIR="$INSTALL_DIR/gstack-upgrade/migrations"');
    expect(runner).not.toContain("declare -A");
  });

  test("retries a manifest-listed migration on a later same-version setup when its done marker is absent", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    fs.mkdirSync(migrations, { recursive: true });
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });

    fs.writeFileSync(
      path.join(migrations, "retry-until-done.txt"),
      "v1.61.0.1.sh\n",
    );
    writeExecutable(
      path.join(migrations, "v1.61.0.1.sh"),
      "#!/usr/bin/env bash\nprintf 'attempt\\n' >> \"$HOME/.gstack/migration-attempts\"\n",
    );

    const first = run(root, home, "1.61.0.0", "1.61.0.1");
    expect(first.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, ".gstack", "migration-attempts"), "utf8"))
      .toBe("attempt\n");

    const second = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(second.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, ".gstack", "migration-attempts"), "utf8"))
      .toBe("attempt\nattempt\n");
  });

  test("skips a retryable migration after its completion marker exists", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    fs.mkdirSync(path.join(home, ".gstack", ".migrations"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });

    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "v1.61.0.1.sh\n");
    writeExecutable(
      path.join(migrations, "v1.61.0.1.sh"),
      "#!/usr/bin/env bash\nprintf 'unexpected\\n' >> \"$HOME/.gstack/migration-attempts\"\n",
    );
    fs.writeFileSync(path.join(home, ".gstack", ".migrations", "v1.61.0.1.done"), "");

    const result = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".gstack", "migration-attempts"))).toBe(false);
  });

  test("does not rerun an unlisted historical migration merely because it has no marker", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });

    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "v1.61.0.1.sh\n");
    writeExecutable(
      path.join(migrations, "v1.40.0.0.sh"),
      "#!/usr/bin/env bash\nprintf 'legacy\\n' >> \"$HOME/.gstack/migration-attempts\"\n",
    );
    writeExecutable(
      path.join(migrations, "v1.61.0.1.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );

    const result = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".gstack", "migration-attempts"))).toBe(false);
  });

  test("ignores an invalid manifest entry instead of executing a path outside migrations", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    const outside = path.join(root, "outside.sh");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });

    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "../outside.sh\n");
    writeExecutable(
      outside,
      "#!/usr/bin/env bash\nprintf 'outside\\n' >> \"$HOME/.gstack/migration-attempts\"\n",
    );

    const result = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".gstack", "migration-attempts"))).toBe(false);
    expect(new TextDecoder().decode(result.stderr)).toContain("invalid retryable migration entry");
  });

  test("rejects a valid-looking manifest symlink that resolves outside migrations", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    const outside = path.join(root, "outside.sh");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "v1.61.0.1.sh\n");
    writeExecutable(outside, "#!/usr/bin/env bash\nprintf 'outside\\n' >> \"$HOME/.gstack/migration-attempts\"\n");
    fs.symlinkSync(outside, path.join(migrations, "v1.61.0.1.sh"), "file");

    const result = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".gstack", "migration-attempts"))).toBe(false);
    expect(new TextDecoder().decode(result.stderr)).toContain("symlink retryable migration ignored");
  });

  test("runs a missing-marker retry from an earlier version during a later upgrade", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "v1.61.0.1.sh\n");
    writeExecutable(path.join(migrations, "v1.61.0.1.sh"), "#!/usr/bin/env bash\nprintf 'retry\\n' >> \"$HOME/.gstack/migration-attempts\"\n");

    const result = run(root, home, "1.61.0.1", "1.62.0.0");
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, ".gstack", "migration-attempts"), "utf8")).toBe("retry\n");
  });

  test("runs a duplicate manifest entry only once per dispatcher invocation", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "retry-until-done.txt"), "v1.61.0.1.sh\nv1.61.0.1.sh\n");
    writeExecutable(path.join(migrations, "v1.61.0.1.sh"), "#!/usr/bin/env bash\nprintf 'once\\n' >> \"$HOME/.gstack/migration-attempts\"\n");

    const result = run(root, home, "1.61.0.1", "1.61.0.1");
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, ".gstack", "migration-attempts"), "utf8")).toBe("once\n");
  });

  test("orders dotted-integer normal migrations without sort -V", () => {
    const root = makeTempDir("gstack-migration-root-");
    const home = makeTempDir("gstack-migration-home-");
    const migrations = path.join(root, "gstack-upgrade", "migrations");
    const envDir = makeTempDir("gstack-failing-sort-");
    const bashEnv = path.join(envDir, "bash-env");
    fs.mkdirSync(path.join(home, ".gstack"), { recursive: true });
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(bashEnv, "sort() { return 99; }\n");
    writeExecutable(path.join(migrations, "v1.9.0.0.sh"), "#!/usr/bin/env bash\nprintf '1.9\\n' >> \"$HOME/.gstack/migration-attempts\"\n");
    writeExecutable(path.join(migrations, "v1.10.0.0.sh"), "#!/usr/bin/env bash\nprintf '1.10\\n' >> \"$HOME/.gstack/migration-attempts\"\n");

    const preflight = Bun.spawnSync({
      cmd: ["bash", "-c", "type -t sort"],
      env: { ...process.env, BASH_ENV: bashEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(preflight.exitCode).toBe(0);
    expect(new TextDecoder().decode(preflight.stdout).trim()).toBe("function");

    const result = run(root, home, "1.8.0.0", "1.10.0.0", { bashEnv });
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(home, ".gstack", "migration-attempts"), "utf8")).toBe("1.9\n1.10\n");
  });
});
