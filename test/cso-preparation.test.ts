import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectPreparation, railsTestConfiguration } from '../lib/cso/preparation';
import { assertRuntimeCompatible, RUNTIME_CATALOG, rollbackCatalog, selectRuntime, validateRuntimeCatalog } from '../lib/cso/runtime-catalog';
import { completeRuntimeCatalogFixture, qualifiedRuntimeFixture } from './helpers/cso-runtime-catalog';

const roots: string[] = [];
const hash = 'a'.repeat(64);
const sri = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'cso-preparation-')); roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nodeFiles = (version = 3) => ({
  'package.json': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' }, scripts: { postinstall: 'touch /tmp/CSO_UNSAFE' } },
  'package-lock.json': { name: 'app', lockfileVersion: version, packages: { '': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } }, 'node_modules/cookie': { version: '1.0.0', resolved: 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz', integrity: sri, hasInstallScript: true } } },
});
const gemLock = `GEM
  remote: https://rubygems.org/
  specs:
    rack (3.1.8)
    sqlite3 (2.5.0-x86_64-linux-gnu)

PLATFORMS
  ruby
  x86_64-linux-gnu

DEPENDENCIES
  rack
  sqlite3

RUBY VERSION
   ruby 3.3.6p108

BUNDLED WITH
   2.6.9
`;

describe('CSO inert Node preparation', () => {
  for (const version of [2, 3]) test(`accepts npm lock v${version} and separates lifecycle execution`, () => {
    const plan = inspectPreparation(fixture(nodeFiles(version)));
    expect(plan.status).toBe('ready'); expect(plan.stack).toBe('node');
    expect(plan.inputs).toHaveLength(1); expect(plan.inputs[0].integrity).toBe(sri);
    expect(plan.metadata.find(m => m.path === 'package.json')!.content).not.toContain('postinstall');
    expect(plan.acquisition[0].args).toContain('--ignore-scripts');
    expect(plan.acquisition[0].args).toContain('--no-audit');
    expect(plan.offline[0].args).toContain('--offline');
    expect(plan.offline[1].args[0]).toBe('rebuild');
  });
  test('rejects lock v1 without emitting executable fragments', () => {
    const plan = inspectPreparation(fixture(nodeFiles(1)));
    expect(plan.prerequisites[0].code).toBe('UNSUPPORTED_LOCK'); expect(plan.acquisition).toEqual([]); expect(plan.metadata).toEqual([]);
  });
  for (const url of ['https://user:secret@registry.npmjs.org/a.tgz', 'http://registry.npmjs.org/a.tgz', 'https://registry.npmjs.org.evil.invalid/a.tgz', 'https://127.0.0.1/a.tgz', 'git+ssh://github.com/a/b', 'https://registry.npmjs.org/a.tgz?token=secret']) test(`rejects non-public archive ${url.split('@').at(-1)}`, () => {
    const files = nodeFiles(); files['package-lock.json'].packages['node_modules/cookie'].resolved = url;
    const plan = inspectPreparation(fixture(files)); expect(plan.status).toBe('prerequisites'); expect(plan.acquisition).toEqual([]);
  });
  test('rejects archive without cryptographic integrity', () => {
    const files = nodeFiles(); files['package-lock.json'].packages['node_modules/cookie'].integrity = 'sha1-weak';
    expect(inspectPreparation(fixture(files)).prerequisites[0].code).toBe('UNPINNED_ARCHIVE');
  });
  test('rejects hostile workspace paths before package-manager invocation', () => {
    const files: any = nodeFiles(); files['package.json'].workspaces = ['../../host/*'];
    expect(inspectPreparation(fixture(files)).prerequisites[0].code).toBe('EXTERNAL_PATH');
  });
  test('contains and sanitizes declared workspaces', () => {
    const files: any = nodeFiles();
    files['package.json'].workspaces = ['packages/*'];
    files['package-lock.json'].packages['packages/local'] = { name: 'local', version: '1.0.0' };
    files['package-lock.json'].packages['node_modules/local'] = { resolved: 'packages/local', link: true };
    files['packages/local/package.json'] = { name: 'local', version: '1.0.0', scripts: { install: 'false' } };
    const plan = inspectPreparation(fixture(files)); expect(plan.status).toBe('ready');
    expect(plan.inputs.some(i => i.kind === 'local')).toBe(true);
    expect(plan.metadata.find(m => m.path === 'packages/local/package.json')!.content).not.toContain('scripts');
  });
  test('never follows metadata symlinks', () => {
    const root = fixture({ 'secret.json': nodeFiles()['package.json'] }); symlinkSync('secret.json', join(root, 'package.json'));
    const plan = inspectPreparation(root); expect(plan.status).toBe('prerequisites'); expect(plan.prerequisites[0].code).toBe('UNSAFE_METADATA');
  });
});

describe('CSO inert Bun preparation', () => {
  test('accepts text locks with trailing commas and ignores scripts online', () => {
    const plan = inspectPreparation(fixture({
      'package.json': nodeFiles()['package.json'],
      'bun.lock': `{"lockfileVersion":1,"workspaces":{"":{"name":"app","dependencies":{"cookie":"1.0.0",},},},"packages":{"cookie":["cookie@1.0.0","",{},"${sri}"],},}`,
      'bunfig.toml': 'preload = ["./hostile.ts"]',
    }));
    expect(plan.status).toBe('ready'); expect(plan.stack).toBe('bun');
    expect(plan.acquisition[0].args).toContain('--frozen-lockfile'); expect(plan.acquisition[0].args).toContain('--ignore-scripts');
    expect(plan.acquisition[0].args).toContain('--config=/opt/cso/empty-config'); expect(plan.acquisition[0].args).toContain('--registry=https://registry.npmjs.org');
    expect(plan.offline[0].args).toContain('--backend=copyfile');
    expect(plan.metadata.some(m => m.path === 'bunfig.toml')).toBe(false);
  });
  test('does not treat lock text as JavaScript', () => {
    const plan = inspectPreparation(fixture({ 'bun.lock': '({workspaces: (()=>{throw Error("EXECUTED")})()})' }));
    expect(plan.prerequisites[0].code).toBe('INVALID_METADATA');
  });
  test('reports binary lock prerequisite', () => {
    expect(inspectPreparation(fixture({ 'bun.lockb': 'binary', 'package.json': {} })).prerequisites[0].code).toBe('UNSUPPORTED_LOCK');
  });
});

describe('CSO inert Python preparation', () => {
  test('requires exact hashed wheels and excludes target config', () => {
    const plan = inspectPreparation(fixture({ 'requirements.txt': `# generated pins\nFlask==3.1.0 \\\n --hash=sha256:${hash}\n`, 'pip.conf': '[global]\nextra-index-url=https://evil.invalid' }));
    expect(plan.status).toBe('ready'); expect(plan.inputs[0].name).toBe('Flask');
    expect(plan.acquisition[0].args).toContain('--only-binary=:all:'); expect(plan.acquisition[0].args).toContain('--require-hashes');
    expect(plan.metadata).toHaveLength(1); expect(plan.offline[1].args).toContain('--no-index');
  });
  for (const requirement of ['flask>=3', '-e .', 'flask @ https://evil.invalid/x.whl', '--index-url https://evil.invalid', '-r other.txt', 'flask==3.1.0']) test(`rejects unpinned or executable requirement ${requirement}`, () => {
    expect(inspectPreparation(fixture({ 'requirements.txt': requirement })).prerequisites[0].code).toBe('UNPINNED_REQUIREMENTS');
  });
  const uvFixture = () => ({
    'uv.lock': `version = 1\nrequires-python = ">=3.12"\n[[package]]\nname = "app"\nversion = "1.0.0"\nsource = { editable = "." }\n[[package]]\nname = "flask"\nversion = "3.1.0"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{url = "https://files.pythonhosted.org/packages/flask.whl", hash = "sha256:${hash}"}]\n`,
    'pyproject.toml': '[project]\nname="app"\nversion="1.0.0"\ndependencies=["flask==3.1.0"]\n[build-system]\nrequires=[]\nbuild-backend="evil_backend"\n',
  });
  test('uv explicitly omits first-party packages during online export', () => {
    const plan = inspectPreparation(fixture(uvFixture())); expect(plan.status).toBe('ready');
    expect(plan.acquisition[0].args).toContain('--no-emit-local'); expect(plan.acquisition[0].args).toContain('--frozen');
    expect(plan.metadata.find(m => m.path === 'pyproject.toml')!.content).not.toContain('evil_backend');
    expect(plan.offline[0].args).toContain('--offline');
    expect(plan.offline.some(command => command.args.includes('--require-hashes'))).toBe(true);
    expect(plan.offline.find(c => c.args.includes('--no-build-isolation'))!.args).toContain('/work/.');
    expect(plan.inputs.some(i => i.kind === 'local' && i.path === '.')).toBe(true);
  });
  test('uv rejects local packages outside the snapshot', () => {
    const files = uvFixture(); files['uv.lock'] = files['uv.lock'].replace('editable = "."', 'editable = "../private"');
    expect(inspectPreparation(fixture(files)).prerequisites[0].code).toBe('EXTERNAL_PATH');
  });
  test('uv rejects public dependencies with only source distributions', () => {
    const files = uvFixture(); files['uv.lock'] = files['uv.lock'].replace(/wheels = .*/, 'wheels = []');
    expect(inspectPreparation(fixture(files)).prerequisites[0].code).toBe('MISSING_PUBLIC_WHEEL');
  });
  test('uv reports cross-platform marker locks as a readiness prerequisite', () => {
    const files = uvFixture();
    files['uv.lock'] = files['uv.lock'].replace('[[package]]\nname = "flask"', `[[package]]\nname = "colorama"\nversion = "0.4.6"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{url = "https://files.pythonhosted.org/packages/colorama.whl", hash = "sha256:${hash}"}]\ndependencies = [{ name = "win32", marker = "sys_platform == 'win32'" }]\n[[package]]\nname = "flask"`);
    const plan = inspectPreparation(fixture(files));
    expect(plan.status).toBe('prerequisites');
    expect(plan.prerequisites.some(item => item.code === 'UNSUPPORTED_MARKER')).toBe(true);
  });
  test('uv requires exact public wheels for every local build dependency', () => {
    const files = uvFixture(); files['pyproject.toml'] = files['pyproject.toml'].replace('requires=[]', 'requires=["setuptools>=40.8.0"]');
    expect(inspectPreparation(fixture(files)).prerequisites[0].code).toBe('MISSING_BUILD_DEPENDENCY');
  });
});

describe('CSO inert Rails preparation', () => {
  test('does not silently choose Node in a multi-stack repository',()=>{const plan=inspectPreparation(fixture({...nodeFiles(),'Gemfile.lock':gemLock,'Gemfile':''}));expect(plan.status).toBe('prerequisites');expect(plan.prerequisites[0].code).toBe('MULTIPLE_STACKS');expect(inspectPreparation(fixture({...nodeFiles(),'Gemfile.lock':gemLock,'Gemfile':''}),'rails').stack).toBe('rails');});
  test('fetches exact gems without evaluating Gemfiles or building native extensions', () => {
    const plan = inspectPreparation(fixture({ 'Gemfile.lock': gemLock, 'Gemfile': 'system("touch /tmp/CSO_UNSAFE")\nsource "https://rubygems.org"' }));
    expect(plan.status).toBe('ready'); expect(plan.stack).toBe('rails'); expect(plan.metadata.some(m => m.path === 'Gemfile')).toBe(false);
    expect(plan.acquisition).toHaveLength(2); expect(plan.acquisition.every(c => c.args[0] === 'fetch')).toBe(true);
    expect(plan.inputs[1].platform).toBe('x86_64-linux-gnu'); expect(plan.inputs[0].integritySource).toBe('registry-on-acquisition');
    expect(plan.runtimeRequirements).toEqual({ ruby: '3.3.6', bundler: '2.6.9' });
    expect(plan.offline[0].args).toContain('--local'); expect(plan.offline[0].env.BUNDLE_IGNORE_CONFIG).toBe('true');
    expect(plan.offline[0].env.GEM_HOME).toBeUndefined(); expect(plan.offline[0].env.GEM_PATH).toBeUndefined();
  });
  test('records lock checksums separately from newly acquired archive hashes', () => {
    const plan = inspectPreparation(fixture({ 'Gemfile.lock': gemLock + `\nCHECKSUMS\n  rack (3.1.8) sha256=${hash}\n`, 'Gemfile': '' }));
    expect(plan.status).toBe('ready'); expect(plan.inputs[0].integrity).toBe(`sha256:${hash}`); expect(plan.inputs[0].integritySource).toBe('lock');
  });
  for (const section of ['GIT', 'PATH', 'PLUGIN']) test(`rejects ${section} sources`, () => {
    expect(inspectPreparation(fixture({ 'Gemfile.lock': gemLock + `\n${section}\n  remote: https://evil.invalid\n`, 'Gemfile': '' })).prerequisites[0].code).toBe('UNSUPPORTED_SOURCE');
  });
  test('enumerates every static connection without evaluating ERB', () => {
    const plan = inspectPreparation(fixture({ 'Gemfile.lock': gemLock, 'Gemfile': '', 'config/database.yml': `test:\n  primary:\n    adapter: sqlite3\n    database: <%= ENV["DATABASE_URL"] %>\n  queue:\n    adapter: postgresql\nproduction:\n  analytics:\n    adapter: postgresql\n` }));
    expect(plan.status).toBe('ready'); expect(plan.database?.connections).toEqual(['analytics', 'primary', 'queue']);
    for (const adapter of ['sqlite', 'postgresql'] as const) {
      const files = railsTestConfiguration(plan.database!.connections, adapter);
      const database = JSON.parse(files[0].content); expect(Object.keys(database.test)).toHaveLength(3); expect(database.production).toBeUndefined();
      expect(files.map(f => f.content).join('')).not.toContain('ENV["DATABASE_URL"]');
    }
  });
  test('accepts the stock Rails default anchor without expanding arbitrary YAML aliases',()=>{
    const database=`default: &default\n  adapter: sqlite3\n  pool: 5\ntest:\n  <<: *default\n  database: storage/test.sqlite3\nproduction:\n  primary:\n    <<: *default\n    database: storage/primary.sqlite3\n  queue:\n    <<: *default\n    database: storage/queue.sqlite3\n`;
    const plan=inspectPreparation(fixture({'Gemfile.lock':gemLock,'Gemfile':'','config/database.yml':database}),'rails');
    expect(plan.status).toBe('ready');expect(plan.database).toMatchObject({supported:['sqlite'],selected:'sqlite',connections:['primary','queue']});
    const hostile=database.replace('primary:\n','primary: &primary\n').replace('queue:\n','queue:\n    <<: *primary\n');
    expect(inspectPreparation(fixture({'Gemfile.lock':gemLock,'Gemfile':'','config/database.yml':hostile}),'rails').prerequisites[0].code).toBe('DYNAMIC_DATABASE_CONFIG');
  });
  test('advertises and selects only database adapters actually present in the lock',()=>{
    const pgLock=gemLock.replace('sqlite3 (2.5.0-x86_64-linux-gnu)','pg (1.5.9)').replace(/sqlite3/g,'pg');
    const pg=inspectPreparation(fixture({'Gemfile.lock':pgLock,'Gemfile':'','config/database.yml':'test:\n  adapter: postgresql\n  database: app_test\n'}),'rails');
    expect(pg.status).toBe('ready');expect(pg.database).toMatchObject({supported:['postgresql'],selected:'postgresql'});
    const noAdapter=gemLock.replace('    sqlite3 (2.5.0-x86_64-linux-gnu)\n','').replace('  sqlite3\n','');
    expect(inspectPreparation(fixture({'Gemfile.lock':noAdapter,'Gemfile':''}),'rails').prerequisites[0].code).toBe('MISSING_DATABASE_ADAPTER');
  });
  test('structural ERB requires explicit synthetic connection names', () => {
    const plan = inspectPreparation(fixture({ 'Gemfile.lock': gemLock, 'Gemfile': '', 'config/database.yml': '<% dynamic_config %>\n' }));
    expect(plan.prerequisites[0].code).toBe('DYNAMIC_DATABASE_CONFIG'); expect(plan.acquisition).toEqual([]);
  });
  test('rejects prototype-mutating synthetic connection names', () => {
    expect(() => railsTestConfiguration(['__proto__'], 'sqlite')).toThrow('Invalid Rails connection names');
  });
});

describe('CSO runtime catalog admission', () => {
  const runtime = () => qualifiedRuntimeFixture('node');
  const catalog = () => completeRuntimeCatalogFixture('test-1');
  test('default catalog cannot execute unqualified images', () => {
    expect(RUNTIME_CATALOG.profiles).toHaveLength(10);
    expect(RUNTIME_CATALOG.runtimes).toEqual([]);
    expect(() => selectRuntime('node', 'linux/amd64')).toThrow('Reviewed build profile node-24.4.0-amd64 is awaiting a qualified image promotion');
  });
  test('selects exact qualified digest and platform', () => {
    expect(selectRuntime('node', 'linux/amd64', catalog()).image).toContain('@sha256:');
    expect(selectRuntime('node', 'linux/arm64', catalog()).platform).toBe('linux/arm64');
    expect(() => selectRuntime('missing', 'linux/arm64', catalog())).toThrow('MISSING_QUALIFIED_RUNTIME');
  });
  test('runtime stack and declared tool versions must match preparation',()=>{const files:any=nodeFiles();files['package.json'].engines={node:'>=24 <25'};files['package.json'].packageManager='npm@^11.0.0';const plan=inspectPreparation(fixture(files),'node'),good=runtime();expect(()=>assertRuntimeCompatible(plan,good)).not.toThrow();good.versions.node='23.9.0';expect(()=>assertRuntimeCompatible(plan,good)).toThrow('does not satisfy');const wrong={...runtime(),stack:'python' as const,versions:{python:'3.12.1',uv:'0.8.0'}};expect(()=>assertRuntimeCompatible(plan,wrong)).toThrow('cannot run');});
  test('a Bun-backed node fallback cannot satisfy a declared Node engine', () => {
    const plan = inspectPreparation(fixture({
      'package.json': { name: 'app', version: '1.0.0', engines: { node: '>=24' } },
      'bun.lock': `{"lockfileVersion":1,"workspaces":{"":{"name":"app"}},"packages":{}}`,
    }), 'bun');
    expect(plan.status).toBe('ready');
    const bunRuntime = {
      ...runtime(), id: 'bun-qualified-test', stack: 'bun' as const,
      versions: { bun: '1.3.10', 'cso-preparation': '1.0.0' },
    };
    expect(() => assertRuntimeCompatible(plan, bunRuntime)).toThrow('does not declare a real node release');
  });
  test('rejects tags and missing qualification evidence', () => {
    const c = catalog(); c.runtimes[0].image = 'node:latest'; expect(() => validateRuntimeCatalog(c)).toThrow('UNQUALIFIED_RUNTIME');
    c.runtimes[0] = runtime(); (c.runtimes[0].qualification as any).heldOutRepairPassed = false; expect(() => validateRuntimeCatalog(c)).toThrow('MISSING_APPLICATION_QUALIFICATION');
  });
  test('qualification evidence is exact and specific to application and PostgreSQL roles', () => {
    const missingVerifierEvidence=catalog();delete (missingVerifierEvidence.runtimes[0].qualification as any).positiveNegativeAssertionsPassed;
    expect(()=>validateRuntimeCatalog(missingVerifierEvidence)).toThrow('MISSING_APPLICATION_QUALIFICATION');
    const application=catalog();(application.runtimes[0].qualification as any).multiDatabasePassed=true;
    expect(()=>validateRuntimeCatalog(application)).toThrow('MISSING_APPLICATION_QUALIFICATION');
    const valid=catalog();expect(()=>validateRuntimeCatalog(valid)).not.toThrow();
    const postgresql=valid.runtimes.find(item=>item.stack==='postgresql'&&item.platform==='linux/amd64')!;
    (postgresql.qualification as any).heldOutRepairPassed=true;
    expect(()=>validateRuntimeCatalog(valid)).toThrow('MISSING_POSTGRESQL_QUALIFICATION');
    const standaloneVerifier=catalog();Object.assign(standaloneVerifier.runtimes[0],{stack:'verifier',versions:{verifier:'1.0.0'}});
    expect(()=>validateRuntimeCatalog(standaloneVerifier)).toThrow('UNSUPPORTED_RUNTIME_PLATFORM');
  });
  test('rejects partial nonempty catalogs and images outside the promoted gstack namespace', () => {
    const partial = catalog(); partial.runtimes = [partial.runtimes[0]];
    expect(() => validateRuntimeCatalog(partial)).toThrow('INCOMPLETE_QUALIFIED_RUNTIME_MATRIX');
    const arbitrary = catalog(); arbitrary.runtimes[0].image = `ghcr.io/attacker/forged@sha256:${hash}`;
    expect(() => validateRuntimeCatalog(arbitrary)).toThrow('UNQUALIFIED_RUNTIME');
  });
  test('rollback requires the previous compatible helper/catalog pair', () => {
    const previous = catalog(); const current = completeRuntimeCatalogFixture('test-2', 'test-1');
    expect(rollbackCatalog(current, previous)).toBe(previous);
    expect(() => rollbackCatalog({ ...current, previousRevision: 'other' }, previous)).toThrow('INCOMPATIBLE_RUNTIME_ROLLBACK');
  });
});
