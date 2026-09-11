import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PublicArchiveCache } from '../lib/cso/cache';
import type { VerificationRequest } from '../lib/cso/contracts';
import { dockerEndpoint, type DockerEndpoint } from '../lib/cso/docker';
import { DockerPreparationSandboxRunner } from '../lib/cso/preparation-docker';
import {
  admitPreparationRuntime, admitPreparationSidecar, PreparationExecutor,
  type PreparedApplication, type PreparationRuntimeAdmission, type RailsDatabaseSelection,
} from '../lib/cso/preparation-executor';
import { inspectPreparation, type CsoStack, type PreparationPlan } from '../lib/cso/preparation';
import { CSO_HELPER_ABI, type QualifiedRuntime, type RuntimeCatalog } from '../lib/cso/runtime-catalog';
import { completeRuntimeCatalogFixture } from './helpers/cso-runtime-catalog';
import { secureDirectory } from '../lib/cso/state';
import { canonicalStartPlan, canonicalTestPlan, DockerVerificationExecutor } from '../lib/cso/verification';

const requestedStack = process.env.GSTACK_CSO_TEST_STACK;
const requested = process.env.GSTACK_CSO_DOCKER_TESTS === '1' && ['bun', 'python', 'rails'].includes(requestedStack ?? '');
const suite = requested ? describe : describe.skip;
const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
let root = '', watchdog = '', endpoint: DockerEndpoint, runtime: QualifiedRuntime, catalog: RuntimeCatalog;

