import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import committedCatalog from '../lib/cso/runtime-catalog.json';
import buildInputs from '../lib/cso/images/build-inputs.json';
import { committedImageBuildMatrix, imageBuildMatrix } from '../scripts/cso-image-matrix';
import { catalogPromotionCandidate, requiredChecks } from '../scripts/cso-runtime-promotion';
import { runBashScript } from './helpers/bash-script';
import { requalificationTriggers } from '../scripts/cso-requalification';

const CURRENT_TRIGGERS = await requalificationTriggers();

const ROOT = resolve(import.meta.dir, '..');
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const CREDENTIAL_IMAGE = ['https://user:', 'pass@example.test/node'].join('');

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-cso-build-')); temps.push(dir);
  for (const sub of ['scripts', 'bin', 'lib/cso']) mkdirSync(join(dir, sub), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/build-cso.sh'), join(dir, 'scripts/build-cso.sh'));
  const publisher = [
    '#!/bin/sh',
    'set -eu',
    'directory=$1',
    'shift',
    'if [ "$(uname -s)" = Linux ]; then',
    "  exec /usr/bin/flock -n -E 73 \"$directory\" /bin/sh -c '",
    '    if [ -n "${CSO_PUBLISH_BARRIER:-}" ]; then',
    '      : > "${CSO_PUBLISH_BARRIER}.ready"',
    '      while [ ! -f "${CSO_PUBLISH_BARRIER}.go" ]; do sleep .01; done',
    '    fi',
    '    export GSTACK_CSO_PUBLISH_LOCKED=1',
    '    exec "$@"',
    "  ' cso-publish \"$@\"",
    'fi',
    'export GSTACK_CSO_PUBLISH_LOCKED=1',
    'exec "$@"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'publish lock wrapper'), publisher); chmodSync(join(dir, 'publish lock wrapper'), 0o755);
  // The recorder substitutes compilation only. The build command itself is the
  // real script, so quoting, flag propagation and failed-compiler behavior run.
  const recorder = '#!/bin/sh\nset -eu\nprintf "%s\\n" "$@" >> "$CSO_BUILD_LOG"\ncount_file="$CSO_BUILD_LOG.count"\ncount=0\n[ ! -f "$count_file" ] || count=$(cat "$count_file")\ncount=$((count+1))\nprintf "%s\\n" "$count" > "$count_file"\nif [ -n "${CSO_BUILD_BARRIER:-}" ] && [ "$count" = 1 ]; then touch "$CSO_BUILD_BARRIER.ready"; while [ ! -f "$CSO_BUILD_BARRIER.go" ]; do sleep .01; done; fi\nif [ "${CSO_FAIL_COMPILER:-0}" = 1 ] || [ "${CSO_FAIL_COMPILER_N:-0}" = "$count" ]; then exit 42; fi\noutput=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in --outfile|-o) shift; output="$1" ;; esac\n  shift\ndone\nif [ -n "$output" ]; then\n  case "$output" in\n    *gstack-cso-publish-lock*) cp "$CSO_FAKE_LOCKER_TEMPLATE" "$output" ;;\n    *) generation="${CSO_BUILD_GENERATION:-NEW}"; cat > "$output" <<EOF\n#!/bin/sh\nprintf "%s\\n" "$generation"\nEOF\n       ;;\n  esac\n  chmod +x "$output"\nfi\n';
  writeFileSync(join(dir, 'compiler recorder'), recorder); chmodSync(join(dir, 'compiler recorder'), 0o755);
  return dir;
}

function seedBundle(dir:string,generation='OLD'){
  for(const name of ['gstack-cso-launcher','gstack-cso-core','gstack-cso-watchdog']){const file=join(dir,'bin',name);writeFileSync(file,`#!/bin/sh\nprintf '%s\\n' '${generation}'\n`);chmodSync(file,0o755);}
  writeFileSync(join(dir,'bin','.gstack-cso-generation'),'0'.repeat(64)+'\n');
}
function bundleContents(dir:string){return ['gstack-cso-launcher','gstack-cso-core','gstack-cso-watchdog','.gstack-cso-generation'].map(name=>readFileSync(join(dir,'bin',name),'utf8'));}
function expectPublishedBundle(dir:string,generation='NEW'){
  const contents=bundleContents(dir);
  expect(contents.slice(0,3).every(content=>content.includes(generation))).toBe(true);
  expect(contents[3]).toMatch(/^[a-f0-9]{64}\n$/);
}
function fakeBuildCommand(dir:string,extra=''){const log=join(dir,'compiler.log');return `${extra} BUN_CMD=${quote(join(dir,'compiler recorder'))} CSO_CC=${quote(join(dir,'compiler recorder'))} CSO_BUILD_LOG=${quote(log)} CSO_FAKE_LOCKER_TEMPLATE=${quote(join(dir,'publish lock wrapper'))} bash ${quote(join(dir,'scripts/build-cso.sh'))}`;}
function fakeBuild(dir:string,extra=''){return runBashScript(fakeBuildCommand(dir,extra),{timeout:10_000});}

function reviewedInputs(): any {
  const pinned = (repository: string, fill: string) => `${repository}@sha256:${fill.repeat(64)}`;
  const family = (repository: string, tag: string, index: string, amd64: string, arm64: string) => ({
    source: `${repository}:${tag}`,
    indexImage: pinned(repository, index),
    images: { 'linux/amd64': pinned(repository, amd64), 'linux/arm64': pinned(repository, arm64) },
  });
  const sbom = family('docker.io/tool/sbom', '1.0.0', '1', '2', '3');
  const base = (repository: string, tag: string, index: string, amd64: string, arm64: string) => {
    const value = family(repository, tag, index, amd64, arm64);
    return { source: value.source, indexImage: value.indexImage, baseImages: value.images };
  };
  return {
    schemaVersion: 1, helperAbi: 3, state: 'reviewed', revision: 'fixture-runtime-inputs',
    reviewedAt: '2026-09-10T00:00:00.000Z',
    reviewMethod: 'Fixture review metadata long enough to exercise the strict source-controlled build input contract.',
    sbomGenerator: sbom,
    profiles: [
      { id: 'node-24.4.0', stack: 'node', ...base('docker.io/library/node', '24.4.0', '4', '5', '6'), versions: { node: '24.4.0', npm: '11.4.2', 'cso-preparation': '1.0.0' } },
      { id: 'bun-1.3.10', stack: 'bun', ...base('docker.io/oven/bun', '1.3.10', '7', '8', '9'), versions: { bun: '1.3.10', 'cso-preparation': '1.0.0' } },
      { id: 'python-3.13.4-uv-0.8.0', stack: 'python', ...base('docker.io/library/python', '3.13.4', 'a', 'b', 'c'),
        uvSource: 'ghcr.io/astral-sh/uv:0.8.0', uvIndexImage: pinned('ghcr.io/astral-sh/uv', 'd'),
        uvImages: { 'linux/amd64': pinned('ghcr.io/astral-sh/uv', 'e'), 'linux/arm64': pinned('ghcr.io/astral-sh/uv', 'f') },
        versions: { python: '3.13.4', uv: '0.8.0', 'cso-preparation': '1.0.0' } },
      { id: 'rails-ruby-3.4.4', stack: 'rails', ...base('docker.io/library/ruby', '3.4.4', '0', 'a', 'b'), versions: { ruby: '3.4.4', bundler: '2.6.7', 'cso-preparation': '1.0.0' } },
      { id: 'postgresql-17.2', stack: 'postgresql', ...base('docker.io/library/postgres', '17.2', 'c', 'd', 'e'), versions: { postgresql: '17.2' } },
    ],
  };
}

describe('CSO build and distribution wiring', () => {
  test('POSIX helpers expose Darwin no-follow flags before system headers', () => {
    for (const relative of ['lib/cso/launcher.c', 'lib/cso/watchdog.c', 'lib/cso/publish-lock.c']) {
      const source = readFileSync(join(ROOT, relative), 'utf8');
      const darwinFeature = source.indexOf('#define _DARWIN_C_SOURCE 1');
      const fileFlags = source.indexOf('#include <fcntl.h>');
      expect(darwinFeature, relative).toBeGreaterThanOrEqual(0);
      expect(fileFlags, relative).toBeGreaterThan(darwinFeature);
      expect(source, relative).toContain('O_NOFOLLOW');
    }
  });

  test('the cached eval image proves the static C toolchain required by direct builds', () => {
    const dockerfile = readFileSync(join(ROOT, '.github/docker/Dockerfile.ci'), 'utf8');
    expect(dockerfile).toMatch(/\bgcc libc6-dev\b/);
    expect(dockerfile).toContain('cc -std=c11 -static /tmp/gstack-cso-cc-probe.c');
    expect(dockerfile).toContain('/tmp/gstack-cso-cc-probe');
  });

  test.skipIf(process.platform === 'win32')('real build script supplies all startup-hardening flags and compiles its watchdog', () => {
    const dir = buildFixture(), log = join(dir, 'compiler.log');
    const r = fakeBuild(dir);
    expect(r.status).toBe(0);
    const args = readFileSync(log, 'utf8').split('\n');
    for (const flag of ['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json']) expect(args.filter(a => a === flag)).toHaveLength(1);
    expect(args).toContain('lib/cso/cli.ts');
    expect(args.some(arg=>/bin\/\.gstack-cso-stage\.[^/]+\/gstack-cso-core$/.test(arg))).toBe(true);
    expect(args).toContain('lib/cso/launcher.c');
    expect(args.some(arg=>/bin\/\.gstack-cso-stage\.[^/]+\/gstack-cso-launcher$/.test(arg))).toBe(true);
    expect(args).toContain('lib/cso/watchdog.c');
    expect(args.some(arg=>/bin\/\.gstack-cso-stage\.[^/]+\/gstack-cso-watchdog$/.test(arg))).toBe(true);
    expect(args).toContain('lib/cso/publish-lock.c');
    expect(args.some(arg=>/bin\/\.gstack-cso-stage\.[^/]+\/gstack-cso-publish-lock$/.test(arg))).toBe(true);
    expect(spawnSync(join(dir,'bin/gstack-cso-launcher'),['--version'],{encoding:'utf8',timeout:5000}).stdout.trim()).toBe('NEW');
    expectPublishedBundle(dir);
  });

  test.skipIf(process.platform === 'win32')('generation validation accepts BSD wc padding', () => {
    const dir = buildFixture(), tools = join(dir, 'bsd-tools'), wc = join(tools, 'wc');
    mkdirSync(tools);
    writeFileSync(wc, '#!/bin/sh\nset -eu\ncount=$(/usr/bin/wc -c "$@")\nprintf "      %s\\n" "$count"\n');
    chmodSync(wc, 0o755);
    const result = fakeBuild(dir, `PATH=${quote(`${tools}:/usr/bin:/bin`)}`);
    expect(result.status).toBe(0);
    expectPublishedBundle(dir);
  });

  test.skipIf(process.platform === 'win32').each([1,2,3,4])('compiler failure at stage %i preserves the exact runnable old bundle', failure => {
    const dir=buildFixture();seedBundle(dir);const before=bundleContents(dir);
    const r=fakeBuild(dir,`CSO_FAIL_COMPILER_N=${failure}`);
    expect(r.status).toBe(42);
    expect(bundleContents(dir)).toEqual(before);
    expect(spawnSync(join(dir,'bin/gstack-cso-launcher'),{encoding:'utf8',timeout:5000}).stdout.trim()).toBe('OLD');
  });

  test.skipIf(process.platform === 'win32').each(['withdraw-launcher','publish-core','publish-watchdog','before-publish-launcher','publish-launcher'])('publication failure after %s rolls back to the exact old bundle', checkpoint=>{
    const dir=buildFixture();seedBundle(dir);const before=bundleContents(dir);
    const r=fakeBuild(dir,`GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_FAIL_AFTER=${checkpoint}`);
    expect(r.status).toBe(86);expect(bundleContents(dir)).toEqual(before);
    expect(spawnSync(join(dir,'bin/gstack-cso-launcher'),{encoding:'utf8',timeout:5000}).stdout.trim()).toBe('OLD');
  });

  test.skipIf(process.platform === 'win32')('SIGKILL before launcher publication leaves no runnable mixed bundle',()=>{
    const dir=buildFixture();seedBundle(dir);const r=fakeBuild(dir,'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_KILL_AFTER=publish-core');
    expect(r.status).not.toBe(0);expect(() => readFileSync(join(dir,'bin/gstack-cso-launcher'))).toThrow();
    expect(fakeBuild(dir).status).toBe(0);
    expectPublishedBundle(dir);
  });

  test.skipIf(process.platform === 'win32')('SIGKILL after launcher-last publication leaves a complete new bundle',()=>{
    const dir=buildFixture();seedBundle(dir);const r=fakeBuild(dir,'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_KILL_AFTER=publish-launcher');
    expect(r.status).not.toBe(0);expectPublishedBundle(dir);
    expect(spawnSync(join(dir,'bin/gstack-cso-launcher'),{encoding:'utf8',timeout:5000}).stdout.trim()).toBe('NEW');
  });

  test.skipIf(process.platform === 'win32')('a failed rollback withholds the launcher and retains recovery material',()=>{
    const dir=buildFixture();seedBundle(dir);
    const r=fakeBuild(dir,'GSTACK_CSO_BUILD_TESTING=1 GSTACK_CSO_BUILD_TEST_FAIL_AFTER=publish-core GSTACK_CSO_BUILD_TEST_FAIL_RESTORE=core');
    expect(r.status).not.toBe(0);expect(() => readFileSync(join(dir,'bin/gstack-cso-launcher'))).toThrow();
    expect(r.stderr).toContain('recovery files remain');
    expect(readFileSync(join(dir,'bin/gstack-cso-watchdog'),'utf8')).toContain('OLD');
  });

  test.skipIf(process.platform !== 'linux')('publisher lock rejects a competing OS lock without mutating the installed bundle',async()=>{
    const dir=buildFixture(),ready=join(dir,'lock.ready'),release=join(dir,'lock.release');seedBundle(dir);const before=bundleContents(dir);
    const holder=Bun.spawn(['/usr/bin/flock','-n',join(dir,'bin'),'/bin/sh','-c',`: > ${quote(ready)}; while [ ! -f ${quote(release)} ]; do sleep .01; done`],{stdout:'pipe',stderr:'pipe'});
    const deadline=Date.now()+3000;while(!existsSync(ready)&&Date.now()<deadline)await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    expect(fakeBuild(dir).status).toBe(73);
    expect(bundleContents(dir)).toEqual(before);
    writeFileSync(release,'go');expect(await holder.exited).toBe(0);
  });

  test.skipIf(process.platform === 'win32')('an ownerless legacy mkdir lock cannot block publication',()=>{
    const dir=buildFixture();seedBundle(dir);mkdirSync(join(dir,'bin/.gstack-cso-build.lock'));
    expect(fakeBuild(dir).status).toBe(0);
    expectPublishedBundle(dir);
  });

  test.skipIf(process.platform !== 'linux')('concurrent publishers cannot interleave generations under the exclusive publication lock',async()=>{
    const dir=buildFixture(),barrier=join(dir,'barrier');seedBundle(dir);
    const first=Bun.spawn(['/bin/bash','-c',fakeBuildCommand(dir,`CSO_PUBLISH_BARRIER=${quote(barrier)} CSO_BUILD_GENERATION=A`)],{stdout:'pipe',stderr:'pipe'});
    const deadline=Date.now()+3000;while(!existsSync(`${barrier}.ready`)&&Date.now()<deadline)await Bun.sleep(10);
    expect(existsSync(`${barrier}.ready`)).toBe(true);
    const second=fakeBuild(dir,'CSO_BUILD_GENERATION=B');expect(second.status).toBe(73);
    writeFileSync(`${barrier}.go`,'go');expect(await first.exited).toBe(0);
    expectPublishedBundle(dir,'A');
  });

  test.skipIf(process.platform === 'win32')('a signal delivered after mv but before it returns cannot expose a mixed bundle',()=>{
    const dir=buildFixture(),tools=join(dir,'tools'),marker=join(dir,'signal-after-mv');seedBundle(dir);mkdirSync(tools);
    const realMv=Bun.which('mv');expect(realMv).toBeTruthy();
    writeFileSync(join(tools,'mv'),`#!/bin/sh\n${quote(realMv!)} "$@"\nstatus=$?\nif [ "$status" -eq 0 ] && [ ! -f "$CSO_SIGNAL_AFTER_MV_MARKER" ]; then\n  : > "$CSO_SIGNAL_AFTER_MV_MARKER"\n  kill -TERM "$PPID"\n  sleep .05\nfi\nexit "$status"\n`);
    chmodSync(join(tools,'mv'),0o755);
    const r=fakeBuild(dir,`PATH=${quote(`${tools}:/usr/bin:/bin`)} CSO_SIGNAL_AFTER_MV_MARKER=${quote(marker)}`);
    expect(r.status).toBe(0);expect(existsSync(marker)).toBe(true);expectPublishedBundle(dir);
  });

  test.skipIf(process.platform !== 'linux')('a macOS build fails closed when hardened-runtime signing is unavailable', () => {
    const dir = buildFixture(), log = join(dir, 'compiler.log'), tools = join(dir, 'tools');
    seedBundle(dir);const before=bundleContents(dir);
    mkdirSync(tools);
    writeFileSync(join(tools, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    chmodSync(join(tools, 'uname'), 0o755);
    const r = runBashScript(`PATH=${quote(`${tools}:/usr/bin:/bin`)} BUN_CMD=${quote(join(dir, 'compiler recorder'))} CSO_CC=${quote(join(dir, 'compiler recorder'))} CSO_BUILD_LOG=${quote(log)} bash ${quote(join(dir, 'scripts/build-cso.sh'))}`, { timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('requires macOS codesign');
    expect(bundleContents(dir)).toEqual(before);
  });

  test.skipIf(process.platform !== 'linux')('a macOS signing failure cannot mutate the installed generation',()=>{
    const dir=buildFixture(),log=join(dir,'compiler.log'),tools=join(dir,'tools');seedBundle(dir);const before=bundleContents(dir);mkdirSync(tools);
    writeFileSync(join(tools,'uname'),'#!/bin/sh\nprintf "Darwin\\n"\n');writeFileSync(join(tools,'codesign'),'#!/bin/sh\nexit 1\n');
    chmodSync(join(tools,'uname'),0o755);chmodSync(join(tools,'codesign'),0o755);
    const r=runBashScript(`PATH=${quote(`${tools}:/usr/bin:/bin`)} BUN_CMD=${quote(join(dir,'compiler recorder'))} CSO_CC=${quote(join(dir,'compiler recorder'))} CSO_BUILD_LOG=${quote(log)} bash ${quote(join(dir,'scripts/build-cso.sh'))}`,{timeout:10_000});
    expect(r.status).not.toBe(0);expect(bundleContents(dir)).toEqual(before);
  });

  test('setup distributes the helper pair without promising an incomplete npm bin', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const build = readFileSync(join(ROOT, 'scripts/build.sh'), 'utf8');
    const setup = readFileSync(join(ROOT, 'setup'), 'utf8');
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(pkg.bin).not.toHaveProperty('gstack-cso');
    expect(pkg.scripts['build:cso']).toBe('bash scripts/build-cso.sh');
    expect(pkg.scripts['test:cso:macos']).toBe('bun test test/cso-macos-launcher.test.ts test/cso-registry-socket.test.ts');
    expect(pkg.scripts['test:cso:docker']).toContain('test/cso-node-lifecycle-integration.test.ts');
    expect(pkg.scripts['test:cso:docker']).toContain('test/cso-stack-cold-integration.test.ts');
    expect(pkg.scripts['test:cso:docker']).toContain('--max-concurrency 1');
    expect(build).toContain('bash scripts/build-cso.sh');
    const signed = setup.match(/for _bin in ([^;]+);/)![1].split(/\s+/);
    for (const name of ['bin/gstack-cso-launcher','bin/gstack-cso-core', 'bin/gstack-cso-watchdog']) {
      expect(signed).not.toContain(name); expect(ignore).toContain(name); expect(ignore).toContain(`${name}.exe`);
    }
    expect(readFileSync(join(ROOT,'scripts/build-cso.sh'),'utf8')).toContain('cso_sign_macos_artifact "$CSO_STAGE_LAUNCHER" 1');
    for (const name of ['lib/cso/images/gstack-cso-verifier', 'lib/cso/images/gstack-cso-preparation']) expect(ignore).toContain(name);
    expect(setup).toContain('gstack-cso-launcher$_EXE" provision-images --setup-summary');
    expect(setup).toContain('anonymous exact-digest pulls');
    expect(setup).toContain('static audits remain available');
    // Host skill installers already distribute bin and lib together.
    expect(/for asset in bin lib browse review qa/.test(setup)).toBe(true);
  });
});

const EVALUATION_REF = `sha256:${'e'.repeat(64)}`;
const STAGING_RUN = '777';
function dispatchedStatements(): any[] {
  return committedImageBuildMatrix().include.map(row => ({
    schemaVersion: 1, helperAbi: 3, state: 'qualified', buildRevision: row.inputRevision, runtimeId: row.runtimeId,
    stack: row.stack, platform: row.platform, versions: row.versions, sourceCommit: 'a'.repeat(40),
    image: `ghcr.io/garrytan/gstack/cso-staging/${row.stack}-${row.arch}@sha256:${Bun.hash(row.runtimeId).toString(16).padStart(64, '0')}`,
    checks: Object.fromEntries(requiredChecks(row.stack).map(key => [key, true])),
    evaluationRef: EVALUATION_REF,
  }));
}
function ingressStep(name: string): string {
  const job = (Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/cso-runtime-qualification.yml'), 'utf8')) as any).jobs.qualify;
  return (job.steps.find((step: any) => step.name === name).run as string).replaceAll('bun run scripts/', `bun run ${quote(ROOT)}/scripts/`);
}
function ingressFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cso-ingress-')); temps.push(dir);
  const bin = join(dir, 'bin'), work = join(dir, 'work'), fake = join(dir, 'gh-fixtures');
  for (const path of [bin, work, fake]) mkdirSync(path);
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'set -eu',
    'case "$1 $2" in',
    '  "attestation verify")',
    '    case "$*" in',
    '      *https://slsa.dev/provenance/v1*) jq --arg image "$3" \'.[0].verificationResult.statement.subject[0].name = $image\' "$FAKE_GH/provenance.json" ;;',
    '      *) jq -n --arg image "$3" \'[{verificationResult:{statement:{predicateType:"https://spdx.dev/Document/v2.3",subject:[{name:$image}]}}}]\' ;;',
    '    esac ;;',
    '  "api --paginate") cat "$FAKE_GH/jobs.json" ;;',
    '  "run download") while [ "$#" -gt 0 ]; do [ "$1" != --dir ] || dir=$2; shift; done; mkdir -p "$dir"; cp "$FAKE_GH/requalification.json" "$dir/" ;;',
    '  "api repos/"*) cat "$FAKE_GH/run.json" ;;',
    '  *) echo "unexpected gh $*" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const invocation = `https://github.com/garrytan/gstack/actions/runs/${STAGING_RUN}/attempts/1`;
  writeFileSync(join(fake, 'provenance.json'), JSON.stringify([{ verificationResult: {
    signature: { certificate: { runInvocationURI: invocation } },
    statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: '' }], predicate: { runDetails: { metadata: { invocationId: invocation } } } },
  } }]));
  const run = (overrides: Record<string, unknown> = {}) => writeFileSync(join(fake, 'run.json'), JSON.stringify({
    id: Number(STAGING_RUN), path: '.github/workflows/cso-runtime-images.yml', event: 'workflow_dispatch', head_branch: 'main',
    head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success',
    repository: { full_name: 'garrytan/gstack' }, head_repository: { full_name: 'garrytan/gstack' }, ...overrides,
  }));
  const jobs = (conclusion = 'success') => {
    const list = committedImageBuildMatrix().include.map((row, index) => ({
      name: `qualify-native ${row.runtimeId}`, run_id: Number(STAGING_RUN), status: 'completed', conclusion: index === 0 ? conclusion : 'success',
    }));
    writeFileSync(join(fake, 'jobs.json'), JSON.stringify([{ total_count: list.length, jobs: list }]));
  };
  run(); jobs();
  writeFileSync(join(fake, 'requalification.json'), JSON.stringify(CURRENT_TRIGGERS));
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ action: 'cso-runtime-qualified', client_payload: { evaluationRef: EVALUATION_REF, statements: dispatchedStatements() } }));
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_GH: fake, GITHUB_EVENT_PATH: event,
    GITHUB_REPOSITORY: 'garrytan/gstack', GITHUB_RUN_ID: '555' };
  const step = (name: string) => runBashScript(ingressStep(name), { cwd: work, env, timeout: 60_000 });
  return { work, run, jobs, step };
}

