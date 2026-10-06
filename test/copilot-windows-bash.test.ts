/**
 * Copilot CLI on Windows ran gstack's extensionless helpers straight from
 * PowerShell. The Copilot tool glossary (rendered into every Copilot skill)
 * names Git for Windows Bash by full path. Kept out of host-config.test.ts,
 * which the curated Windows lane excludes, so Windows runs this check.
 */
import { describe, expect, test } from 'bun:test';

describe('#3047: Copilot on Windows runs bash blocks in Git for Windows Bash', () => {
  test('the Copilot tool glossary names Git Bash by full path and forbids PowerShell translation', async () => {
    const { default: copilot } = await import('../hosts/copilot');
    const glossary = JSON.stringify(copilot.toolRewrites);
    expect(glossary).toContain('Git for Windows Bash by its full path');
    expect(glossary).toContain('bare `bash` can start WSL');
    expect(glossary).toContain('Never translate a block into PowerShell');
  });
});