function qualification(kind: 'application' | 'postgresql') {
  const common = { sourceCommit: 'b'.repeat(40), workflow: 'https://github.com/garrytan/gstack/actions/runs/1',
    sbomDigest: `sha256:${'b'.repeat(64)}`, provenanceDigest: `sha256:${'c'.repeat(64)}`, verifiedProvenance: true as const };
  return kind === 'application'
    ? { ...common, kind, containmentPassed: true as const, coldStartPassed: true as const, positiveNegativeAssertionsPassed: true as const, heldOutRepairPassed: true as const }
    : { ...common, kind, containmentPassed: true as const, coldStartPassed: true as const, multiDatabasePassed: true as const, readinessPassed: true as const };
}
function qualified(stack: CsoStack | 'postgresql', image: string, versions: Record<string, string>): QualifiedRuntime {
  return { id: `${stack}-staged-cold-${process.arch}`, stack, platform, state: 'qualified', image,
    entrypoint: '/opt/cso/entrypoint', helperAbi: CSO_HELPER_ABI, versions, policyVersion: 'cso-isolation-v1',
    qualifiedAt: '2026-09-09T00:00:00.000Z', qualification: qualification(stack === 'postgresql' ? 'postgresql' : 'application') };
}
function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
}
function bunSource(directory: string): void {
  writeFiles(directory, {
    'package.json': JSON.stringify({ name: 'cso-bun-cold', version: '1.0.0', private: true,
      scripts: { start: 'bun app.js', test: 'bun test' }, dependencies: { 'escape-html': '1.0.3' } }) + '\n',
    'bun.lock': `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": { "": { "name": "cso-bun-cold", "dependencies": { "escape-html": "1.0.3" } } },
  "packages": { "escape-html": ["escape-html@1.0.3", "", {}, "sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow=="] }
}\n`,
    'app.js': `import escape from "escape-html";
const port=Number(process.env.PORT);Bun.serve({hostname:"127.0.0.1",port,fetch(request){const route=new URL(request.url).pathname;if(route==="/control")return new Response("CONTROL_OK:"+escape("<dependency>"));if(route==="/security")return new Response("DENIED",{status:403});return new Response("missing",{status:404})}});
`,
    'app.test.js': `import {expect,test} from "bun:test";import escape from "escape-html";test("cold dependency is executable",()=>expect(escape("<dependency>")).toBe("&lt;dependency&gt;"));\n`,
  });
}
function pythonSource(directory: string): void {
  writeFiles(directory, {
    'requirements.txt': `Django==4.2.30 --hash=sha256:4d07aaf1c62f9984842b67c2874ebbf7056a17be253860299b93ae1881faad65
asgiref==3.11.1 --hash=sha256:e8667a091e69529631969fd45dc268fa79b99c92c5fcdda727757e52146ec133
sqlparse==0.5.5 --hash=sha256:12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba
typing_extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
`,
    'manage.py': `#!/usr/bin/env python3
import os,sys
os.environ.setdefault("DJANGO_SETTINGS_MODULE","settings")
from django.core.management import execute_from_command_line
execute_from_command_line(sys.argv)
`,
    'settings.py': `SECRET_KEY="cso-cold-fixture"\nDEBUG=False\nALLOWED_HOSTS=["127.0.0.1"]\nROOT_URLCONF="urls"\nINSTALLED_APPS=[]\nMIDDLEWARE=[]\n`,
    'urls.py': `from django.http import HttpResponse
from django.urls import path
def control(_request): return HttpResponse("CONTROL_OK:Django")
def security(_request): return HttpResponse("DENIED",status=403)
urlpatterns=[path("control",control),path("security",security)]
`,
    'test_app.py': `import os,unittest
os.environ.setdefault("DJANGO_SETTINGS_MODULE","settings")
import django
django.setup()
from django.test import Client
class ColdStartTest(unittest.TestCase):
  def test_dependency_and_control(self): self.assertContains(Client().get("/control"),"CONTROL_OK",status_code=200)
`,
  });
}
function railsSource(directory: string, bundlerVersion: string): void {
  let lock = fs.readFileSync(path.join(import.meta.dir, 'fixtures/cso-eval/rails.Gemfile.lock'), 'utf8');
  lock = lock.replace('    pp (0.6.4)\n', '    pg (1.6.2)\n    pp (0.6.4)\n')
    .replace('  puma (= 7.2.0)\n', '  pg (= 1.6.2)\n  puma (= 7.2.0)\n')
    .replace(/(BUNDLED WITH\n)\s+[^\n]+/, `$1   ${bundlerVersion}`);
  writeFiles(directory, {
    'Gemfile': `source "https://rubygems.org"\ngem "rails", "= 8.1.2"\ngem "puma", "= 7.2.0"\ngem "sqlite3", "= 2.9.0"\ngem "pg", "= 1.6.2"\n`,
    'Gemfile.lock': lock,
    'config/boot.rb': `ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)\nrequire "bundler/setup"\n`,
    'config/application.rb': `require_relative "boot"\nrequire "rails"\nrequire "active_record/railtie"\nrequire "action_controller/railtie"\nmodule CsoCold;class Application < Rails::Application;config.load_defaults 8.1;config.eager_load=false;config.hosts.clear;end;end\n`,
    'config/environment.rb': `require_relative "application"\nRails.application.initialize!\n`,
    'config/routes.rb': `Rails.application.routes.draw do\n get "/control",to:"probe#control"\n get "/security",to:"probe#security"\nend\n`,
    'config/environments/test.rb': `Rails.application.configure do\n config.eager_load=false\n config.consider_all_requests_local=true\nend\n`,
    'config/database.yml': `default: &default\n  pool: 3\ntest:\n  primary:\n    <<: *default\n    adapter: sqlite3\n    database: storage/test.sqlite3\n  queue:\n    <<: *default\n    adapter: postgresql\n    database: cso_queue\n`,
    'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base;end\n`,
    'app/controllers/probe_controller.rb': `class ProbeController < ApplicationController\n def control;render plain:"CONTROL_OK:Rails";end\n def security;render plain:"DENIED",status: :forbidden;end\nend\n`,
    'Rakefile': `require_relative "config/application"\nRails.application.load_tasks\n`,
    'config.ru': `require_relative "config/environment"\nrun Rails.application\n`,
    'db/schema.rb': `ActiveRecord::Schema[8.1].define(version: 1) do\n create_table :cold_records, force: true do |t|\n  t.string :name\n end\nend\n`,
    'test/test_helper.rb': `ENV["RAILS_ENV"] ||= "test"\nrequire_relative "../config/environment"\nrequire "rails/test_help"\n`,
    'test/cold_start_test.rb': `require "test_helper"\nclass ColdStartTest < ActionDispatch::IntegrationTest\n test "control boots" do\n  get "/control"\n  assert_response :success\n  assert_includes response.body,"CONTROL_OK"\n end\nend\n`,
  });
}
function readyPlan(source: string, stack: CsoStack): PreparationPlan {
  const plan = inspectPreparation(source, stack);
  if (plan.status !== 'ready') throw new Error(`${stack} cold fixture is not ready: ${plan.prerequisites.map(item => `${item.code}: ${item.message}`).join('; ')}`);
  return plan;
}
function preparation(runDir: string, admission: PreparationRuntimeAdmission): PreparationExecutor {
  const staging = secureDirectory(path.join(runDir, 'archive-staging'));
  const cache = new PublicArchiveCache({ root: path.join(runDir, 'public-cache'), stagingRoot: staging, maxBytes: 512 * 1024 * 1024 });
  const runner = new DockerPreparationSandboxRunner({ endpoint, watchdogPath: watchdog, runRoot: runDir,
    controlRoot: secureDirectory(path.join(runDir, 'preparation-execution')), admission });
  return new PreparationExecutor({ cache, runner, materializationRoot: secureDirectory(path.join(runDir, 'archive-materializations')) });
}
function requestFor(source: string, stack: CsoStack, port: number): VerificationRequest {
  const start = canonicalStartPlan(source, stack, port), tests = canonicalTestPlan(source, stack);
  return { findingId: 'd'.repeat(32), runtimeProfile: runtime.id, port, start: start.command,
    legitimate: [{ name: 'cold-start control', path: '/control', method: 'GET', expected: { status: 200, includes: 'CONTROL_OK' } }],
    security: { name: 'fixture denial', path: '/security', method: 'GET', expected: { status: 403, includes: 'DENIED' }, vulnerable: { status: 200, includes: 'SECRET' } },
    existingTests: tests.commands, fixtures: {}, boundaryFiles: start.entrypointFiles, testFiles: tests.files, changes: [],
    review: { reviewer: 'cold-start-gate', independent: true, rootCauseRepaired: true, featurePreserved: true,
      boundaryMocks: false, rationale: 'Cold-start execution only.', reviewedPatchHash: 'e'.repeat(64) } };
}
async function executeCold(stack: CsoStack, source: string, runDir: string, port: number, database?: RailsDatabaseSelection): Promise<PreparedApplication> {
  const plan = readyPlan(source, stack), admission = admitPreparationRuntime({ plan, platform, profile: runtime.id, catalog });
  const prep = preparation(runDir, admission), deadline = Date.now() + 15 * 60_000;
  const closure = await prep.acquire({ plan, admission, snapshot: source, deadline });
  expect(closure.archives.length).toBeGreaterThan(0);
  expect(closure.archives.every(item => item.requestedUrl.startsWith('https://'))).toBe(true);
  if (stack === 'bun') expect(closure.archives.every(item => item.resolvedUrl?.startsWith('https://'))).toBe(true);
  else expect(closure.archives.every(item => item.resolvedUrl === null)).toBe(true);
  const prepared = await prep.prepareOffline({ plan, admission, snapshot: source, closure, deadline, database });
  try {
    const observation = await new DockerVerificationExecutor(endpoint, watchdog, deadline).observe(
      prepared.preparedRoot, 'after', requestFor(prepared.preparedRoot, stack, port), runtime, runtime,
      secureDirectory(path.join(runDir, 'observations')), secureDirectory(path.join(runDir, 'verification-controls')),
      { environment: prepared.executionEnvironment, database: prepared.database },
    );
    expect(observation).toMatchObject({ booted: true, legitimate: true, security: 'pass', existingTests: true });
    return prepared;
  } finally { await prep.dispose(prepared); }
}

