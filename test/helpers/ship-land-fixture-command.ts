import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const [controlFile, tool, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const { name, head, eventFile } = control;
const record = (event: Record<string, unknown>) => fs.appendFileSync(eventFile, JSON.stringify({ kind: tool, args, cwd: process.cwd(), ...event }) + '\n', { mode: 0o600 });
record({ phase: 'start' });

let exit = 0;
let output: unknown;
if (tool === 'gstack-evidence') {
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../../bin/gstack-evidence'), ...args], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  exit = result.status ?? 127;
} else if (args[0] === 'pr' && args[1] === 'checks') {
  const fields = args[args.indexOf('--json') + 1];
  if (args.includes('--json') && fields !== 'name,state,bucket' && fields !== 'name,link') {
    exit = 1;
    console.error('Unknown JSON field; supported fields: name,state,bucket,link');
  } else {
    const bucket = ({ 'ci-pending': 'pending', 'ci-failed': 'fail', 'ci-cancelled': 'cancel', 'ci-skipped': 'skipping' } as Record<string, string>)[name] ?? 'pass';
    const state = ({ pending: 'IN_PROGRESS', fail: 'FAILURE', cancel: 'CANCELLED', skipping: 'SKIPPED', pass: 'SUCCESS' } as Record<string, string>)[bucket];
    output = name === 'ci-empty' ? [] : [{ name: 'Validation', state, bucket, link: 'https://example.invalid/check' }];
    exit = bucket === 'pending' ? 8 : bucket === 'fail' || bucket === 'cancel' || name === 'ci-empty' ? 1 : 0;
    if (args.includes('--watch')) exit = 1;
  }
} else if (args[0] === 'pr' && args[1] === 'view') {
  const bot = name === 'review-bot';
  const pending = ['review-pending', 'review-waiver', 'review-generic-waiver', 'review-rerequested', 'review-protected'].includes(name);
  const decision = name === 'review-changes-requested' ? 'CHANGES_REQUESTED' : ['review-approved', 'review-approved-comment', 'review-head-change'].includes(name) ? 'APPROVED' : '';
  const value: Record<string, unknown> = {
    number: 42, url: 'https://github.com/fixture-owner/fixture-repo/pull/42', headRefOid: head,
    reviewDecision: decision, state: control.state, mergeable: 'MERGEABLE', mergeCommit: null,
    autoMergeRequest: null, baseRefName: 'main', headRefName: 'fixture',
    reviewRequests: name === 'review-team' ? [{ __typename: 'Team', name: 'Maintainers', slug: 'maintainers' }]
      : pending || bot ? [{ __typename: bot ? 'Bot' : 'User', login: bot ? 'checks[bot]' : 'alice' }] : [],
  };
  const q = args.includes('-q') ? args[args.indexOf('-q') + 1] : args.includes('--jq') ? args[args.indexOf('--jq') + 1] : undefined;
  output = q === '.headRefOid' ? head : q === '.mergeable' ? value.mergeable : q === '.autoMergeRequest' ? null : value;
} else if (args[0] === 'api') {
  const endpoint = args.find(arg => arg.startsWith('repos/')) ?? '';
  if (name === 'review-unknown' && endpoint.endsWith('/timeline')) {
    console.error('HTTP 403: review history unavailable');
    exit = 1;
  } else if (endpoint.endsWith('/timeline')) {
    const user = { login: name === 'review-bot' ? 'checks[bot]' : 'alice', type: name === 'review-bot' ? 'Bot' : 'User' };
    output = name === 'review-solo' || name.startsWith('ci-') ? []
      : [{ event: 'review_requested', created_at: '2026-09-20T00:00:00Z', actor: { login: 'owner', type: 'User' },
        ...(name === 'review-team' ? { requested_team: { slug: 'maintainers', name: 'Maintainers' } } : { requested_reviewer: user }) },
        ...(['review-commented', 'review-approved', 'review-approved-comment', 'review-dismissed', 'review-stale', 'review-head-change'].includes(name)
          ? [{ event: 'review_request_removed', created_at: '2026-09-21T00:00:00Z', requested_reviewer: user, actor: user }] : []),
        ...(name === 'review-rerequested' ? [{ event: 'review_requested', created_at: '2026-09-23T00:00:00Z', requested_reviewer: user, actor: { login: 'owner', type: 'User' } }] : [])];
  } else if (endpoint.endsWith('/reviews')) {
    const state = ({ 'review-commented': 'COMMENTED', 'review-changes-requested': 'CHANGES_REQUESTED', 'review-dismissed': 'DISMISSED' } as Record<string, string>)[name] ?? 'APPROVED';
    const empty = ['review-pending', 'review-waiver', 'review-generic-waiver', 'review-team', 'review-unknown', 'review-protected'].includes(name);
    output = empty ? [] : [{ id: 1, user: { login: name === 'review-bot' ? 'checks[bot]' : name === 'review-solo' ? 'unsolicited' : 'alice', type: name === 'review-bot' ? 'Bot' : 'User' },
      state: name === 'review-solo' ? 'COMMENTED' : state, commit_id: name === 'review-stale' ? 'c'.repeat(40) : 'a'.repeat(40), submitted_at: '2026-09-21T00:00:00Z' },
      ...(name === 'review-approved-comment' ? [{ id: 2, user: { login: 'alice', type: 'User' }, state: 'COMMENTED', commit_id: head, submitted_at: '2026-09-22T00:00:00Z' }] : [])];
  } else if (endpoint === 'repos/fixture-owner/fixture-repo') output = { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false };
  else { exit = 1; console.error('Unsupported fixture API; no external call made'); }
} else if (args[0] === 'pr' && args[1] === 'merge') {
  const matched = args[args.indexOf('--match-head-commit') + 1];
  if (matched !== head || !args.includes('42') || args.includes('--admin')) {
    exit = 1; console.error('Merge head/PR/protection guard rejected');
  } else if (name === 'review-protected') { exit = 1; console.error('Protected branch: required approving review missing'); }
  else {
    fs.writeFileSync(controlFile, JSON.stringify({ ...control, state: 'MERGED' }), { mode: 0o600 });
    output = 'Fixture PR merged';
  }
} else { exit = 1; console.error('Unsupported fixture command; no external call made'); }
if (output !== undefined) console.log(typeof output === 'string' ? output : JSON.stringify(output));
record({ phase: 'end', exit });
process.exitCode = exit;
