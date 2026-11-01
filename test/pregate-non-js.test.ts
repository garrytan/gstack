/**
 * gstack-pregate on non-JS repos (#3266, #3267, #3268): free regressions on
 * fixture repos with no .gstack/pregate.json, the state a user is in before
 * opting in. Django files loaded by name select the app's tests (or the
 * suite through the settings module); assets, licence text and dotfile tool
 * config take an empty lane; `init` drafts a policy from the repo. Each
 * case keeps a negative control: unmapped source code still fails closed, a
 * repo without Django settings gets no Django edges, and runtime dotfiles and
 * plain text stay unmapped. Dart lanes are covered by pregate-dart.test.ts,
 * the --base refusal by pregate-wtree-refusal.test.ts; the last block pins the
 * review fixes made while porting #3285 (shell scopes, Dart directive shapes).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { referencesIn } from '../lib/pregate/import-graph';
import { describeDraft, draftConfig } from '../lib/pregate/init-draft';
import { parseWorkflow } from '../lib/pregate/workflows';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const fixture = (baseFiles: Record<string, string> = {}) => { const r = makeFixtureRepo({ pregate: null, baseFiles }); repos.push(r); return r; };
const lanes = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--only', 'lanes', '--explain']);

const DJANGO_APP = {
  'orders/__init__.py': '',
  'orders/apps.py': 'from django.apps import AppConfig\n\nclass OrdersConfig(AppConfig):\n    name = "orders"\n',
  'orders/models.py': 'from django.db import models\n\nclass Order(models.Model):\n    sku = models.CharField(max_length=20)\n',
  'orders/admin.py': 'from django.contrib import admin\nfrom .models import Order\n\nadmin.site.register(Order)\n',
  'orders/migrations/__init__.py': '',
  'orders/migrations/0001_initial.py': 'from django.db import migrations\n\nclass Migration(migrations.Migration):\n    operations = []\n',
  'orders/templates/orders/detail.html': '{% extends "base.html" %}\n',
  'orders/tests/__init__.py': '',
  'orders/tests/test_models.py': 'from orders.models import Order\n\ndef test_order():\n    assert Order\n',
  'stores/__init__.py': '',
  'stores/backends.py': 'class StoreOwnerBackend:\n    pass\n',
  'shop/__init__.py': '',
  'shop/urls.py': 'from django.urls import path\nfrom . import views\n\nurlpatterns = [path("", views.home)]\n',
  'shop/views.py': 'def home(request):\n    return None\n',
  'config/__init__.py': '',
  'config/urls.py': 'from django.urls import include, path\n\nurlpatterns = [path("shop/", include("shop.urls"))]\n',
  'templates/base.html': '<html>{% block content %}{% endblock %}</html>\n',
  'tests/test_smoke.py': 'def test_smoke():\n    assert True\n',
};
const SETTINGS = 'INSTALLED_APPS = [\n    "orders.apps.OrdersConfig",\n]\nAUTHENTICATION_BACKENDS = ["stores.backends.StoreOwnerBackend"]\nROOT_URLCONF = "config.urls"\n';

describe('Django files loaded by name have a lane (#3266)', () => {
  test('a migration, admin.py and an app template select the app tests; a settings string, an include() and a project template reach the suite', () => {
    const repo = fixture({ ...DJANGO_APP, 'config/settings.py': SETTINGS });
    commit(repo, {
      'orders/migrations/0002_order_supplier_sku.py': 'from django.db import migrations\n\nclass Migration(migrations.Migration):\n    dependencies = [("orders", "0001_initial")]\n',
      'orders/admin.py': 'from django.contrib import admin\nfrom .models import Order\n\nadmin.site.register(Order)\nadmin.site.site_header = "Orders"\n',
      'orders/templates/orders/detail.html': '{% extends "base.html" %}\n{% block content %}detail{% endblock %}\n',
      'templates/base.html': '<html><body>{% block content %}{% endblock %}</body></html>\n',
      'stores/backends.py': 'class StoreOwnerBackend:\n    def authenticate(self, request):\n        return None\n',
      'shop/views.py': 'def home(request):\n    return "home"\n',
    });
    const r = lanes(repo);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).not.toContain('has no test lane');
    expect(r.out).toContain('orders/tests/test_models.py ← orders/migrations/0002_order_supplier_sku.py (framework)');
    expect(r.out).toContain('orders/tests/test_models.py ← orders/admin.py (framework)');
    expect(r.out).toContain('orders/tests/test_models.py ← orders/templates/orders/detail.html (framework)');
    expect(r.out).toContain('tests/test_smoke.py ← config/settings.py ← templates/base.html (framework)');
    expect(r.out).toContain('tests/test_smoke.py ← config/settings.py ← stores/backends.py (framework)');
    expect(r.out).toMatch(/tests\/test_smoke\.py ← config\/settings\.py ← config\/urls\.py ← shop\/urls\.py ← shop\/views\.py \(framework\)/);
  });

  test('negative controls: no Django edges without a settings module, from settings text inside a string or comment, or without Django evidence; unmapped Python in a Django repo still fails closed', () => {
    const plain = fixture(DJANGO_APP);
    commit(plain, { 'orders/admin.py': 'from django.contrib import admin\nadmin.site.site_header = "Orders"\n' });
    const r = lanes(plain);
    expect(r.out).toContain('(PREGATE_NO_POLICY)');
    expect(r.out).toContain('no policy: orders/admin.py have no test lane');
    expect(r.out).not.toContain('(framework)');

    const quoted = fixture({ ...DJANGO_APP, 'docs_example.py': 'EXAMPLE = """\nINSTALLED_APPS = []\n"""\n# ROOT_URLCONF = "config.urls"\n' });
    commit(quoted, { 'orders/admin.py': 'from django.contrib import admin\nadmin.site.site_header = "Orders"\n' });
    const q = lanes(quoted);
    expect(q.out).toContain('no policy: orders/admin.py have no test lane');
    expect(q.out).not.toContain('(framework)');

    const noDjango = fixture({ 'app/settings.py': 'INSTALLED_APPS = ["app.plugins.Core"]\n', 'app/__init__.py': '', 'app/plugins.py': 'class Core: pass\n', 'app/admin.py': 'X = 1\n', 'app/models.py': 'Y = 2\n', 'tests/test_app.py': 'def test_x():\n    assert True\n' });
    commit(noDjango, { 'app/admin.py': 'X = 2\n' });
    const n = lanes(noDjango);
    expect(n.out).toContain('no policy: app/admin.py have no test lane');
    expect(n.out).not.toContain('(framework)');

    const django = fixture({ ...DJANGO_APP, 'config/settings.py': SETTINGS });
    commit(django, { 'scripts/oneoff.py': 'print("not loaded by Django or any test")\n' });
    const bad = lanes(django);
    expect(bad.out).toContain('(PREGATE_NO_POLICY)');
    expect(bad.out).toContain('no policy: scripts/oneoff.py have no test lane');
    expect(bad.out).not.toMatch(/^tests {6}lanes {5}pass /m);
  });

  test('DJANGO_SETTINGS_MODULE in pytest.ini names the settings module when it assigns neither INSTALLED_APPS nor ROOT_URLCONF directly', () => {
    const repo = fixture({ ...DJANGO_APP, 'config/settings/__init__.py': '', 'config/settings/base.py': 'DEBUG = False\n', 'config/settings/test.py': 'from .base import *\nAUTHENTICATION_BACKENDS = ["stores.backends.StoreOwnerBackend"]\n', 'pytest.ini': '[pytest]\nDJANGO_SETTINGS_MODULE = config.settings.test\n' });
    commit(repo, { 'stores/backends.py': 'class StoreOwnerBackend:\n    pass\n\n# edited\n' });
    const r = lanes(repo);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).toContain('tests/test_smoke.py ← config/settings/test.py ← stores/backends.py (framework)');
  });
});

describe('assets, licence text and tool config take an empty lane (#3267)', () => {
  test('binary assets, a vendored licence and dotfile tool config clear without a policy', () => {
    const repo = fixture();
    commit(repo, {
      '.pre-commit-config.yaml': 'repos: []\n',
      '.impeccable/config.json': '{"theme": "dark"}\n',
      'static/fonts/roboto-latin-500-normal.woff2': 'wOF2\u0000\u0001\u0000\u0000',
      'static/fonts/roboto-LICENSE.txt': 'Apache License\nVersion 2.0\n',
      'templates/snippets/google_g_mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      'static/img/logo.png': '\u0089PNG\r\n\u001a\n',
    });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).not.toContain('has no test lane');
    expect(r.out).toContain('docs/no-tests (empty lane): static/fonts/roboto-LICENSE.txt');
    expect(r.out).toContain('no-tests (assets and tool config): .impeccable/config.json .pre-commit-config.yaml static/fonts/roboto-latin-500-normal.woff2 static/img/logo.png templates/snippets/google_g_mark.svg');
    expect(r.out).toMatch(/docs\/no-tests: 1 documentation file\(s\) and 5 asset or tool-config file\(s\); nothing touched selects a test/);
  });

  test('a tool-config-only branch passes on its own: the reported .pre-commit-config.yaml case', () => {
    const repo = fixture();
    commit(repo, { '.pre-commit-config.yaml': 'repos: []\n', 'notes/why.md': '# why\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('no-tests (assets and tool config): .pre-commit-config.yaml');
  });

  test('negative controls: runtime and unknown dotfiles, hooks, CI workflows, stylesheets, snapshot baselines, plain text and code stay unmapped; an asset a test names selects that test', () => {
    const repo = fixture();
    commit(repo, {
      '.nvmrc': '24\n',
      '.env.test': 'DATABASE_URL=sqlite://\n',
      '.github/workflows/lint.yml': 'name: Lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\n',
      'notes/sketch.txt': 'not licence text\n',
      'lib/orphan.js': 'exports.lonely = () => 3;\n',
      '.rspec': '--tag ~slow\n',
      '.husky/pre-commit': 'npx lint-staged\n',
      'styles/colors.css': ':root { --brand: red; }\n',
      'src/__image_snapshots__/home.png': '\u0089PNG',
      '.gstack/icon.svg': '<svg/>\n',
    });
    const r = lanes(repo);
    const unmapped = ['.nvmrc', '.env.test', '.github/workflows/lint.yml', 'notes/sketch.txt', 'lib/orphan.js', '.rspec', '.husky/pre-commit', 'styles/colors.css', 'src/__image_snapshots__/home.png', '.gstack/icon.svg'];
    const noPolicy = /^\s*lanes: no policy: (.*) have no test lane/m.exec(r.out)![1]!.split(' ');
    for (const f of unmapped) expect(noPolicy).toContain(f);
    expect(r.out).toContain('(PREGATE_NO_POLICY)');
    expect(r.out).not.toContain('no-tests (assets and tool config)');

    const named = fixture({ 'assets/logo.svg': '<svg/>\n', 'test/logo.test.js': "const test = require('node:test');\nconst fs = require('node:fs');\ntest('logo', () => { fs.readFileSync('assets/logo.svg', 'utf8'); });\n" });
    commit(named, { 'assets/logo.svg': '<svg viewBox="0 0 1 1"/>\n' });
    const sel = lanes(named);
    expect(sel.out).toContain('test/logo.test.js ← assets/logo.svg');
    expect(sel.out).not.toContain('no-tests (assets and tool config)');
  });
});

describe('gstack-pregate init drafts a policy from the repo (#3268)', () => {
  test('the draft names the languages, maps each unmapped file to its nearest tests, and lists the rest as TODO; it validates', () => {
    const repo = fixture({
      ...DJANGO_APP,
      'config/settings.py': SETTINGS,
      'orders/services.py': 'def total():\n    return 0\n',
      'tools/release.py': 'print("release")\n',
    });
    const r = runBin(repo, 'gstack-pregate', ['init']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('PREGATE_CONFIG_WRITTEN: .gstack/pregate.json');
    expect(r.out).toMatch(/PREGATE_INIT: languages python \d+, javascript \d+/);
    expect(r.out).toContain('python tests detected at run time: python3 -m pytest {files}');
    expect(r.out).not.toContain('needs runner set');
    expect(r.out).not.toContain('TODO src/version.js');
    expect(r.out).toContain('TODO tools/release.py: no test lane and no nearby test');
    expect(r.out).not.toContain('TODO orders/services.py');
    expect(r.out).not.toContain('TODO orders/admin.py');
    const draft = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/pregate.json'), 'utf8'));
    expect(JSON.stringify(draft)).not.toContain('example-tool');
    expect(draft.runner).toBeNull();
    expect(draft.dependencies['orders/services.py']).toEqual(['orders/tests/test_models.py']);
    expect(draft.dependencies['tools/release.py']).toBeUndefined();
    expect(Object.values(draft.dependencies).every(list => (list as string[]).length > 0)).toBe(true);
    expect(runBin(repo, 'gstack-pregate', ['validate']).status).toBe(EXIT.ok);
    const again = runBin(repo, 'gstack-pregate', ['init']);
    expect(again.status).toBe(EXIT.refused);
    expect(again.err).toContain('POLICY_EXISTS');
  });

  test('a repo with only JavaScript tests drafts no dependencies for files the graph already maps', () => {
    const repo = fixture();
    const r = runBin(repo, 'gstack-pregate', ['init']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/PREGATE_INIT: languages javascript \d+/);
    const draft = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/pregate.json'), 'utf8'));
    expect(draft.dependencies['lib/util.js']).toBeUndefined();
    expect(draft.dependencies['lib/retry.js']).toBeUndefined();
    expect(r.out).toContain('TODO selection: windows.yml/windows-shard computes its matrix');
    const direct = draftConfig(repo.work);
    expect(direct.todo).toContain('lib/orphan.js');
    expect(describeDraft(direct)).toContain('TODO lib/orphan.js: no test lane and no nearby test; add a test, map it under dependencies, or declare [] if no test can cover it');
  });
});

describe('gstack-pregate init respects the schema limit (#3268)', () => {
  test('past 256 drafted entries the rest are TODO, and the draft still validates', () => {
    const many: Record<string, string> = { 'pkg/tests/test_pkg.py': 'def test_pkg():\n    assert True\n' };
    for (let n = 0; n < 260; n++) many[`pkg/mod_${n}.py`] = `VALUE = ${n}\n`;
    const repo = fixture(many);
    const draft = draftConfig(repo.work);
    expect(Object.keys(JSON.parse(draft.json).dependencies)).toHaveLength(256);
    expect(draft.todo.filter(f => f.startsWith('pkg/mod_'))).toHaveLength(4);
    expect(runBin(repo, 'gstack-pregate', ['init']).status).toBe(EXIT.ok);
    expect(runBin(repo, 'gstack-pregate', ['validate']).status).toBe(EXIT.ok);
  });
});

describe('review fixes on the #3285 port: selection never shrinks on syntax it cannot follow', () => {
  const files = (run: string) => parseWorkflow('ci.yml', `jobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${run}\n`)[0]!.testFiles;

  test('a cd inside a pipeline, an alternative, a background job, control flow or a redirected subshell leaves the lane unknown instead of moving later paths', () => {
    expect(files('cd pkg | cat; bun test test/a.test.ts')).toEqual([]);
    expect(files('(cd pkg && echo ok) > logfile; bun test test/a.test.ts')).toEqual([]);
    expect(files('cd pkg && bun test test/a.test.ts')).toEqual(['pkg/test/a.test.ts']);
    expect(files('(cd pkg && bun test test/b.test.ts); bun test test/a.test.ts')).toEqual(['pkg/test/b.test.ts', 'test/a.test.ts']);
    expect(files('bun test test/a.test.ts | tee log')).toEqual(['test/a.test.ts']);
    expect(files('cd . || cd elsewhere; bun test test/a.test.ts')).toEqual([]);
    expect(files('cd pkg & wait; bun test test/a.test.ts')).toEqual([]);
    expect(files('if [ -d pkg ]; then cd pkg; fi; bun test test/a.test.ts')).toEqual([]);
  });

  test('Dart directives: an unindented conditional clause, nested comments, a long show list, two on a line, metadata, a quoted semicolon; part of is not a directive', () => {
    const files = new Set(['lib/part;name.dart', 'lib/core.dart', 'lib/core_io.dart', 'lib/a.dart', 'lib/b.dart', 'lib/c.dart', 'lib/big.dart', 'lib/nope.dart', 'lib/commented.dart', 'lib/lib.dart']);
    const targets = (source: string) => referencesIn(files, new Set(['lib']), 'lib/main.dart', source).map(r => r.target);
    expect(targets("import 'core.dart'\nif (dart.library.io) 'core_io.dart';\n")).toEqual(['lib/core.dart', 'lib/core_io.dart']);
    expect(targets("/* outer /* inner */ still a comment 'nope.dart' */\nimport 'a.dart';\n")).toEqual(['lib/a.dart']);
    expect(targets(`import 'big.dart' show ${Array.from({ length: 600 }, (_, n) => `name${n}`).join(', ')};\n`)).toEqual(['lib/big.dart']);
    expect(targets("import 'a.dart'; export 'b.dart';\npart 'c.dart';\npart of 'lib.dart';\n")).toEqual(['lib/a.dart', 'lib/b.dart', 'lib/c.dart']);
    expect(targets("// import 'commented.dart';\nvoid main() {}\n")).toEqual([]);
    expect(targets("@deprecated import 'a.dart';\n@Deprecated('use b') export 'b.dart';\n")).toEqual(['lib/a.dart', 'lib/b.dart']);
    expect(targets("import 'part;name.dart';\n")).toEqual(['lib/part;name.dart']);
  });
});
