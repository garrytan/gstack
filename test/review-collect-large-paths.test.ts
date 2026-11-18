import { afterEach, expect, test } from 'bun:test';
import { collectCommit } from '../lib/review-collect';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

// Value: protects=directory compaction preserves literal paths and only reports changed executables; fails_when=sibling
//   scripts leak into the result or directory names with glob syntax are interpreted as pathspecs; seam=git objects
test('a large literal path list finds changed shebangs without adding unchanged sibling scripts', () => {
  const dir = `results/[literal]/${'receipts-'.repeat(12)}`;
  const repo = makeFixtureRepo(); repos.push(repo);
  const base = commit(repo, { [`${dir}/unchanged.json`]: '#!/bin/sh\necho old\n' });
  const trials = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`${dir}/trial-${i}.json`, `{"i":${i}}\n`]));
  const script = `${dir}/changed.json`;
  const head = commit(repo, { ...trials, [script]: '#!/bin/sh\necho changed\n' });
  const c = collectCommit(repo.work, base, head);
  expect(c.errors).toEqual([]);
  expect(c.executables).toEqual([script]);
}, 30_000);
