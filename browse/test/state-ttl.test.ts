/**
 * State file TTL security tests
 *
 * Verifies that state save includes savedAt timestamp and state load
 * warns on old state files.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const META_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');

describe('State file TTL', () => {
  test('state save includes savedAt timestamp in output', () => {
    // Verify the save code writes savedAt to the state file
    const saveBlock = META_SRC.slice(
      META_SRC.indexOf("if (action === 'save')"),
      META_SRC.indexOf("if (action === 'load')"),
    );
    expect(saveBlock).toContain('savedAt: new Date().toISOString()');
  });

  test('state load warns when savedAt is older than 7 days', () => {
    // Verify the load code checks savedAt age and warns
    const loadStart = META_SRC.indexOf("if (action === 'load')");
    // Find the second occurrence of "Usage: state save|load" (appears after the load block)
    const loadEnd = META_SRC.indexOf("Usage: state save|load", loadStart);
    const loadBlock = META_SRC.slice(loadStart, loadEnd);
    expect(loadBlock).toContain('data.savedAt');
    expect(loadBlock).toContain('SEVEN_DAYS');
    expect(loadBlock).toContain('console.warn');
    expect(loadBlock).toContain('days old');
  });
});