describe('CSO runtime staging gates', () => {
  test('runtime workflow shell blocks parse after GitHub expressions are substituted', () => {
    for (const relative of [
      '.github/workflows/cso-runtime-images.yml',
      '.github/workflows/cso-runtime-qualification.yml',
      '.github/workflows/cso-runtime-promote.yml',
      '.github/workflows/cso-scanner-images.yml',
    ]) {
      const raw = readFileSync(join(ROOT, relative), 'utf8');
      const workflow = Bun.YAML.parse(raw) as any;
      expect(raw).not.toMatch(/\s\+\s+--(?:no-|name|arg|evidence|output|security)/);
      for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'GH_EXPR');
        const parsed = spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8', timeout: 30_000 });
        expect(parsed.status, `${relative}: ${step.name ?? step.run}\n${parsed.stderr}`).toBe(0);
      }
    }
  });

  test('reviewed inputs produce every application and database stack on each native Linux architecture', () => {
    const matrix = imageBuildMatrix(reviewedInputs());
    expect(matrix.include).toHaveLength(10);
    for (const stack of ['node', 'bun', 'python', 'rails', 'postgresql']) {
      const rows = matrix.include.filter(r => r.stack === stack);
      expect(rows.map(r => r.platform)).toEqual(['linux/amd64', 'linux/arm64']);
      expect(rows.map(r => r.runner)).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm']);
    }
  });

  test('unreviewed or incomplete inputs cannot silently publish a partial matrix', () => {
    const inputs = reviewedInputs(); inputs.state = 'pending';
    expect(() => imageBuildMatrix(inputs)).toThrow('MISSING_REVIEWED_BUILD_INPUTS');
    inputs.state = 'reviewed'; inputs.profiles.pop();
    expect(() => imageBuildMatrix(inputs)).toThrow('INCOMPLETE_STACK_MATRIX');
  });

  test.each(['node:latest', 'docker.io/library/node:24', CREDENTIAL_IMAGE, 'docker.io/library/node@sha256:bad', 'docker.io/library/node@sha256:' + 'A'.repeat(64), 'docker.io/library/node@sha256:' + 'a'.repeat(64) + '\nBAD=value'])('untrusted base input %s cannot enter the workflow matrix', image => {
    const inputs = reviewedInputs(); inputs.profiles[0].baseImages['linux/amd64'] = image;
    expect(() => imageBuildMatrix(inputs)).toThrow('UNPINNED_BASE_IMAGE');
  });

  test('SBOM generator and toolchain inputs must be pinned too', () => {
    const inputs = reviewedInputs(); inputs.sbomGenerator.images['linux/amd64'] = 'docker.io/tool/sbom:latest';
    expect(() => imageBuildMatrix(inputs)).toThrow('UNPINNED_SBOM_GENERATOR');
    const versions = reviewedInputs(); versions.profiles[0].versions.node = '^24';
    expect(() => imageBuildMatrix(versions)).toThrow('UNPINNED_TOOL_VERSION');
  });

  test.each(['docker.io/tool/sbom:1', 'docker.io/tool/sbom:1.24', 'docker.io/tool/sbom:1.24-slim', 'docker.io/tool/sbom:latest', 'docker.io/tool/sbom:stable'])('floating source tag %s cannot pin a reviewed family', source => {
    const sbom = reviewedInputs(); sbom.sbomGenerator.source = source;
    expect(() => imageBuildMatrix(sbom)).toThrow('FLOATING_SBOM_GENERATOR_SOURCE');
    const base = reviewedInputs(); base.profiles[0].source = source.replace('docker.io/tool/sbom', 'docker.io/library/node');
    expect(() => imageBuildMatrix(base)).toThrow('FLOATING_BASE_SOURCE');
  });

  test('PostgreSQL alone may name a two-part release, which is exact for it', () => {
    const postgres = reviewedInputs(); postgres.profiles[4].source = 'docker.io/library/postgres:17-bookworm';
    expect(() => imageBuildMatrix(postgres)).toThrow('FLOATING_BASE_SOURCE');
    const python = reviewedInputs(); python.profiles[2].source = 'docker.io/library/python:3.13-slim-bookworm';
    expect(() => imageBuildMatrix(python)).toThrow('FLOATING_BASE_SOURCE');
    expect(imageBuildMatrix(reviewedInputs()).include.find(row => row.stack === 'postgresql')?.baseSource).toBe('docker.io/library/postgres:17.2');
  });

  test('the committed build inputs name release tags for every source', () => {
    expect(buildInputs.sbomGenerator.source).toBe('docker.io/docker/scout-sbom-indexer:1.24.0');
    expect(committedImageBuildMatrix().include).toHaveLength(10);
  });

  test('duplicate stacks and missing Python uv images fail precisely', () => {
    const duplicate = reviewedInputs(); duplicate.profiles[1].stack = 'node';
    expect(() => imageBuildMatrix(duplicate)).toThrow('INVALID_STACK');
    const python = reviewedInputs(); python.profiles[2].uvImages!['linux/arm64'] = '';
    expect(() => imageBuildMatrix(python)).toThrow('UNPINNED_UV_IMAGE');
  });

  test('dedicated Docker CI is secretless and mandatory when its prerequisites are missing', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/free-tests.yml'), 'utf8');
    const workflow = Bun.YAML.parse(raw) as any;
    const job = workflow.jobs['cso-docker-integration'];
    expect(job).toBeTruthy();
    const gate = job.steps.find((step: any) => step.run?.trim() === 'bun test --max-concurrency 1 test/cso-docker-integration.test.ts');
    expect(gate.env.GSTACK_CSO_DOCKER_TESTS).toBe('1');
    expect(raw).not.toContain('secrets.');
    expect(job.steps.map((s: any) => s.run ?? '').join('\n')).toContain('docker --host unix:///var/run/docker.sock info');
    expect(job['continue-on-error']).not.toBe(true);
    expect(gate['continue-on-error']).not.toBe(true);
    const required = workflow.jobs['free-tests'];
    expect(required.if).toBe('always()');
    expect(required.needs).toEqual(['free-suite', 'typecheck', 'quick-bun-default', 'cso-macos-launcher', 'macos-named-regressions', 'cso-windows-launcher', 'cso-docker-integration']);
    expect(required.steps[0].run).toContain('test "$CSO_DOCKER_RESULT" = success');
    for (const current of Object.values(workflow.jobs) as any[]) for (const step of current.steps) {
      if (step.uses?.startsWith('oven-sh/setup-bun')) expect(step.uses).toBe('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    }
  });

  test('macOS runs the actual signed launcher gate on a native hosted runner', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/free-tests.yml'), 'utf8');
    const workflow = Bun.YAML.parse(raw) as any;
    const job = workflow.jobs['cso-macos-launcher'];
    expect(job['runs-on']).toBe('macos-latest');
    expect(job.steps.some((step: any) => step.run === 'bun run build:cso')).toBe(true);
    const gate = job.steps.find((step: any) => step.run === 'bun run test:cso:macos');
    expect(gate.env.GSTACK_CSO_MACOS_TESTS).toBe('1');
    expect(gate['continue-on-error']).not.toBe(true);
  });

  test('native macOS ownership and settings regressions are required by the free gate', () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/free-tests.yml'), 'utf8')) as any;
    const job = workflow.jobs['cso-macos-launcher'];
    const gate = job.steps.find((step: any) => step.name === 'Exercise native agent ownership and linked settings');
    expect(job['runs-on']).toBe('macos-latest');
    expect(gate.env.TMPDIR).toBe('/tmp');
    expect(gate.run).toContain('test -f "$file"');
    expect(gate.run).toContain('bun test "${files[@]}"');
    for (const file of [
      'browse/test/terminal-agent-lifecycle.test.ts',
      'browse/test/terminal-agent-native-observation.test.ts',
      'browse/test/terminal-agent-watchdog.test.ts',
      'browse/test/server-embedder-terminal-port.test.ts',
      'browse/test/server-factory.test.ts',
      'test/gstack-settings-hook-symlink.test.ts',
      'test/gstack-settings-hook-schema-aware.test.ts',
    ]) expect(gate.run).toContain(file);
    expect(gate['continue-on-error']).not.toBe(true);
    expect(workflow.jobs['free-tests'].needs).toContain('cso-macos-launcher');
  });

  test('publication requires manual protected-main review, signed evidence, and native containment checks', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/cso-runtime-images.yml'), 'utf8');
    const workflow = Bun.YAML.parse(raw) as any;
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'workflow_dispatch']);
    expect(workflow.jobs['validate-native'].if).toContain("github.event_name == 'pull_request'");
    expect(workflow.jobs['validate-native'].permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['validate-native'].steps.some((s: any) => s.run?.includes('cso-verify-runtime-base.ts'))).toBe(true);
    expect(workflow.jobs['validate-native'].steps.some((s: any) => s.with?.push === false && s.with?.load === true)).toBe(true);
    expect(workflow.jobs.stage.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.stage.environment).toBe('cso-runtime-release');
    const steps = workflow.jobs.stage.steps;
    expect(steps.some((s: any) => s.with?.provenance === 'mode=max')).toBe(true);
    expect(steps.some((s: any) => s.with?.attests?.includes('generator=${{ matrix.sbomGeneratorImage }}'))).toBe(true);
    expect(steps.filter((s: any) => s.uses?.startsWith('actions/attest@'))).toHaveLength(2);
    expect(raw).toContain('--source-digest "$GITHUB_SHA"');
    expect(raw).toContain('--cert-identity "$signer"');
    expect(raw).toContain('--predicate-type https://slsa.dev/provenance/v1');
    expect(raw).toContain('--predicate-type https://spdx.dev/Document/v2.3');
    expect(raw).toContain('scripts/cso-public-ghcr.ts verify');
    expect(raw).toContain('--repository "$GITHUB_REPOSITORY" --output public-image.json');
    expect(raw).toContain('sha256sum public-image.json');
    expect(raw).toContain('GSTACK_CSO_TEST_IMAGE:');
    expect(raw).toContain('GSTACK_CSO_TEST_STACK:');
    expect(raw).toContain('bun run test:cso:docker');
    expect(workflow.jobs['qualify-native'].needs).toEqual(['reviewed-inputs', 'stage']);
    expect(raw).toContain('cso-staged-postgresql-${{ matrix.arch }}');
    expect(raw).toContain('GSTACK_CSO_TEST_POSTGRES_IMAGE');
    const qualify = workflow.jobs['qualify-native'];
    expect(qualify.name).toBe('qualify-native ${{ matrix.runtimeId }}');
    expect(raw).not.toMatch(/Passed:\s*true/);
    const tested = qualify.steps.findIndex((s: any) => s.run?.includes('bun run test:cso:docker --reporter=junit --reporter-outfile=native-tests.junit.xml'));
    const derived = qualify.steps.findIndex((s: any) => s.run?.includes('scripts/cso-native-evidence.ts --stack "$CSO_STACK" --platform "$CSO_PLATFORM"'));
    expect(tested).toBeGreaterThanOrEqual(0);
    expect(derived).toBe(tested + 1);
    expect(qualify.steps[derived].run).toContain('--junit native-tests.junit.xml --staged staged-application/staged-image.json');
    expect(qualify.steps[derived + 1].with.path.split('\n').filter(Boolean)).toEqual(['qualification-evidence.json', 'native-tests.junit.xml']);
    expect(raw).not.toContain('setup-qemu');
    expect(raw).not.toContain('git push');
    expect(raw).not.toContain('gh pr create');
    expect(raw).not.toContain('contents: write');
    const bunDockerfile=readFileSync(join(ROOT,'lib/cso/images/bun.Dockerfile'),'utf8');
    const bunPolicy=readFileSync(join(ROOT,'lib/cso/images/bun-no-auto-install.toml'),'utf8');
    expect(bunDockerfile).toContain('bun-no-auto-install.toml /opt/cso/no-auto-install.toml');
    expect(bunPolicy).toBe('[install]\nauto = "disable"\n');
    for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('oven-sh/setup-bun')) expect(step.uses).toBe('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    }
  });

  test('catalog promotion authenticates one successful main run and opens an exact attested candidate PR', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/cso-runtime-promote.yml'), 'utf8');
    const workflow = Bun.YAML.parse(raw) as any;
    const job = workflow.jobs.propose;
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('cso-runtime-release');
    expect(job.permissions).toMatchObject({ contents: 'write', 'pull-requests': 'write', actions: 'write', packages: 'read', 'id-token': 'write', attestations: 'write' });
    expect(raw).toContain('.head_branch == "main"');
    expect(raw).toContain('.path == ".github/workflows/cso-runtime-qualification.yml"');
    expect(raw).toContain('.event == "repository_dispatch"');
    expect(raw).toContain('--name cso-qualified-runtime-statements');
    expect(raw).toContain('scripts/cso-runtime-promotion.ts');
    expect(raw).toContain('runtime-catalog.candidate.json');
    expect(raw).toContain('subject-path: runtime-catalog.candidate.json');
    expect(raw).toContain('gh attestation verify runtime-catalog.candidate.json');
    expect(raw).toContain('--cert-identity "$signer"');
    expect(raw).toContain('--source-digest "$GITHUB_SHA"');
    expect(raw).toContain('cso-attestation-evidence.ts digest');
    expect(raw).toContain('candidate-attestation-evidence.json');
    expect(raw).toContain('scripts/cso-public-ghcr.ts verify');
    expect(raw).toContain('--remove-after');
    expect(raw).toContain('cso-runtime-promotion.ts validate-transition');
    expect(raw).toContain('cmp runtime-catalog.candidate.json committed-runtime-catalog.json');
    expect(raw).toContain('git push');
    expect(raw).toContain('gh pr create --base main');
    expect(raw).toContain('branch="cso-runtime-catalog-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"');
    expect(raw).not.toContain('branch="cso-runtime-catalog-$GITHUB_RUN_ID"');
    const attested = raw.indexOf('subject-path: runtime-catalog.candidate.json');
    const publicPull = raw.indexOf('scripts/cso-public-ghcr.ts verify');
    const verified = raw.indexOf('gh attestation verify runtime-catalog.candidate.json');
    const committed = raw.indexOf('git add lib/cso/runtime-catalog.json');
    expect(publicPull).toBeGreaterThanOrEqual(0);
    expect(attested).toBeGreaterThan(publicPull);
    expect(verified).toBeGreaterThan(attested);
    expect(committed).toBeGreaterThan(verified);
    for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });

  test('catalog promotion PRs dispatch the required free-tests check on the pushed branch', () => {
    const freeTests = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/free-tests.yml'), 'utf8')) as any;
    expect(Object.keys(freeTests.on)).toContain('workflow_dispatch');
    expect(freeTests.jobs['free-tests'].if).toBe('always()');
    expect(freeTests.jobs['free-tests'].name).toBeUndefined();
    for (const [relative, jobName] of [
      ['.github/workflows/cso-runtime-promote.yml', 'propose'],
      ['.github/workflows/cso-scanner-images.yml', 'promote-catalog'],
    ]) {
      const job = (Bun.YAML.parse(readFileSync(join(ROOT, relative), 'utf8')) as any).jobs[jobName];
      expect(job.permissions.actions, relative).toBe('write');
      const script = job.steps.find((step: any) => step.run?.includes('gh pr create')).run as string;
      const pushed = script.indexOf('git push --set-upstream origin "$branch"');
      const dispatched = script.indexOf('gh workflow run free-tests.yml --repo "$GITHUB_REPOSITORY" --ref "$branch"');
      expect(pushed, relative).toBeGreaterThan(0);
      expect(dispatched, relative).toBeGreaterThan(pushed);
      expect(script.indexOf('gh pr create'), relative).toBeGreaterThan(dispatched);
    }
  });

  test('private qualification enters only through an actor-restricted protected environment and re-verifies staged attestations', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/cso-runtime-qualification.yml'), 'utf8');
    const workflow = Bun.YAML.parse(raw) as any;
    const job = workflow.jobs.qualify;
    expect(Object.keys(workflow.on)).toEqual(['repository_dispatch']);
    expect(job.environment).toBe('cso-runtime-release');
    expect(job.permissions).toEqual({ contents: 'read', packages: 'read', attestations: 'read', actions: 'read' });
    expect(job.needs).toBe('dispatch-summary');
    const summary = workflow.jobs['dispatch-summary'];
    expect(summary.permissions).toEqual({});
    expect(summary.environment).toBeUndefined();
    expect(summary.steps.every((step: any) => !step.uses)).toBe(true);
    expect(raw).toContain('test "$GITHUB_ACTOR" = "$CSO_QUALIFICATION_ACTOR"');
    expect(raw).toContain('.client_payload.statements | type == "array" and length == 10');
    expect(raw).not.toContain('^ghcr.io/');
    expect(raw).toContain('^ghcr\\\\.io/garrytan/gstack/cso-staging/');
    const names = job.steps.map((step: any) => step.name);
    const attested = names.indexOf('Verify each staged image attestation and normalize qualification statements');
    const staging = names.indexOf('Require one successful protected-main staging run with every native gate passed');
    const contract = names.indexOf('Enforce the complete release contract before retaining evidence');
    expect(attested).toBeGreaterThan(0);
    expect(staging).toBe(attested + 1);
    expect(contract).toBe(staging + 1);
    expect(job.steps[staging].run).toContain('gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?filter=latest&per_page=100"');
    expect(job.steps.at(-1).with.path).toContain('staging-run-evidence');
    expect(raw).toContain('--cert-identity "$signer"');
    expect(raw).toContain('--source-digest "$source_commit"');
    expect(raw).toContain('--deny-self-hosted-runners');
    expect(raw).toContain('Recheck public visibility and anonymous pulls for every qualified digest');
    expect(raw).toContain('scripts/cso-public-ghcr.ts verify');
    expect(raw).toContain('public-image-evidence');
    expect(raw).toContain('--remove-after');
    expect(raw).toContain('scripts/cso-runtime-promotion.ts');
    expect(raw).toContain('name: cso-qualified-runtime-statements');
    expect(raw).not.toContain('contents: write');
    for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });

  test('staged images enter the daemon only after signed evidence checks and before no-pull execution', () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/cso-runtime-images.yml'), 'utf8')) as any;
    const steps = workflow.jobs.stage.steps;
    const verified = steps.findIndex((s: any) => s.run?.includes('--predicate-type https://spdx.dev/Document/v2.3'));
    const pulled = steps.findIndex((s: any) => s.run?.includes('scripts/cso-public-ghcr.ts verify'));
    const executed = steps.findIndex((s: any) => s.run?.includes('test/cso-docker-integration.test.ts'));
    expect(verified).toBeGreaterThanOrEqual(0);
    expect(pulled).toBeGreaterThan(verified);
    expect(executed).toBeGreaterThan(pulled);
    expect(steps[pulled].env.CSO_IMAGE).toBe('${{ steps.image.outputs.name }}@${{ steps.build.outputs.digest }}');
    expect(steps[pulled].env.GH_TOKEN).toBe('${{ github.token }}');
    expect(steps[pulled].run).toContain('--image "$CSO_IMAGE" --platform "$CSO_PLATFORM"');
    expect(steps[pulled].run).toContain('--repository "$GITHUB_REPOSITORY" --output public-image.json');
    expect(steps[pulled]['continue-on-error']).not.toBe(true);
    const qualify=workflow.jobs['qualify-native'];
    const loaded=qualify.steps.findIndex((s:any)=>s.run?.includes('GSTACK_CSO_TEST_IMAGE'));
    const cold=qualify.steps.findIndex((s:any)=>s.run?.includes('bun run test:cso:docker'));
    expect(loaded).toBeGreaterThanOrEqual(0);expect(cold).toBeGreaterThan(loaded);
    expect(qualify.needs).toEqual(['reviewed-inputs','stage']);
    expect(qualify.steps.some((s:any)=>s.uses?.startsWith('docker/login-action@'))).toBe(false);
    expect(qualify.steps[loaded].run).toContain('scripts/cso-public-ghcr.ts verify');
    expect(qualify.steps[loaded].env.GH_TOKEN).toBe('${{ github.token }}');
  });

  test('the ingress payload gate accepts an optional evaluation reference and summarizes it before approval', () => {
    const script = (Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/cso-runtime-qualification.yml'), 'utf8')) as any).jobs['dispatch-summary'].steps[0].run;
    const dir = mkdtempSync(join(tmpdir(), 'cso-dispatch-summary-')); temps.push(dir);
    const event = join(dir, 'event.json'), summary = join(dir, 'summary.md');
    const dispatch = (payload: unknown) => {
      writeFileSync(event, JSON.stringify({ action: 'cso-runtime-qualified', client_payload: payload }));
      writeFileSync(summary, '');
      const result = runBashScript(script, { cwd: dir, env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary }, timeout: 30_000 });
      return { status: result.status, summary: readFileSync(summary, 'utf8') };
    };
    const statements = dispatchedStatements();
    expect(dispatch({ statements }).summary).toContain('- evaluationRef: `none`');
    const accepted = dispatch({ evaluationRef: EVALUATION_REF, statements });
    expect(accepted.status).toBe(0);
    expect(accepted.summary).toContain(`- evaluationRef: \`${EVALUATION_REF}\``);
    expect(accepted.summary).toContain(`- sourceCommit: \`${'a'.repeat(40)}\``);
    for (const statement of statements) expect(accepted.summary).toContain(`| \`${statement.runtimeId}\` | \`${statement.image}\` |`);
    const rejected = (payload: unknown) => expect(dispatch(payload).status).not.toBe(0);
    rejected({ evaluationRef: 'sha256:abc', statements });
    rejected({ evaluationRef: EVALUATION_REF.toUpperCase(), statements });
    rejected({ evaluationRef: null, statements });
    rejected({ evaluationRef: EVALUATION_REF, statements, finding: 'held-out detail' });
    rejected({ statements: statements.slice(1) });
    rejected({ statements: statements.map((item, index) => index ? item : { ...item, sourceCommit: 'b'.repeat(40) }) });
    rejected({ statements: statements.map((item, index) => index ? item : { ...item, image: item.image.replace('ghcr.io', 'ghcrxio') }) });
    rejected({ statements: statements.map((item, index) => index ? item : { ...item, runtimeId: 'node`|injected' }) });
  });

  test('the protected ingress binds verified statements to one successful staging run and never carries the evaluation reference', () => {
    const fixture = ingressFixture();
    const normalized = fixture.step('Verify each staged image attestation and normalize qualification statements');
    expect(normalized.status, normalized.stderr).toBe(0);
    const staging = fixture.step('Require one successful protected-main staging run with every native gate passed');
    expect(staging.status, staging.stderr).toBe(0);
    expect(staging.stdout).toContain('STAGING RUN VERIFIED');
    const contract = fixture.step('Enforce the complete release contract before retaining evidence');
    expect(contract.status, contract.stderr).toBe(0);

    const statements = committedImageBuildMatrix().include.map(row =>
      JSON.parse(readFileSync(join(fixture.work, 'qualification-evidence', row.runtimeId, 'qualified-runtime.json'), 'utf8')));
    for (const statement of statements) {
      expect(statement).not.toHaveProperty('evaluationRef');
      expect(statement.workflow).toBe('https://github.com/garrytan/gstack/actions/runs/555');
    }
    expect(JSON.parse(readFileSync(join(fixture.work, 'qualification-evidence', 'requalification.json'), 'utf8'))).toEqual(CURRENT_TRIGGERS);
    const candidate = JSON.stringify(catalogPromotionCandidate(committedCatalog, buildInputs, statements, CURRENT_TRIGGERS));
    expect(candidate).not.toContain('evaluationRef');
    expect(candidate).not.toContain('e'.repeat(64));

    for (const [mutate, error] of [
      [() => fixture.run({ conclusion: 'failure' }), 'STAGING_RUN_NOT_SUCCESSFUL'],
      [() => fixture.jobs('failure'), 'STAGING_NATIVE_GATE_NOT_PASSED'],
    ] as const) {
      fixture.run(); fixture.jobs(); mutate();
      rmSync(join(fixture.work, 'staging-run-evidence'), { recursive: true, force: true });
      const rejected = fixture.step('Require one successful protected-main staging run with every native gate passed');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(error);
    }
  });
});