beforeAll(async () => {
  if (!requested) return;
  const image = process.env.GSTACK_CSO_TEST_IMAGE;
  if (!image) throw new Error(`${requestedStack} cold-start qualification requires GSTACK_CSO_TEST_IMAGE; a requested gate cannot skip`);
  if (process.env.GSTACK_CSO_TEST_PLATFORM !== platform) throw new Error(`${requestedStack} cold-start qualification requires native ${platform}`);
  const versions = JSON.parse(process.env.GSTACK_CSO_EXPECTED_VERSIONS || '{}') as Record<string, string>;
  for (const key of ({ bun: ['bun','cso-preparation'], python: ['python','uv','cso-preparation'], rails: ['ruby','bundler','cso-preparation'] } as const)[requestedStack as 'bun'|'python'|'rails'])
    if (!/^\d+\.\d+\.\d+$/.test(versions[key] ?? '')) throw new Error(`${requestedStack} cold-start qualification requires exact ${key} metadata`);
  root = fs.mkdtempSync(path.join(os.tmpdir(), `cso-${requestedStack}-cold-`)); process.env.GSTACK_HOME = path.join(root, 'state');
  watchdog = path.resolve(import.meta.dir, '../bin/gstack-cso-watchdog');
  if (!fs.existsSync(watchdog)) throw new Error(`${requestedStack} cold-start qualification requires the compiled CSO watchdog`);
  endpoint = await dockerEndpoint(secureDirectory(path.join(root, 'docker-home')), { HOME: root, DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock' });
  catalog = completeRuntimeCatalogFixture(`${requestedStack}-staged-cold`);
  const installRuntime = (value: QualifiedRuntime): QualifiedRuntime => {
    const runtimeIndex = catalog.runtimes.findIndex(item => item.stack === value.stack && item.platform === value.platform);
    const profile = catalog.profiles.find(item => item.stack === value.stack && item.platform === value.platform)!;
    const installed = { ...value, id: profile.id };
    catalog.runtimes[runtimeIndex] = installed;
    profile.versions = { ...installed.versions };
    return installed;
  };
  runtime = installRuntime(qualified(requestedStack as CsoStack, image, versions));
  if (requestedStack === 'rails') {
    const postgresImage = process.env.GSTACK_CSO_TEST_POSTGRES_IMAGE;
    const postgresVersion = process.env.GSTACK_CSO_TEST_POSTGRES_VERSION;
    if (!postgresImage || !/^\d+\.\d+(?:\.\d+)?$/.test(postgresVersion ?? '')) throw new Error('Rails cold-start qualification requires a staged PostgreSQL digest and exact version');
    installRuntime(qualified('postgresql', postgresImage, { postgresql: postgresVersion! }));
  }
});
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); delete process.env.GSTACK_HOME; });

