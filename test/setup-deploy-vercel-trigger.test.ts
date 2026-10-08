import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SKILL = fs.readFileSync(path.resolve(import.meta.dir, '..', 'setup-deploy', 'SKILL.md'), 'utf-8');

function section(heading: string, next: string): string {
  const start = SKILL.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  return SKILL.slice(start, SKILL.indexOf(next, start + heading.length));
}

describe('setup-deploy does not assume Vercel deploys on push', () => {
  test('auto-deploy is conditional on a Git-connected Vercel project', () => {
    const vercel = section('#### Vercel', '#### Netlify');
    expect(vercel).toContain('only when the Vercel project is connected to this Git repository');
    expect(vercel).toContain('For a CLI-only project, ask how production deploys run and record that command as the deploy trigger');
  });

  test('the nothing-detected path explains how a CLI-only Vercel project becomes detectable', () => {
    const manual = section('#### Custom / Manual', '1. **How are deploys triggered?**');
    expect(manual).toContain('deployed only with the Vercel CLI has no `vercel.json` or `.vercel/`');
    expect(manual).toContain('`vercel link` creates `.vercel/`');
    expect(SKILL).not.toMatch(/GoLive/i);
  });
});
