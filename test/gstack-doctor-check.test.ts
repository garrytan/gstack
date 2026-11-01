// Split from test/gstack-doctor.test.ts: the `gstack-doctor --check` verdict rows, trailer and JSON.
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { useDoctorCleanup, REPO, BROWSE_BIN, EXE, write, script, bashPath, probeCalls, makeFixture, doctor, type Fixture } from './helpers/doctor-fixture';

useDoctorCleanup();

// A1: `--check` is the one-line verdict a parent agent greps. Rows are
// `PASS | FAIL | SKIP <id>` from lib/doctor-components.ts; the trailer is
// `gstack: ok <revision> for=<what>` (exit 0) or `gstack: fail <ids>` (exit 1).
// Pinned on tokens, ids, exit codes and the JSON shape, not prose.
describe('gstack-doctor --check', () => {
  const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  const row = (f: Fixture, args: string[], extra: Record<string, string> = {}) => {
    const r = doctor(f, ['--check', ...args], extra);
    const lines = r.out.split('\n');
    const rows = Object.fromEntries(lines.filter(l => /^(PASS|FAIL|SKIP|WARN) /.test(l)).map(l => {
      const m = l.match(/^(PASS|FAIL|SKIP|WARN) ([a-z-]+)(?:\s(.*))?$/)!;
      return [m[2], { status: m[1], rest: m[3] ?? '' }];
    }));
    const trailer = lines.filter(l => l.startsWith('gstack: ')).at(-1) ?? '';
    const required = lines.find(l => l.startsWith('required: '))?.slice(10).split(' ') ?? [];
    return { status: r.status, out: r.out, rows, trailer, required, trailers: lines.filter(l => l.startsWith('gstack: ')).length };
  };
  /** Register a Codex install from this checkout and render a review skill, with or without the Astra patch. */
  const installCodex = (f: Fixture, patch = true) => {
    const dest = path.join(f.home, '.codex/skills');
    fs.appendFileSync(path.join(f.state, 'installs.tsv'),
      ['codex', 'global', '-', dest, path.join(dest, 'gstack'), f.root, VERSION, 'true', 'committed', '2026-10-07T00:00:00Z'].join('\t') + '\n');
    fs.mkdirSync(path.join(dest, 'gstack'), { recursive: true });
    write(path.join(dest, 'gstack-review/SKILL.md'), `---\nname: gstack-review\n---\n# Review\n${patch ? '\n## Model-Specific Behavioral Patch (gpt-6-astra)\n' : ''}`);
    return dest;
  };
  const installPlaywrightStub = (f: Fixture, launches: boolean) => write(path.join(f.root, 'node_modules/playwright/index.js'),
    launches
      ? 'module.exports.chromium = { launch: async () => ({ version: () => "141.0.1", close: async () => {}, newPage: async () => ({ setContent: async () => {}, title: async () => "gstack smoke test" }) }) };'
      : 'module.exports.chromium = { launch: async () => { throw new Error("browserType.launch: Executable doesn\'t exist"); } };');

  test('healthy Claude + Codex installs: every required row PASS, exactly one trailer, exit 0, no paid probe', () => {
    const f = makeFixture();
    installCodex(f);
    const r = row(f, []);
    expect(r.status, r.out).toBe(0);
    expect(r.required).toEqual(['claude', 'codex', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    for (const id of r.required.filter(x => x !== 'pins' && x !== 'floor' && x !== 'wrapper')) expect(r.rows[id]?.status, `${id}\n${r.out}`).toBe('PASS');
    // The work dir is not a git repository, so there is no project to read pins or a floor from: SKIP with the reason, never silent.
    expect(r.rows.pins).toEqual({ status: 'SKIP', rest: expect.stringContaining('no project') });
    expect(r.rows.floor).toEqual({ status: 'SKIP', rest: expect.stringContaining('no project to read .gstack/ship-policy.json from') });
    // No ~/.capy/drive skill copy and no active wrapper: not a Capy machine.
    expect(r.rows.wrapper).toEqual({ status: 'SKIP', rest: expect.stringContaining('not a Capy machine') });
    expect(r.rows.patch.status).toBe('PASS');
    expect(r.rows['codex-cli'].status).toBe('PASS');
    expect(r.rows.browser).toEqual({ status: 'SKIP', rest: '(lazy; gstack-browser-ensure installs on first use)' });
    expect(r.rows.cso.status).toBe('SKIP');
    expect(r.trailer).toBe(`gstack: ok ${VERSION} for=installed-hosts:claude,codex`);
    expect(r.trailers).toBe(1);
    expect(r.rows.runtime.rest).toContain('floor 1.3.3, supported minimum 1.4.2');
    expect(r.rows.privacy.rest).toBe('telemetry=off artifacts_sync=off codex_reviews=enabled update_check=true');
    expect(r.rows['state-root'].rest).toContain('durable=yes');
    expect(probeCalls(f)).not.toContain('probe-model');
  });

  // Value: protects=the --check state-root row names the variable that selected the root, after earlier rows read config;
  //   fails_when=an in-process config read reselects the root from the doctor's own GSTACK_STATE_ROOT;
  //   why_new=every other fixture sets GSTACK_STATE_ROOT itself, so a wrong "selected by" still reads GSTACK_STATE_ROOT; seam=none;
  //   no_claim=CLAUDE_PLUGIN_DATA and default selection (GSTACK_HOME stands in for every selector other than GSTACK_STATE_ROOT)
  test('the state-root row names GSTACK_HOME when GSTACK_HOME selected the root, in text and JSON', () => {
    const f = makeFixture();
    installCodex(f);
    const byHome = { GSTACK_STATE_ROOT: '', GSTACK_HOME: f.state };
    const r = row(f, [], byHome);
    expect(r.rows['state-root'].rest, r.out).toContain('(selected by GSTACK_HOME;');
    const json = JSON.parse(doctor(f, ['--json'], byHome).out);
    expect(json.rows.find((x: { id: string }) => x.id === 'state-root').detail).toContain('(selected by GSTACK_HOME;');
  });

  test('--for autoplan: healthy Capy machine with Claude subagents as the outside voice and no Codex CLI passes', () => {
    const f = makeFixture();
    installCodex(f);
    fs.rmSync(path.join(f.stub, 'codex'));
    const r = row(f, ['--for', 'autoplan']);
    expect(r.status, r.out).toBe(0);
    expect(r.required).toEqual(['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    expect(r.rows.patch).toEqual({ status: 'PASS', rest: 'gpt-6-astra (gstack-review/SKILL.md)' });
    expect(r.rows['codex-cli'].status).toBe('SKIP');
    expect(r.rows['codex-cli'].rest).toContain('optional');
    expect(r.trailer).toBe(`gstack: ok ${VERSION} for=autoplan`);
    // The same machine with a stale Codex render fails the patch row.
    installCodex(f, false);
    const noPatch = row(f, ['--for', 'autoplan']);
    expect(noPatch.status).toBe(1);
    expect(noPatch.rows.patch.status).toBe('FAIL');
    expect(noPatch.rows.patch.rest).toContain('fix: ');
    expect(noPatch.rows.patch.rest).toContain('(COMPONENT_MISSING; ');
    expect(noPatch.rows.patch.rest).toContain('--host codex --model');
    expect(noPatch.trailer).toBe('gstack: fail patch');
  });

  test('--for autoplan: a hoisted Codex render carries the patch in its shared sections/preamble.md', () => {
    const f = makeFixture();
    const dest = installCodex(f, false);
    write(path.join(dest, 'gstack-review/sections/preamble.md'), '# gstack shared preamble 0123456789ab\n\n## Model-Specific Behavioral Patch (gpt-6-astra)\n');
    const r = row(f, ['--for', 'autoplan']);
    expect(r.rows.patch, r.out).toEqual({ status: 'PASS', rest: 'gpt-6-astra (gstack-review/sections/preamble.md)' });
  });

  test('an empty installed-host set is never ok: claude is required and FAILs', () => {
    const f = makeFixture();
    write(path.join(f.state, 'installs.tsv'), '');
    const r = row(f, []);
    expect(r.status).toBe(1);
    expect(r.required).toContain('claude');
    expect(r.rows.claude.status).toBe('FAIL');
    expect(r.rows.claude.rest).toContain(`fix: cd ${bashPath(f.root)} && ./setup --host claude --no-prefix`);
    expect(r.trailer).toBe('gstack: fail claude');
    expect(JSON.parse(doctor(f, ['--json']).out).for).toBe('installed-hosts:none(claude required)');
  });

  test('wrong host: an install registered from another checkout does not count; --require names what is missing', () => {
    const f = makeFixture();
    const other = path.join(f.base, 'other');
    write(path.join(f.state, 'installs.tsv'), ['codex', 'global', '-', path.join(f.home, '.codex/skills'), other, other, VERSION, 'false', 'committed', 'x'].join('\t') + '\n');
    const r = row(f, ['--require', 'codex,patch']);
    expect(r.status).toBe(1);
    expect(r.rows.codex.status).toBe('FAIL');
    expect(r.rows.patch.status).toBe('FAIL');
    expect(r.rows.claude.status).toBe('SKIP');
    expect(r.trailer).toBe('gstack: fail codex,patch');
    expect(JSON.parse(doctor(f, ['--json', '--require', 'codex,patch']).out).for).toBe('codex,patch');
  });

  test('missing authentication: --for codex needs the CLI; absent, unauthenticated and present are told apart, --live probes once', () => {
    const f = makeFixture();
    installCodex(f);
    const unauthed = row(f, ['--for', 'codex'], { STUB_AUTH_FAIL: '1' });
    expect(unauthed.status).toBe(1);
    expect(unauthed.rows['codex-cli'].status).toBe('FAIL');
    expect(unauthed.rows['codex-cli'].rest).toContain('not authenticated');
    expect(unauthed.rows['codex-cli'].rest).toContain('codex login --with-api-key');
    expect(unauthed.trailer).toBe('gstack: fail codex-cli');

    const authed = row(f, ['--for', 'codex']);
    expect(authed.status, authed.out).toBe(0);
    expect(authed.rows['codex-cli'].rest).toContain('paid probe not run; add --live');
    expect(probeCalls(f)).not.toContain('probe-model');

    const live = row(f, ['--for', 'codex', '--live']);
    expect(live.status, live.out).toBe(0);
    expect(live.rows['codex-cli'].rest).toContain('live probe ok');
    expect(probeCalls(f).match(/probe-model exec/g)?.length).toBe(1);

    fs.rmSync(path.join(f.stub, 'codex'));
    const absent = row(f, ['--for', 'codex']);
    expect(absent.rows['codex-cli'].status).toBe('FAIL');
    expect(absent.rows['codex-cli'].rest).toContain('npm install -g @openai/codex');
  });

  test('runtime mismatch: the supported minimum (1.4.2) and the floor (1.3.3) both FAIL in --check', () => {
    const f = makeFixture();
    const untested = row(f, [], { STUB_BUN_VERSION: '1.3.14' });
    expect(untested.status).toBe(1);
    expect(untested.rows.runtime.status).toBe('FAIL');
    expect(untested.rows.runtime.rest).toContain('below the supported minimum 1.4.2');
    expect(untested.rows.runtime.rest).toContain('(RUNTIME_BELOW_MINIMUM; ');
    expect(untested.trailer).toBe('gstack: fail runtime');
    const old = row(f, [], { STUB_BUN_VERSION: '1.3.2' });
    expect(old.rows.runtime.rest).toContain('below the security floor 1.3.3');
    expect(old.trailer).toBe('gstack: fail runtime');
  });

  test('bun removed from PATH: the doctor still reports, runtime FAILs, pins SKIPs with a reason, one trailer', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.stub, 'bun'));
    const r = row(f, []);
    expect(r.status).toBe(1);
    expect(r.rows.runtime.status).toBe('FAIL');
    expect(r.rows.runtime.rest).toContain('bun not found on PATH');
    expect(r.rows.pins).toEqual({ status: 'SKIP', rest: expect.stringContaining('no bun to evaluate the project pins') });
    expect(r.rows.claude.status).toBe('PASS');
    expect(r.trailer).toBe('gstack: fail runtime');
    expect(r.trailers).toBe(1);
  });

  test('project pins: --project reads the target repository, a range mismatch FAILs with its source, a match PASSes', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const bad = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14' });
    expect(bad.rows.pins.status).toBe('FAIL');
    expect(bad.rows.pins.rest).toContain('bun 1.3.14 outside engines.bun >=1.4.2 (package.json:3)');
    expect(bad.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    expect(bad.trailer).toBe('gstack: fail runtime,pins');
    const good = row(f, ['--project', project]);
    expect(good.rows.pins).toEqual({ status: 'PASS', rest: `${project}: bun >=1.4.2 (engines.bun, package.json:3)` });
    const none = row(f, ['--project', f.work]);
    expect(none.rows.pins.status).toBe('PASS');
    expect(none.rows.pins.rest).toContain('pins no runtime');
    const missing = row(f, ['--project', path.join(f.base, 'nope')]);
    expect(missing.rows.pins.status).toBe('SKIP');
  });

  test('project pins on Capy: the PROJECT_PIN_MISMATCH fix is the exact bootstrapper command, which installs a verified pinned Bun', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const capy = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14', GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(capy.rows.pins.status).toBe('FAIL');
    expect(capy.rows.pins.rest).toContain(`fix: bash ${wrapper} (installs the project's pinned Bun when it is a verified version: 1.4.2 1.4.3 1.4.4; otherwise it names the conflict), or change the pin in ${project}`);
    expect(capy.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    const forSkill = row(f, ['--project', project, '--for', 'review'], { STUB_BUN_VERSION: '1.3.14', GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(forSkill.rows.pins.rest).toContain(`fix: bash ${wrapper} --for review (installs`);
    const plain = row(f, ['--project', project], { STUB_BUN_VERSION: '1.3.14' });
    expect(plain.rows.pins.rest).toContain('fix: install the pinned version for this platform');
    expect(plain.rows.pins.rest).not.toContain(wrapper);
  });

  test('project pins: a Node-only pin mismatch is a WARN (the trailer stays ok) that names the node it read and a fix that installs the pinned Node', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    write(path.join(project, '.github/workflows/native-locks.yml'), 'jobs:\n  locks:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24.18.0\n');
    script(path.join(f.stub, 'node'), ['echo v24.21.0']);
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const capy = row(f, ['--project', project, '--for', 'health'], { GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(capy.rows.pins.status).toBe('WARN');
    expect(capy.rows.pins.rest).toContain(`node 24.21.0 outside CI 24.18.0 (.github/workflows/native-locks.yml:6); node read from ${bashPath(f.stub)}/node (node pin only; bun pins pass)`);
    expect(capy.rows.pins.rest).toContain(`fix: bash ${wrapper} --for health (installs the project's pinned Node 24.18.0 into gstack's runtime store and launches it through the GSTACK_LAUNCH PATH), or change the pin in ${project}`);
    expect(capy.rows.pins.rest).toContain('(PROJECT_NODE_PIN_UNMET; ');
    expect(capy.trailer).toBe(`gstack: ok ${VERSION} for=health`);
    const plain = row(f, ['--project', project, '--for', 'health']);
    expect(plain.rows.pins.rest).toContain(`fix: nvm install 24.18.0 and put its bin directory first on PATH`);
    // A Bun pin that also fails keeps the FAIL and its code: only a Node-only gap is advisory.
    write(path.join(project, 'package.json'), '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n');
    const both = row(f, ['--project', project, '--for', 'health'], { STUB_BUN_VERSION: '1.3.14' });
    expect(both.rows.pins.status).toBe('FAIL');
    expect(both.rows.pins.rest).toContain('(PROJECT_PIN_MISMATCH; ');
    fs.rmSync(path.join(project, 'package.json'));
    script(path.join(f.stub, 'node'), ['echo v24.18.0']);
    expect(row(f, ['--project', project, '--for', 'health']).rows.pins.status).toBe('PASS');
  });

  test('floor: min_gstack_version in the project\'s .gstack/ship-policy.json PASSes at or below the installed version, WARNs above it with the upgrade as the fix, and SKIPs when absent or null', () => {
    const f = makeFixture();
    const project = path.join(f.base, 'project');
    fs.mkdirSync(project, { recursive: true });
    const none = row(f, ['--project', project]);
    expect(none.rows.floor).toEqual({ status: 'SKIP', rest: `(${project} declares none (.gstack/ship-policy.json absent; set min_gstack_version there to require a gstack version))` });
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "bump": "patch",\n  "min_gstack_version": null\n}\n');
    expect(row(f, ['--project', project]).rows.floor).toEqual({ status: 'SKIP', rest: `(${project}/.gstack/ship-policy.json sets no min_gstack_version (null or absent))` });
    // A present value that is not a dotted version is named as such, never read as "absent"; the shell never evaluates it.
    const marker = path.join(project, 'evaluated-marker');
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "min_gstack_version": "1.2.3-rc1; $(touch ${marker})"\n}\n`);
    expect(row(f, ['--project', project]).rows.floor).toEqual({ status: 'SKIP', rest: `(${project}/.gstack/ship-policy.json sets min_gstack_version to something other than a plain dotted version)` });
    expect(fs.existsSync(marker)).toBe(false);
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "min_gstack_version": "${VERSION}"\n}\n`);
    const met = row(f, ['--project', project]);
    expect(met.rows.floor).toEqual({ status: 'PASS', rest: `${VERSION} declared by ${project}/.gstack/ship-policy.json (installed ${VERSION})` });
    // Valid JSON may put the value on the line after its field (found by Codex in /ship's adversarial review).
    write(path.join(project, '.gstack/ship-policy.json'), `{\n  "bump": "patch",\n  "min_gstack_version":\n    "${VERSION}"\n}\n`);
    expect(row(f, ['--project', project]).rows.floor.status).toBe('PASS');
    // The first occurrence is the top-level field: a later nested one never lowers the floor (found by Codex).
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "min_gstack_version": "999.0.0.0",\n  "$schema": {"min_gstack_version": "0.0.0"}\n}\n');
    expect(row(f, ['--project', project]).rows.floor.status).toBe('WARN');
    write(path.join(project, '.gstack/ship-policy.json'), '{\n  "min_gstack_version": "999.0.0.0"\n}\n');
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const unmet = row(f, ['--project', project, '--for', 'health'], { GSTACK_CAPY_WRAPPER_PATH: wrapper });
    expect(unmet.status, unmet.out).toBe(0);
    expect(unmet.rows.floor.status).toBe('WARN');
    expect(unmet.rows.floor.rest).toContain(`installed ${VERSION} is below the floor 999.0.0.0 that ${project}/.gstack/ship-policy.json declares (min_gstack_version); fix: bash ${wrapper} --for health (fast-forwards a clean checkout to origin and reinstalls), or `);
    expect(unmet.rows.floor.rest).toContain('(PROJECT_FLOOR_UNMET; ');
    expect(unmet.trailer).toBe(`gstack: ok ${VERSION} for=health`);
    const plain = row(f, ['--project', project]);
    expect(plain.rows.floor.rest).toContain('fix: ');
    expect(plain.rows.floor.rest).toContain('bin/gstack-upgrade (fast-forwards to the remote default branch');
    expect(plain.rows.floor.rest).not.toContain(wrapper);
  });

  test('--revision: a matching VERSION passes, an unmet revision is never ok', () => {
    const f = makeFixture();
    const ok = row(f, ['--revision', VERSION]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.rows.revision.status).toBe('PASS');
    const unmet = row(f, ['--revision', 'v9.9.9.9']);
    expect(unmet.status).toBe(1);
    expect(unmet.rows.revision.status).toBe('FAIL');
    expect(unmet.rows.revision.rest).toContain(`installed ${VERSION}`);
    expect(unmet.rows.revision.rest).toContain('(requested v9.9.9.9)');
    expect(unmet.rows.revision.rest).toContain('(REVISION_UNMET; ');
    expect(unmet.trailer).toBe('gstack: fail revision');
  });

  test('browser skills: the bundle and a Chromium launch plus render are required; planning skills never launch it', () => {
    const f = makeFixture();
    installCodex(f);
    installPlaywrightStub(f, false);
    const broken = row(f, ['--for', 'qa']);
    expect(broken.status).toBe(1);
    expect(broken.rows['browse-bundle'].status).toBe('PASS');
    expect(broken.rows.browser.status).toBe('FAIL');
    expect(broken.rows.browser.rest).toContain("Executable doesn't exist");
    expect(broken.rows.browser.rest).toContain(`fix: ${bashPath(f.root)}/bin/gstack-browser-ensure (BROWSER_UNAVAILABLE; `);
    expect(broken.trailer).toBe('gstack: fail browser');
    installPlaywrightStub(f, true);
    const ok = row(f, ['--for', 'qa']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.rows.browser).toEqual({ status: 'PASS', rest: 'Chromium 141.0.1 launched and rendered (node)' });
    fs.rmSync(path.join(f.root, BROWSE_BIN));
    const noBundle = row(f, ['--for', 'browse']);
    expect(noBundle.rows['browse-bundle'].status).toBe('FAIL');
    expect(noBundle.rows['browse-bundle'].rest).toContain('fix: cd ');
    installPlaywrightStub(f, false);
    expect(row(f, ['--for', 'autoplan']).rows.browser.status).toBe('SKIP');
  });

  test('cso: optional by default (SKIP, never silent), required by --for cso', () => {
    const f = makeFixture();
    expect(row(f, []).rows.cso).toEqual({ status: 'SKIP', rest: '(optional; toolchain absent or helper not built)' });
    const r = row(f, ['--for', 'cso']);
    expect(r.rows.cso.status).toBe('FAIL');
    expect(r.trailer).toBe('gstack: fail cso');
    for (const name of ['gstack-cso-launcher', 'gstack-cso-core']) write(path.join(f.root, 'bin', name + EXE), '#!/bin/sh\necho cso\n', 0o755);
    expect(row(f, ['--for', 'cso']).rows.cso.status).toBe('PASS');
  });

  test('state root: GSTACK_EPHEMERAL=1 reports durable=no in --check (PASS) and warns in the dashboard', () => {
    const f = makeFixture();
    const r = row(f, [], { GSTACK_EPHEMERAL: '1' });
    expect(r.rows['state-root'].status).toBe('PASS');
    expect(r.rows['state-root'].rest).toContain(`${f.state} durable=no`);
    expect(r.rows['state-root'].rest).toContain('GSTACK_EPHEMERAL=1');
    expect(r.status, r.out).toBe(0);
    const dash = doctor(f, [], { GSTACK_EPHEMERAL: '1' });
    expect(dash.row('state root').state).toBe('warn');
    expect(dash.row('state root').detail).toContain('durable=no');
    expect(dash.row('state root').fix).toContain('GSTACK_STATE_ROOT');
    expect(doctor(f).row('state root').detail).toContain('durable=yes');
  });

  test('--json: the same rows as objects keyed by the component ids, ok/failed/required and the trailer', () => {
    const f = makeFixture();
    installCodex(f);
    const r = doctor(f, ['--json', '--for', 'autoplan'], { STUB_BUN_VERSION: '1.3.14' });
    expect(r.status).toBe(1);
    const json = JSON.parse(r.out.trim().split('\n').at(-1)!);
    expect(json.schema_version).toBe(1);
    expect(json.revision).toBe(VERSION);
    expect(json.for).toBe('autoplan');
    expect(json.ok).toBe(false);
    expect(json.failed).toEqual(['runtime']);
    expect(json.required).toEqual(['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    expect(json.rows.map((x: { id: string }) => x.id)).toEqual(['claude', 'codex', 'patch', 'codex-cli', 'browse-bundle', 'browser', 'cso', 'helpers', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision', 'floor', 'wrapper']);
    const runtime = json.rows.find((x: { id: string }) => x.id === 'runtime');
    expect(runtime.status).toBe('FAIL');
    expect(runtime.code).toBe('RUNTIME_BELOW_MINIMUM');
    expect(runtime.anchor).toBe('doctor-runtime-below-minimum');
    expect(runtime.fix).toContain('gstack-capy-install');
    expect(json.trailer).toBe('gstack: fail runtime');
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const ok = JSON.parse(doctor(f, ['--json']).out.trim());
    expect(ok.ok).toBe(true);
    expect(ok.trailer).toBe(`gstack: ok ${VERSION} for=installed-hosts:claude,codex`);
  });

  test('usage: --for with --require, an unknown skill or component, and a flag without a value exit 2', () => {
    const f = makeFixture();
    expect(doctor(f, ['--check', '--for', 'autoplan', '--require', 'claude']).status).toBe(2);
    expect(doctor(f, ['--for', 'no-such-skill']).status).toBe(2);
    expect(doctor(f, ['--require', 'claude,bogus']).status).toBe(2);
    expect(doctor(f, ['--check', '--project']).status).toBe(2);
    expect(doctor(f, ['--help']).out).toContain('--check');
  });
});
