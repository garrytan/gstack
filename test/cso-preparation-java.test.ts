/**
 * A Java/Maven repository was reported as `stack: python` and asked for a
 * requirements.txt, because no supported stack matched and preparation
 * defaulted to Python. A root Maven or Gradle build now names the stack as
 * Java (unsupported for runtime preparation, so static assessment only), and
 * Python helper scripts or metadata beside it do not turn it into Python.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPreparation } from '../lib/cso/preparation';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cso-preparation-java-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const maven = {
  'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>app</artifactId><version>1</version></project>\n',
  'src/main/java/app/App.java': 'package app;\npublic class App { public static void main(String[] a) {} }\n',
  'scripts/release.py': 'print("helper")\n',
  'tools/lint_check.py': 'import sys\n',
};

describe('/cso preparation: a Maven repository with helper Python scripts is Java', () => {
  test('helper .py scripts only', () => {
    const plan = inspectPreparation(fixture(maven));
    expect(plan.stack).toBe('java');
    expect(plan.status).toBe('prerequisites');
    expect(plan.prerequisites).toEqual([{
      code: 'UNSUPPORTED_STACK',
      message: 'Java (pom.xml) is not a supported runtime stack yet; supported runtime stacks are Node, Bun, Python, and Rails.',
      path: 'pom.xml',
    }]);
    expect(JSON.stringify(plan)).not.toContain('requirements.txt');
  });

  test('helper scripts with a root requirements.txt stay Java', () => {
    const plan = inspectPreparation(fixture({ ...maven, 'requirements.txt': 'requests==2.32.3\n' }));
    expect(plan.stack).toBe('java');
    expect(plan.prerequisites[0]?.code).toBe('UNSUPPORTED_STACK');
  });

  test('Gradle builds are Java too', () => {
    const plan = inspectPreparation(fixture({ 'build.gradle.kts': 'plugins { java }\n', 'scripts/x.py': '' }));
    expect(plan.stack).toBe('java');
    expect(plan.prerequisites[0]?.message).toContain('Java (build.gradle.kts)');
  });

  test('a Python project without a JVM build is still Python (control)', () => {
    expect(inspectPreparation(fixture({ 'requirements.txt': 'requests==2.32.3\n', 'app.py': '' })).stack).toBe('python');
  });
});
