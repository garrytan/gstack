/**
 * F13 independent review boundaries: Claude-only setup preserves cyclic foreign ownership links inside the runtime.
 * Split from test/setup-codex-scope-review-boundaries.test.ts so the free-suite packer can balance it (60 s seed ceiling).
 */
import { afterAll, afterEach, describe, test } from 'bun:test';
import { cleanupFixtures, cleanupSeed } from './helpers/install-fixture';
import { claudeOnlySetupPreservesCyclicLink } from './helpers/setup-codex-scope-cyclic';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('F13 independent review boundaries', () => {
  for (const target of ['runtime', 'runtime-bin', 'runtime-lib']) {
    test(`Claude-only setup preserves cyclic foreign ownership link: ${target}`, () => claudeOnlySetupPreservesCyclicLink(target), 90_000);
  }
});
