/** Real filesystem boundaries for the shared-code advisory eligibility eval. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sharedLibsFingerprint } from '../../lib/review-evidence';
import {
  SHARED_LIBS_ROOT, commitFixture, createSharedLibsFixture, fixtureGit, fixtureWrite,
  fixtureWorkingTree, seedReviewSources, shellQuote, type SharedLibsFixture,
} from './shared-libs-eval-fixture';

export type PathEligibilityCase = 'symlinks' | 'submodule' | 'ignored' | 'legacy' | 'assume-unchanged' | 'skip-worktree' | 'removed-filter';
export interface PathEligibilityFixture {
  fixture: SharedLibsFixture;
  current: Record<string, any>;
  beforeTree: string;
  sourcePaths: string[];
  rawPaths: string[];
}

function seedBoundSkip(f: SharedLibsFixture, finding: Record<string, any>): void {
  const logger = path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-log');
  const options = { cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8' as const, timeout: 30_000 };
  const token = execFileSync(logger, ['--start', 'review'], { ...options, timeout: 30_000 }).trim();
  execFileSync(logger, [JSON.stringify({
    skill: 'review', timestamp: new Date().toISOString(), status: 'clean',
    issues_found: 0, critical: 0, informational: 0, quality_score: 10,
    findings: [finding], completed: true, converged: true, cycles: 0,
  }), '--finish', token], { ...options, timeout: 30_000 });
}

/** The prior row is written by the real logger; no caller-created binding is trusted. */
export function preparePathEligibilityFixture(kind: PathEligibilityCase): PathEligibilityFixture {
  const fixture = createSharedLibsFixture(`path-${kind}`);
  const f = fixture;
  try {
    seedReviewSources(f);
    fixtureWrite(f, 'src/retry-worker.ts', fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8')
      .replace('const unusedRetryDiagnostic = "unused";\n', ''));
    const parser = fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8');
    let sourcePaths = ['src/retry-route.ts'];
    let rawPaths: string[] = [];

    if (kind === 'symlinks') {
      // Both a file symlink and a symlinked ancestor lead to authored runtime source.
      // Their targets are ignored, so raw changes cannot alter the parent Git tree.
      fixtureWrite(f, '.fixture/first-party/direct-route.ts', parser);
      fixtureWrite(f, '.fixture/first-party/routes/retry.ts', parser);
      fs.unlinkSync(path.join(f.repo, 'src/retry-route.ts'));
      fs.symlinkSync('../.fixture/first-party/direct-route.ts', path.join(f.repo, 'src/retry-route.ts'));
      fs.symlinkSync('../.fixture/first-party/routes', path.join(f.repo, 'src/retry-alias'));
      sourcePaths = ['src/retry-route.ts', 'src/retry-alias/retry.ts'];
      rawPaths = ['.fixture/first-party/direct-route.ts', '.fixture/first-party/routes/retry.ts'];
    } else if (kind === 'submodule') {
      // Build and clone a local first-party repository; no external Git service is needed.
      const moduleOrigin = path.join(f.root, 'module-origin');
      fs.mkdirSync(moduleOrigin);
      const moduleGit = (...args: string[]) => execFileSync(Bun.which('git') || 'git', args, {
        cwd: moduleOrigin, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      moduleGit('init', '-b', 'main');
      moduleGit('config', 'user.name', 'First-party Module Fixture');
      moduleGit('config', 'user.email', 'module@example.invalid');
      fs.writeFileSync(path.join(moduleOrigin, 'retry-route.ts'), parser);
      fs.writeFileSync(path.join(moduleOrigin, 'README.md'), '# First-party retry runtime\nOwned and authored by this application team. The parent application bundles this module with its root lib/ helpers in the same runtime; it is not deployed independently.\n');
      moduleGit('add', 'retry-route.ts', 'README.md');
      moduleGit('commit', '-m', 'implement retry route');
      fixtureGit(f, '-c', 'protocol.file.allow=always', 'submodule', 'add', moduleOrigin, 'modules/retry');
      fixtureGit(f, 'config', '--file', '.gitmodules', 'submodule.modules/retry.url', 'https://github.com/fixture/retry-module.git');
      fixtureWrite(f, 'src/retry-route.ts', "export { retrySeconds } from '../lib/retry-after';\n");
      sourcePaths = ['modules/retry/retry-route.ts'];
      rawPaths = sourcePaths;
    } else if (kind === 'ignored') {
      fixtureWrite(f, '.gitignore', fs.readFileSync(path.join(f.repo, '.gitignore'), 'utf8') + 'runtime-local/\n');
      fixtureWrite(f, 'runtime-local/retry-route.ts', parser);
      fixtureWrite(f, 'src/retry-route.ts', "export { retrySeconds } from '../lib/retry-after';\n");
      sourcePaths = ['runtime-local/retry-route.ts'];
      rawPaths = sourcePaths;
    } else if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
      // Set the flag only AFTER the prior capture, which fully covers ordinary raw source.
      rawPaths = sourcePaths;
    } else if (kind === 'removed-filter') {
      // Keep normalization instrumentation out of the code review diff. A
      // committed .gitattributes without a distributed driver is a real defect.
      const clean = path.join(f.root, 'normalize-filter');
      fs.writeFileSync(clean, "#!/bin/sh\nsed '/^\\/\\/ RAW-ONLY/d'\n", { mode: 0o755 });
      fixtureGit(f, 'config', 'filter.normalize.clean', shellQuote(clean));
      fs.writeFileSync(path.join(f.repo, '.git/info/attributes'), 'src/retry-route.ts filter=normalize\n');
      fixtureWrite(f, 'src/retry-route.ts', parser + '// RAW-ONLY prior source was not represented by the normalized tree\n');
    }

    if (['symlinks', 'submodule', 'ignored'].includes(kind)) {
      // These deployment boundaries predate the worker change. Introducing an
      // ignored caller or a symlink into an ignored mount in the reviewed diff
      // would create a separate distribution defect, obscuring skip eligibility.
      const worker = fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8');
      fixtureWrite(f, 'src/retry-worker.ts', "export { retrySeconds } from '../lib/retry-after';\n");
      const boundary = kind === 'symlinks'
        ? 'The application deployment supplies the authored route adapters under .fixture/first-party/ before loading src/retry-route.ts or src/retry-alias/retry.ts. These established symlinks intentionally point into that deployment mount. The adapters contain no relative imports today; any future shared-helper import must resolve from the actual adapter location.'
        : kind === 'ignored'
          ? 'The application deployment supplies authored optional route adapters under runtime-local/. That established mount is intentionally excluded from this repository; runtime-local/retry-route.ts is first-party application code loaded only after the mount is present.'
          : 'The application includes the first-party modules/retry submodule during deployment. Its authored route adapter and the root application helpers are bundled into the same runtime; this module is not independently deployed.';
      fixtureWrite(f, 'README.md', '# Fixture application\n\n' + boundary + '\n');
      commitFixture(f, 'establish existing first-party route deployment boundary');
      fixtureWrite(f, 'src/retry-worker.ts', worker);
    }

    const current: Record<string, any> = {
      severity: 'INFORMATIONAL', confidence: 9, advisory: true,
      path: 'src/retry-worker.ts', line: 2, category: 'shared-libs',
      summary: 'Use the established Retry-After contract in the changed worker and the authored route sources.',
      fix: 'Share the tested retrySeconds contract, preserving runtime and deployment boundaries for each caller.',
      evidence_paths: ['src/retry-worker.ts', ...sourcePaths, 'lib/retry-after.ts'],
      helper_target: { path: 'lib/retry-after.ts', symbol: 'retrySeconds' },
    };
    current.fingerprint = sharedLibsFingerprint(current);
    const prior: Record<string, any> = { ...current, action: 'skipped' };
    const proofTree = fixtureWorkingTree(f);
    prior.snapshot_covered_paths = kind === 'removed-filter' ? []
      : ['symlinks', 'submodule', 'ignored'].includes(kind)
        ? ['src/retry-worker.ts', 'lib/retry-after.ts'] : [...current.evidence_paths];
    for (const sourcePath of prior.snapshot_covered_paths) {
      const blob = execFileSync(Bun.which('git') || 'git', ['-c', 'core.fsmonitor=false', 'show', `${proofTree}:${sourcePath}`], {
        cwd: f.repo, env: { ...process.env, ...f.env }, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!fs.readFileSync(path.join(f.repo, sourcePath)).equals(blob)) throw new Error(`Unproven prior raw coverage: ${sourcePath}`);
    }
    if (kind === 'legacy') {
      // A genuine prior review with incomplete legacy finding metadata, not a forged binding.
      delete prior.helper_target;
      delete prior.snapshot_covered_paths;
    }
    seedBoundSkip(f, prior);
    const beforeTree = fixtureWorkingTree(f);
    if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
      // gstack-wtree copies these real index flags and can miss the following raw edit.
      fixtureGit(f, 'update-index', `--${kind}`, 'src/retry-route.ts');
    }
    if (kind === 'removed-filter') {
      // The current file is now untransformed and equals the same canonical blob,
      // but the earlier review did not establish raw-source coverage for that blob.
      fixtureWrite(f, 'src/retry-route.ts', parser);
      fs.writeFileSync(path.join(f.repo, '.git/info/attributes'), 'src/retry-route.ts -filter\n');
      if (!fixtureGit(f, 'check-attr', 'filter', '--', 'src/retry-route.ts').endsWith(': unset')) {
        throw new Error('Current source must no longer have a filter');
      }
    }
    for (const rawPath of rawPaths) {
      fixtureWrite(f, rawPath, fs.readFileSync(path.join(f.repo, rawPath), 'utf8')
        + `\n// Authored caller changed after the prior decision (${kind}).\n`);
    }
    if (fixtureWorkingTree(f) !== beforeTree) throw new Error(`${kind}: fixture must retain the parent Git tree`);
    return { fixture, current, beforeTree, sourcePaths, rawPaths };
  } catch (error) {
    fs.rmSync(f.root, { recursive: true, force: true });
    throw error;
  }
}
