/**
 * Adversarial security tests — boundary-check hardening
 *
 * Freeze hook uses trailing slash in boundary check (prevents prefix collision)
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

describe('Adversarial security', () => {
  test('freeze hook uses trailing slash in boundary check', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, '../../freeze/bin/check-freeze.sh'),
      'utf-8',
    );
    // The boundary check must use "${FREEZE_DIR}/" with a trailing slash
    // to prevent prefix collision (e.g., /app matching /application)
    expect(source).toContain('"${FREEZE_DIR}/"');
  });
});
