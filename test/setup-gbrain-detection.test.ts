import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

describe('setup: gbrain detection failure handling', () => {
  test('failed detection clears both temp and persisted detection files', () => {
    expect(SETUP_SRC).toContain('rm -f "$DETECTION_FILE.tmp" "$DETECTION_FILE"');
  });
});
