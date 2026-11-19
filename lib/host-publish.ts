/**
 * host-publish — GitHub writes on Capy go through the host's PR tool, never gh (GST-3183).
 *
 * On Capy (GSTACK_CAPY=1) the machine's gh is signed in as the owner's personal GitHub account, so an edit, comment or
 * new PR sent through gh lands under their name (GBEV-105, 2026-11-19: `gstack-ship-receipt stub` edited an outside
 * system's PR body as the owner during an unattended /ship). Each /ship command that would write through gh asks
 * hostPublishes() first; when it answers true the command writes the exact bytes it would have sent to a private file
 * under the state root and prints the one HOST_PUBLISH: line handOff() returns, and the agent publishes that file with
 * its host's PR tool (Capy's tools.pr.edit, tools.pr.comment or tools.pr.create). Reads through gh are unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStateRoot, type StateRootEnv } from './state-root';

export const hostPublishes = (env: StateRootEnv = process.env): boolean => env.GSTACK_CAPY === '1';

/** What the host's PR tool does with each operation's files, as the HOST_PUBLISH: line says it. */
const HOST_TOOL: Record<string, string> = {
  'pr-body': "replace the PR's body with body-file (Capy: tools.pr.edit body)",
  'pr-title': "set the PR's title to title-file (Capy: tools.pr.edit title)",
  'pr-comment': 'post body-file as a PR comment (Capy: tools.pr.comment)',
  'issue-comment': 'post body-file as a comment on that issue or PR (Capy: tools.pr.comment on a PR; an issue goes to whoever owns the work)',
  reply: 'post body-file as a reply in that review thread (Capy: tools.pr.comment reply_to)',
  'pr-create': 'open the PR from title-file and body-file (Capy: tools.pr.create)',
  'issue-create': 'open the issue from title-file and body-file, or hand both files to whoever owns the work (Capy has no GitHub issue tool)',
};

/** A repository path the host tool can be pointed at: owner/name, or a GitLab group path. */
const REPO_PATH = /^[\w.-]+(\/[\w.-]+)+$/;

/**
 * Write each part to a new private directory <state root>/publish/<op>-<target>-<random>/<part>.md (mode 0600), so no
 * hand-off ever overwrites another one still waiting to be published (another repo's PR #7, a second pr-create), and return the HOST_PUBLISH: line naming them and the destination the gh write would have used
 * (repo= always, host= unless github.com, reply's to=, pr-create's base=, head= and draft), with a newline. The host tool
 * has nothing else to go on and would fall back to the thread's primary repository, so a hand-off without a resolved
 * repo throws before any file is written.
 */
export function handOff(o: { op: string; target?: string; repo: string; host?: string; to?: string; base?: string; head?: string; draft?: boolean; parts: Array<[string, string]>; env?: StateRootEnv }): string {
  if (!REPO_PATH.test(o.repo ?? '')) throw new Error(`HOST_PUBLISH needs the destination repository (owner/name), got ${JSON.stringify(o.repo ?? '')}`);
  if (o.host !== undefined && !/^[\w.-]+(:\d+)?$/.test(o.host)) throw new Error(`HOST_PUBLISH host ${JSON.stringify(o.host)} is not a hostname`);
  const host = o.host && o.host.toLowerCase() !== 'github.com' ? o.host.toLowerCase() : undefined;
  const dir = path.join(resolveStateRoot(o.env ?? process.env), 'publish');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const own = fs.mkdtempSync(path.join(dir, `${o.op}-${(o.target ?? 'new').replace(/[^\w.-]/g, '_')}-`));
  fs.chmodSync(own, 0o700);
  const files = o.parts.map(([part, text]) => {
    const file = path.join(own, `${part}.md`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return `${part}-file=${file}`;
  });
  const dest = [`repo=${o.repo}`, host && `host=${host}`, o.to && `to=${o.to}`, o.base && `base=${o.base}`, o.head && `head=${o.head}`, o.draft && 'draft'].filter(Boolean).map((d) => ` ${d}`).join('');
  return `HOST_PUBLISH: ${o.op} ${o.target ?? 'new'}${dest} ${files.join(' ')} (gh was not called: on Capy it signs in as the owner's own GitHub account; ${HOST_TOOL[o.op] ?? 'publish these files with the host PR tool'}, before the next gstack step; docs/troubleshooting.md#host-publish)\n`;
}
