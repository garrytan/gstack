import { describe, it, expect } from 'bun:test';
import { stripFrontmatter } from '../gbrain';

describe('stripFrontmatter', () => {
  it('strips a simple --- ... --- block at the top', () => {
    const md = `---
title: Foo
type: concept
---

body content here
`;
    expect(stripFrontmatter(md)).toBe('body content here\n');
  });

  it('handles a leading [gbrain] banner line above the frontmatter', () => {
    const md = `[gbrain] Prepared statements disabled (...)
---
title: Foo
---

body
`;
    expect(stripFrontmatter(md)).toBe('body\n');
  });

  it('returns input unchanged if no frontmatter', () => {
    const md = `just plain content\nno fences here\n`;
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('handles JSON content as the body (our own use case)', () => {
    const md = `---
title: Build State
type: concept
---

{"slug":"build-foo","phases":[]}
`;
    expect(stripFrontmatter(md).trim()).toBe('{"slug":"build-foo","phases":[]}');
  });
});

// Note: isGbrainAvailable + gbrainPut + gbrainGet are integration-tested
// implicitly by the state tests when the GBrain CLI is on PATH. Pure-unit
// testing of subprocess wrappers without a real binary is mostly busywork
// (it just tests our mocks). The contract is documented and exercised
// end-to-end in the smoke test in Phase 7.
