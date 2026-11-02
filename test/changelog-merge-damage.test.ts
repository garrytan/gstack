/**
 * CHANGELOG merges that would carry damage to released history (GSTA-67,
 * from #3345 on 2026-10-22). #3345's pin 1eb7092 replaced main's
 * `## [1.91.179.0]` heading with `## [Unreleased]` instead of inserting
 * above it, and mergeChangelogs returned non-null output with 179's body
 * duplicated into [Unreleased]; the train's T1 6755ab8 carried it. The
 * fixtures under test/fixtures/merge-train-3345/ are the real CHANGELOGs at
 * those commits, cut below 1.91.177.0. A null merge means a hand resolve.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { carryReleasedParent, changelogDamage, mergeChangelogs, mergeChangelogsWithNotes, ownEntryAboveMain, parseChangelog } from '../lib/changelog-check';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'merge-train-3345', name), 'utf8');
const base = fixture('base-a59b5e4.md');
const pin = fixture('pin-1eb7092.md');
const main = fixture('main-4a98e40.md');
const keys = (text: string) => parseChangelog(text).sections.map(s => s.version ?? 'Unreleased');

describe('mergeChangelogs refuses damage to released history', () => {
  test('GSTA-64 repro: a released heading replaced by [Unreleased] is null, not a merge with the 1.0.1 body duplicated', () => {
    const ours = '# Changelog\n\n## [Unreleased]\n\nNew entry.\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    const theirs = '# Changelog\n\n## [1.0.2] - d\n\nMain body.\n\n## [1.0.1] - d\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    expect(changelogDamage(ours, theirs)).toContain("ours's Unreleased section holds released 1.0.1 text");
    expect(mergeChangelogs(ours, theirs)).toBeNull();
    const baseText = '# Changelog\n\n## [1.0.1] - d\n\nOld 1.0.1 body.\n\n## [1.0.0] - d\n\nOld 1.0.0 body.\n';
    expect(changelogDamage(ours, theirs, baseText)).toBe('ours drops released heading 1.0.1 that the merge base carries');
  });

  test('#3345: pin 1eb7092 against main 4a98e40 is null with or without the merge base; the train T1 it produced duplicated 179', () => {
    expect(changelogDamage(pin, main, base)).toBe('ours drops released heading 1.91.179.0 that the merge base carries');
    expect(changelogDamage(pin, main)).toMatch(/^ours's Unreleased section holds released 1\.91\.179\.0 text/);
    expect(mergeChangelogs(pin, main, base)).toBeNull();
    expect(mergeChangelogs(pin, main)).toBeNull();
    const t1 = fixture('train-T1-6755ab8.md');
    expect(keys(t1)).toEqual(['Unreleased', '1.91.181.0', '1.91.180.0', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(changelogDamage(t1, main)).toMatch(/^ours's Unreleased section holds released 1\.91\.179\.0 text/);
  });

  test('either side, and a renamed heading, count as damage', () => {
    expect(changelogDamage(main, pin, base)).toBe('theirs drops released heading 1.91.179.0 that the merge base carries');
    const renamed = main.replace('## [1.91.178.0]', '## [1.91.178.9]');
    expect(changelogDamage(renamed, main, base)).toBe('ours drops released heading 1.91.178.0 that the merge base carries');
    expect(changelogDamage(renamed, main)).toMatch(/^ours's 1\.91\.178\.9 section holds released 1\.91\.178\.0 text/);
  });

  test('negative controls: the real hand resolve, an entry above a newer main, a shared tentative stamp and two [Unreleased] blocks are not damage', () => {
    const fixed = pin.replace(/\n\n\*\*docsync-fault-interface/, '\n\n## [1.91.179.0] - 2026-10-22\n\n**docsync-fault-interface');
    expect(keys(fixed)).toEqual(['Unreleased', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(changelogDamage(fixed, main, base)).toBeNull();
    const merged = mergeChangelogs(fixed, main, base)!;
    expect(keys(merged)).toEqual(['Unreleased', '1.91.181.0', '1.91.180.0', '1.91.179.0', '1.91.178.0', '1.91.177.0']);
    expect(merged.split('**docsync-fault-interface fits its budgets').length).toBe(2);
    const b = '## [1.2.3.0] - d\n\n- base release entry\n';
    expect(mergeChangelogs(`# C\n\n## [1.2.4.0] - d\n\n- mine, a new entry\n\n${b}`, `# C\n\n## [1.2.4.0] - e\n\n- theirs, a new entry\n\n${b}`, `# C\n\n${b}`)).not.toBeNull();
    expect(changelogDamage(`# C\n\n## [Unreleased]\n\n- #2 change, its entry\n\n${b}`, `# C\n\n## [Unreleased]\n\n- #1 change, its entry\n\n${b}`, `# C\n\n${b}`)).toBeNull();
  });
});

describe("ownEntryAboveMain: a merged-in head's CHANGELOG however it was resolved", () => {
  const dir = path.join(import.meta.dir, 'fixtures', 'merge-train-3345');
  const diff = spawnSync('git', ['diff', '--no-index', '--unified=0', '--no-color', path.join(dir, 'base-a59b5e4.md'), path.join(dir, 'pin-1eb7092.md')], { encoding: 'utf8', timeout: 30_000 }).stdout;
  const authored = new Set(diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)));
  const stamped = fixture('stamped-de23f5d.md');

  test("#3345's stamped head de23f5d is main 4a98e40's CHANGELOG plus its own entry; the damaged train T1 is not", () => {
    expect(authored.has('### Fixed')).toBe(true);
    expect(authored.has('## [1.91.179.0] - 2026-10-22')).toBe(false);
    expect(ownEntryAboveMain(stamped, main, authored)).toBeNull();
    expect(ownEntryAboveMain(fixture('train-T1-6755ab8.md'), main, authored)).toMatch(/^the PR's entry holds a line its pin never added: "\*\*docsync-fault-interface/);
  });

  test('negative controls: an invented line, a dropped or edited main section, a changed header and a duplicate heading are refused', () => {
    expect(ownEntryAboveMain(stamped.replace('### Fixed\n', '### Fixed\n- added after the gate\n'), main, authored)).toBe('the PR\'s entry holds a line its pin never added: "- added after the gate"');
    expect(ownEntryAboveMain(stamped.replace(/## \[1\.91\.180\.0\][^\n]*\n/, ''), main, authored)).toBe("main's ## [1.91.181.0] - 2026-10-23 is not carried unchanged below the PR's entry");
    expect(ownEntryAboveMain(stamped.replace('## [1.91.178.0]', '## [1.91.178.0]\n\n- smuggled'), main, authored)).toBe("main's ## [1.91.178.0] - 2026-10-22 is not carried unchanged below the PR's entry");
    expect(ownEntryAboveMain(stamped.replace('# Changelog', '# Change log'), main, authored)).toBe('the header differs from main');
    expect(ownEntryAboveMain(stamped.replace('## [1.91.182.0]', '## [1.91.181.0]'), main, authored)).toMatch(/is headed twice$/);
    // Main's CHANGELOG unchanged is not main's plus the PR's entry: the entry the gate carried is missing (state-machines review of GSTA-129).
    expect(ownEntryAboveMain(main, main, authored)).toBe("it is main's CHANGELOG unchanged, with no entry of the PR's own above it");
  });
});

describe("a stacked child whose parent was released since the fork (GSTA-96, train 24: #3453 after #3434's squash)", () => {
  // The real CHANGELOGs, cut below 1.91.274.0: the pin a78ce08a (one [Unreleased] holding #3434's entry with
  // two wording edits plus #3453's own), main 3e4240a7 (#3434 released as 1.91.276.0), the fork d87eec95 and
  // main 6ff98c66 (what the hand resolve shipped as 1.91.277.0, without the two edits).
  const f24 = (name: string) => fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'merge-train-3453', name), 'utf8');
  const pin24 = f24('pin-a78ce08a.md');
  const main24 = f24('main-3e4240a7.md');
  const base24 = f24('base-d87eec95.md');
  const body = (text: string, i = 0) => parseChangelog(text).sections[i]!.lines.slice(1).join('\n').replace(/\n+$/, '');

  test("the slot's merge is no longer null: main's sections stay byte for byte, the child's [Unreleased] keeps its own entry, and the two edits to the released entry become Gate integrity corrections", () => {
    expect(changelogDamage(pin24, main24, base24)).toMatch(/^ours's Unreleased section holds released 1\.91\.276\.0 text/);
    const r = mergeChangelogsWithNotes(pin24, main24, base24);
    expect(r.text).not.toBeNull();
    expect(r.notes).toEqual([
      '1.91.276.0: "copies of shared sections twice until a follow-up dedupes them." -> "versions of shared sections beside the shared file (office-hours\' copies are deduped in the entry above)."',
      '1.91.276.0: "shrinks and 89 size pins go down." -> "loses 3 characters from it and the 89 size pins go down by 3 (plan-ceo-review still grows overall, below)."',
    ]);
    const merged = parseChangelog(r.text!);
    expect(keys(r.text!)).toEqual(['Unreleased', '1.91.276.0', '1.91.275.0', '1.91.274.0']);
    const main = parseChangelog(main24);
    expect(merged.header).toEqual(main.header);
    const trimmed = (lines: string[]) => lines.join('\n').replace(/\n+$/, '');
    main.sections.forEach((s, i) => expect(trimmed(merged.sections[i + 1]!.lines)).toBe(trimmed(s.lines)));
    // The child's section is what the hand resolve shipped as 1.91.277.0, plus the two corrections under its own Gate integrity.
    const shipped = body(f24('main-6ff98c66.md'));
    expect(body(r.text!)).toBe(`${shipped}
- Correction to the 1.91.276.0 entry below: "copies of shared sections twice until a follow-up dedupes them." should read "versions of shared sections beside the shared file (office-hours' copies are deduped in the entry above).".
- Correction to the 1.91.276.0 entry below: "shrinks and 89 size pins go down." should read "loses 3 characters from it and the 89 size pins go down by 3 (plan-ceo-review still grows overall, below).".`);
    expect(mergeChangelogs(pin24, main24, base24)).toBe(r.text);
    // The merge is idempotent and passes the train's own checks: no damage, and the released entry is unchanged.
    expect(changelogDamage(r.text!, main24, base24)).toBeNull();
  });

  test('without the merge base the shape is indistinguishable from a dropped heading and stays null; with the base carrying the released heading it is damage, not a carry', () => {
    expect(mergeChangelogs(pin24, main24)).toBeNull();
    expect(carryReleasedParent(pin24, main24, main24)).toBeNull();
    expect(mergeChangelogs(pin24, main24, main24)).toBeNull();
  });

  test('shapes: an unedited parent leaves no correction; a dropped line and a line added inside the parent are carried; a child with nothing of its own, or two [Unreleased] blocks, is null', () => {
    const released = '## [1.0.1] - d\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n';
    const theirs = `# C\n\n${released}\n## [1.0.0] - d\n\n- base\n`;
    const base = '# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n\n## [1.0.0] - d\n\n- base\n';
    const child = (parentBody: string) => `# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n${parentBody}\n## [1.0.0] - d\n\n- base\n`;
    const unedited = carryReleasedParent(child('**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n'), theirs, base)!;
    expect(unedited.notes).toEqual([]);
    expect(unedited.text).toBe('# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n## [1.0.0] - d\n\n- base\n');
    const edited = carryReleasedParent(child('**Parent paragraph.**\n\n### Changed\n- one\n- two, now better\n- four\n'), theirs, base)!;
    expect(edited.notes).toEqual(['1.0.1: "two" -> "two, now better"', '1.0.1: dropped "three"', '1.0.1: added "four"']);
    expect(edited.text).toBe('# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n### Gate integrity\n- Correction to the 1.0.1 entry below: "two" should read "two, now better".\n- Correction to the 1.0.1 entry below: "three" no longer applies.\n- Addition to the 1.0.1 entry below: four\n\n## [1.0.0] - d\n\n- base\n');
    expect(mergeChangelogs(child('**Parent paragraph.**\n\n### Changed\n- one\n- two, now better\n- four\n'), theirs, base)).toBe(`# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n### Gate integrity\n- Correction to the 1.0.1 entry below: "two" should read "two, now better".\n- Correction to the 1.0.1 entry below: "three" no longer applies.\n- Addition to the 1.0.1 entry below: four\n\n${released}\n## [1.0.0] - d\n\n- base\n`);
    expect(carryReleasedParent(`# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n\n## [1.0.0] - d\n\n- base\n`, theirs, base)).toBeNull();
    expect(carryReleasedParent(`# C\n\n## [Unreleased]\n\n- a\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Changed\n- one\n\n## [1.0.0] - d\n\n- base\n`, theirs, base)).toBeNull();
  });

  // Value: protects=a stacked child whose only own line sits inside the released parent's list merges instead of refusing; fails_when=the inserted line is filed as an addition to the parent and the merge returns null (#3613 slot 2, train 57, needed a hand resolve); why_new=every shape above has an own entry outside the parent's lines; seam=none; no_claim=where a line inserted beside the child's own entry goes
  test("#3613's shape: a child whose only own line sits inside the released parent's list keeps that line as its entry", () => {
    const released = '## [1.0.1] - d\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- one\n- two\n';
    const theirs = `# C\n\n${released}\n## [1.0.0] - d\n\n- base\n`;
    const base = '# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- one\n- two\n\n## [1.0.0] - d\n\n- base\n';
    const child = '# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- mine\n- one\n- two\n\n## [1.0.0] - d\n\n- base\n';
    const r = carryReleasedParent(child, theirs, base)!;
    expect(r.notes).toEqual([]);
    expect(r.text).toBe('# C\n\n## [Unreleased]\n\n### Changed\n- mine\n\n## [1.0.0] - d\n\n- base\n');
    const merged = mergeChangelogs(child, theirs, base)!;
    expect(merged).toBe(`# C\n\n## [Unreleased]\n\n### Changed\n- mine\n\n${released}\n## [1.0.0] - d\n\n- base\n`);
    expect(ownEntryAboveMain(merged, theirs, new Set(['### Changed', '- mine', '- one', '- two', '- new thing', '### Added', '**Parent paragraph.**']))).toBeNull();
    expect(carryReleasedParent('# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- one\n- two\n\n## [1.0.0] - d\n\n- base\n', theirs, base)).toBeNull();
    // A reordered or duplicated parent bullet is not the child's entry: it stays a hand resolve.
    expect(mergeChangelogs('# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- two\n- one\n\n## [1.0.0] - d\n\n- base\n', theirs, base)).toBeNull();
    expect(mergeChangelogs('# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Added\n- new thing\n\n### Changed\n- one\n- one\n- two\n\n## [1.0.0] - d\n\n- base\n', theirs, base)).toBeNull();
  });

  // Value: protects=carryReleasedParent rewrites only a child that still holds the released parent's entry and keeps an existing Gate integrity section's neighbours in place; fails_when=an unrelated [Unreleased] or an already-stamped head is rewritten or the correction lands outside Gate integrity; why_new=the shapes test above never has a child without the parent's entry, a head without [Unreleased], or a Gate integrity section followed by another heading; seam=none; no_claim=the wording of corrections beyond one edited line
  test('shapes: a child that does not hold the released parent, or a head already stamped, is null; a correction joins the child\'s existing Gate integrity section without crossing the next heading', () => {
    const released = '## [1.0.1] - d\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n';
    const theirs = `# C\n\n${released}\n## [1.0.0] - d\n\n- base\n`;
    const base = '# C\n\n## [Unreleased]\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two\n- three\n\n## [1.0.0] - d\n\n- base\n';
    expect(carryReleasedParent('# C\n\n## [Unreleased]\n\n- totally other\n\n## [1.0.0] - d\n\n- base\n', theirs, base)).toBeNull();
    expect(carryReleasedParent('# C\n\n## [1.0.2] - d\n\n- mine\n\n## [1.0.0] - d\n\n- base\n', theirs, base)).toBeNull();
    const child = '# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n### Gate integrity\n- child gate\n\n### Tests\n- child test\n\n**Parent paragraph.**\n\n### Changed\n- one\n- two edited\n- three\n\n## [1.0.0] - d\n\n- base\n';
    expect(carryReleasedParent(child, theirs, base)!.text).toBe('# C\n\n## [Unreleased]\n\n**Child.**\n\n### Changed\n- mine\n\n### Gate integrity\n- child gate\n- Correction to the 1.0.1 entry below: "two" should read "two edited".\n\n### Tests\n- child test\n\n## [1.0.0] - d\n\n- base\n');
  });
});