describe('CSO evaluation-only candidate builds', () => {
  const revision = `cso-eval-123456-${'a'.repeat(12)}`;
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  function candidateFixture(catalogRevision = revision) {
    const dir = buildFixture(), outside = mkdtempSync(join(tmpdir(), 'gstack-cso-eval-out-')); temps.push(outside);
    mkdirSync(join(dir, 'test/helpers'), { recursive: true });
    const catalog = join(outside, 'candidate.json');
    writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, revision: catalogRevision, runtimes: [] }, null, 2) + '\n');
    return { dir, outside, catalog, output: join(outside, 'unit') };
  }
  const candidateBuild = (dir: string, catalog: string, output: string, extra = '') =>
    runBashScript(`${fakeBuildCommand(dir, extra)} --evaluation-candidate ${quote(catalog)} --output ${quote(output)}`, { timeout: 20_000 });

  test.skipIf(process.platform === 'win32')('builds a marked five-artifact producer unit outside the checkout without touching bin/', () => {
    const { dir, outside, catalog, output } = candidateFixture();
    const result = candidateBuild(dir, catalog, output);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ output, revision, evaluationOnly: true });
    expect(readdirSync(output).sort()).toEqual(['.gstack-cso-evaluation', '.gstack-cso-generation', 'cso-eval-producer', 'gstack-cso-core', 'gstack-cso-launcher', 'gstack-cso-watchdog']);
    const marker = JSON.parse(readFileSync(join(output, '.gstack-cso-evaluation'), 'utf8'));
    expect(marker).toEqual({ schemaVersion: 1, evaluationOnly: true, runtimeCatalogRevision: revision, runtimeCatalogSha256: sha(catalog), coreSha256: sha(join(output, 'gstack-cso-core')) });
    expect(readFileSync(join(output, '.gstack-cso-generation'), 'utf8')).toBe(`${marker.coreSha256}\n`);
    expect(readdirSync(join(dir, 'bin'))).toEqual([]);
    expect(readdirSync(outside).sort()).toEqual(['candidate.json', 'unit']);
    const args = readFileSync(join(dir, 'compiler.log'), 'utf8').trim().split('\n');
    const check = args.indexOf('check-evaluation');
    expect(check).toBeGreaterThan(0); expect(args[check + 1]).toBe('lib/cso/runtime-catalog.json');
    expect(check).toBeLessThan(args.indexOf('lib/cso/cli.ts'));
    expect(args).toContain('scripts/cso-eval-producer.ts');
    expect(args.filter(arg => arg === '--no-compile-autoload-package-json')).toHaveLength(2);
  });

  test.skipIf(process.platform === 'win32')('refuses unmarked catalogs, in-checkout or existing outputs, and leaves nothing on a failed check', () => {
    const plain = candidateFixture('cso-v3-123456-aaaaaaaaaaaa');
    expect(candidateBuild(plain.dir, plain.catalog, plain.output).status).toBe(65);
    const inside = candidateFixture();
    const insideResult = candidateBuild(inside.dir, inside.catalog, join(inside.dir, 'unit'));
    expect(insideResult.status).toBe(73); expect(existsSync(join(inside.dir, 'unit'))).toBe(false);
    const existing = candidateFixture(); mkdirSync(existing.output);
    expect(candidateBuild(existing.dir, existing.catalog, existing.output).status).toBe(73);
    const failed = candidateFixture();
    expect(candidateBuild(failed.dir, failed.catalog, failed.output, 'CSO_FAIL_COMPILER_N=1').status).toBe(42);
    expect(readdirSync(failed.outside)).toEqual(['candidate.json']);
  });

  test.skipIf(process.platform === 'win32')('distribution builds refuse an evaluation catalog in the source tree', () => {
    const dir = buildFixture();
    writeFileSync(join(dir, 'lib/cso/runtime-catalog.json'), JSON.stringify({ revision }, null, 2));
    const result = fakeBuild(dir);
    expect(result.status).toBe(65); expect(result.stderr).toContain('evaluation-only catalog');
    expect(existsSync(join(dir, 'compiler.log'))).toBe(false);
  });

  test('the candidate gate rejects the committed release catalog', () => {
    const result = spawnSync(process.execPath, ['scripts/cso-runtime-promotion.ts', 'check-evaluation', 'lib/cso/runtime-catalog.json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('NOT_AN_EVALUATION_CATALOG');
    expect(String((committedCatalog as { revision: string }).revision).startsWith('cso-eval-')).toBe(false);
  });

  test('setup refuses a marked or self-reporting evaluation helper', () => {
    const setup = readFileSync(join(ROOT, 'setup'), 'utf8');
    expect(setup).toContain('[ -e "$SOURCE_GSTACK_DIR/bin/.gstack-cso-evaluation" ]');
    expect(setup).toContain(`--version 2>/dev/null | grep -q '"evaluationOnly": *true'`);
    expect(setup.indexOf('bin/ holds an evaluation-only CSO helper')).toBeLessThan(setup.indexOf('provision-images --setup-summary'));
  });
});