suite('CSO staged Bun, Python, and Rails cold-start journeys', () => {
  test('acquires, prepares, boots, controls, and tests the requested staged stack with no target egress', async () => {
    const source = secureDirectory(path.join(root, 'source'));
    if (requestedStack === 'bun') bunSource(source);
    else if (requestedStack === 'python') pythonSource(source);
    else railsSource(source, runtime.versions.bundler);
    if (requestedStack !== 'rails') {
      const prepared = await executeCold(requestedStack as CsoStack, source, secureDirectory(path.join(root, 'run')), requestedStack === 'bun' ? 34610 : 34611);
      expect(prepared.database).toBeUndefined();
      return;
    }
    const plan = readyPlan(source, 'rails');
    expect(plan.database).toMatchObject({ supported: ['sqlite', 'postgresql'], connections: ['primary', 'queue'] });
    const appAdmission = admitPreparationRuntime({ plan, platform, profile: runtime.id, catalog });
    const sidecar = admitPreparationSidecar({ platform, catalog });
    const sqlite = await executeCold('rails', source, secureDirectory(path.join(root, 'run-sqlite')), 34612, { adapter: 'sqlite' });
    expect(sqlite.database).toEqual({ adapter: 'sqlite', connections: ['primary', 'queue'] });
    const postgres = await executeCold('rails', source, secureDirectory(path.join(root, 'run-postgresql')), 34613, { adapter: 'postgresql', sidecar });
    expect(postgres.database).toMatchObject({ adapter: 'postgresql', connections: ['primary', 'queue'], sidecar: { id: sidecar.runtime.id } });
    expect(appAdmission.catalogRevision).toBe(sidecar.catalogRevision);
  }, 25 * 60_000);
});
