import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// Git and file reads of a docs fixture repository. Kept free of heavy imports: the fault actor's CLI and
// PreToolUse hook load this module on every spawn.

export const DOC_PATH = 'handbook/reference/commands/widget.md.tmpl';

/** The fixture's CLAUDE_CONFIG_DIR: credentials and session transcripts, unreadable to the actor except settings.json. */
export function docsConfigDir(home: string): string {
  return path.join(home, 'cc');
}

export function gitAt(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
}

/** Every tracked or new, non-ignored path, deduplicated and sorted. */
export function repoInventory(repo: string): string[] {
  return [...new Set(gitAt(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0').filter(Boolean))].sort();
}

/** Base64 content of each listed regular file that exists; throws when a path resolves outside the repo. */
export function repoContents(repo: string, files: Iterable<string>): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const name of files) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(fs.realpathSync(repo) + path.sep)) throw new Error(`fixture path escaped: ${name}`);
    if (fs.statSync(file).isFile()) contents[name] = fs.readFileSync(file).toString('base64');
  }
  return contents;
}

export function repoSnapshot(repo: string) {
  const files = gitAt(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const contents = repoContents(repo, new Set(files));
  return { head: gitAt(repo, 'rev-parse', 'HEAD'), index: gitAt(repo, 'ls-files', '--stage'), contents };
}

export function changedFiles(before: ReturnType<typeof repoSnapshot>, after: ReturnType<typeof repoSnapshot>): string[] {
  return [...new Set([...Object.keys(before.contents), ...Object.keys(after.contents)])]
    .filter(p => before.contents[p] !== after.contents[p]).sort();
}

/** The record `gstack-docs-candidate snapshot` writes and `compare` reads (bin/gstack-docs-candidate). */
export interface DocsCandidateRecord {
  schema_version: 1; audit_id: string; mode: 'edit' | 'read-only'; base: string; head: string; branch: string;
  index: string[]; committed: string[]; staged: string[]; unstaged: string[]; untracked: string[];
  selected: string[]; docs: string[]; hashes: Record<string, string | null>;
}

/**
 * The installed snapshot command for the fixture's audit selection: every tracked or new path except the
 * user's personal note, with the handbook docs root, against main's commit, and the invocation record as its
 * --run like /ship's Prepare. Returned as argv; the first element is the installed helper, so the command is
 * the literal form the observation interface admits.
 */
export function docsSnapshotArgv(fixture: { repo: string; skills: string; invocation: string }, auditId: string, out: string): string[] {
  const inventory = repoInventory(fixture.repo);
  return [path.join(fixture.skills, 'bin/gstack-docs-candidate'), 'snapshot', '--out', out, '--audit-id', auditId,
    '--mode', 'edit', '--base', gitAt(fixture.repo, 'rev-parse', 'main'),
    ...inventory.filter(p => p !== 'personal-note.txt').flatMap(p => ['--select', p]), '--docs', 'handbook', '--run', fixture.invocation];
}

/** Git blob id of content, the hash representation of `DocsCandidateRecord.hashes`. */
export function gitBlobId(content: Buffer): string {
  return new Bun.CryptoHasher('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}
