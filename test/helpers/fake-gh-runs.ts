/**
 * A fake gh for the CI-carry tests (GSTA-258): serves the Actions run, jobs, artifact and download reads
 * lib/run-evidence.ts ghRunDeps makes from a world file, and answers every other gh call with nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeWorld {
  runs: Array<Record<string, unknown> & { id: number; run_attempt: number; head_sha: string; path: string }>;
  jobs: Record<string, Array<{ name: string; conclusion: string | null; completed_at?: string }>>;
  trees: Record<string, Record<string, unknown>>;
}

/** The stub body for shipFixture's gh(): run this file with the world beside it. */
export const fakeGhScript = (worldFile: string) => `exec bun --no-env-file --config=/dev/null '${import.meta.path}' '${worldFile}' "$@"`;

if (import.meta.main) {
  const [worldFile, ...a] = process.argv.slice(2);
  const world: FakeWorld = fs.existsSync(worldFile!) ? JSON.parse(fs.readFileSync(worldFile!, 'utf8')) : { runs: [], jobs: {}, trees: {} };
  const lines = (list: unknown[]) => process.stdout.write(list.map(x => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''));
  if (a[0] === 'api') {
    const jq = a.indexOf('--jq');
    const p = a.filter((x, i) => i > 0 && x !== '--paginate' && i !== jq && i !== jq + 1)[0] ?? '';
    const [route, query = ''] = p.split('?');
    const q = new URLSearchParams(query);
    let m: RegExpExecArray | null;
    if ((m = /\/actions\/runs\/(\d+)$/.exec(route!))) {
      const run = world.runs.find(r => r.id === Number(m![1]));
      if (!run) { process.stderr.write('HTTP 404'); process.exit(1); }
      process.stdout.write(JSON.stringify(run));
    } else if ((m = /\/actions\/workflows\/([^/]+)\/runs$/.exec(route!))) {
      lines(world.runs.filter(r => r.head_sha === q.get('head_sha') && r.path === `.github/workflows/${m![1]}`));
    } else if ((m = /\/actions\/runs\/(\d+)\/attempts\/\d+\/jobs$/.exec(route!))) {
      lines(world.jobs[m[1]!] ?? []);
    } else if ((m = /\/actions\/runs\/(\d+)\/artifacts$/.exec(route!))) {
      lines(world.trees[m[1]!] ? [{ name: q.get('name'), size_in_bytes: 200, expired: false }] : []);
    } else { process.stderr.write(`fake gh: no route for ${p}`); process.exit(1); }
  } else if (a[0] === 'run' && a[1] === 'download') {
    const tree = world.trees[a[2]!];
    if (!tree) process.exit(1);
    const dir = a[a.indexOf('--dir') + 1]!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(tree));
  }
}
