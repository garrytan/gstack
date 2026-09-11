import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessLocalGrant, issueGrant, canonicalAssertionPath, type GovernedSkill } from './effect-scope';
import { buildGitPushPlan } from './git-push-boundary';
import { resolveGitTransport, validateStaticSshConfig } from './git-transport-policy';
import { buildGitCommitPlan, buildGitStagePlan } from './git-stage-commit-boundary';
import { buildProviderCommentPlan } from './provider-comment-boundary';
import { canonicalProviderRemote } from './provider-access';
import { resolveInstalledTool } from './toolchain-policy';
import { projectAccountEnvironment, type AccountTool } from './account-environment';
import { resolveTrustedWorkProfile } from './trusted-base';
import { resolveReleasePolicy, type ReleaseMode, type ReleaseTitlePolicy } from './release-policy';
import { rewriteResolvedPrTitle } from './pr-title-policy';
import type { Lane } from './work-profile';
export { prepareDocumentRelease, finishDocumentRelease } from './document-release-adapter';
export { inspectGitBaseSync, executeGitBaseSync } from './git-base-sync-adapter';
import {
  buildProviderPrDiscoveryArgs,
  buildProviderPrMutationArgs,
  buildProviderPrViewArgs,
  parseProviderPrDiscovery,
  parseProviderPrCreateOutput,
  providerPrRepositorySelector,
  resolveProviderPrKind,
  validateProviderPrSnapshot,
  type ProviderPrKind,
} from './provider-pr-boundary';

async function run(tool: AccountTool, argv: string[], cwd: string, env: Record<string, string> = {}, input?: string | Uint8Array): Promise<string> {
  const command = tool === 'git' ? [argv[0], '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv.slice(1)] : argv;
  const child = Bun.spawn(command, {
    cwd, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
    env: { ...projectAccountEnvironment(tool), ...env },
  });
  const [stdout, , status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Child diagnostics can contain credentials loaded from either env or config.
  if (status !== 0) throw new Error(`closed_effect_failed:${status}`);
  return stdout;
}

function hash(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function requireAuthorization(name: string): void {
  if (process.env[name] !== '1') throw new Error('grant_required');
}

async function assertGitStageInputs(executable: string, root: string, paths: readonly string[]): Promise<void> {
  // Inspect every effective config scope before diff/add can invoke a driver.
  const keys = (await run('git', [executable, 'config', '--includes', '--null', '--name-only', '--list'], root)).split('\0');
  if (keys.some(key => /^(filter\.|diff\..*\.(command|textconv)$|merge\..*\.driver$)/i.test(key))) {
    throw new Error('git_attribute_driver_unsupported');
  }
  for (const item of paths) {
    let info: fs.Stats | undefined;
    try { info = fs.lstatSync(path.join(root, item)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error('git_stage_path_not_file');
    // A worktree file can replace an indexed directory. Even a literal add
    // would then stage deletions below this prefix, outside the exact grant.
    const tracked = (await run('git', [executable, '--literal-pathspecs', 'ls-files', '-z', '--', item], root)).split('\0').filter(Boolean);
    if (tracked.some(entry => entry !== item) || (!info && tracked.length !== 1)) throw new Error('git_stage_path_not_file');
  }
  const attributes = (await run('git', [executable, 'check-attr', '-z', '--stdin', 'filter', 'diff', 'merge'], root, {}, `${paths.join('\0')}\0`)).split('\0');
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const [, name, value] = attributes.slice(index, index + 3);
    if (!['unset', 'unspecified'].includes(value) && (name === 'filter' || value !== 'set')) {
      throw new Error('git_attribute_driver_unsupported');
    }
  }
}

async function assertGitPushConfig(executable: string, root: string): Promise<void> {
  const keys = (await run('git', [executable, 'config', '--includes', '--null', '--name-only', '--list'], root)).split('\0');
  // URL-specific HTTP policy outranks generic `-c http.*` overrides in Git.
  if (keys.some(key => /^(url\..*\.(insteadof|pushinsteadof)|remote\..*\.(pushurl|receivepack|uploadpack|proxy|mirror)|core\.(sshcommand|gitproxy)|ssh\.variant)$/i.test(key)
    || /^http\..*\.(followredirects|sslverify)$/i.test(key))) {
    throw new Error('git_transport_config_unsupported');
  }
}

async function prepareGitSsh(root: string, host: string): Promise<{ environment: Record<string, string>; cleanup: () => void }> {
  const ssh = await resolveInstalledTool('ssh');
  const account = projectAccountEnvironment('git');
  const sourceFile = path.join(account.HOME || os.homedir(), '.ssh', 'config');
  const source = validateStaticSshConfig(fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : '');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-push-ssh-'));
  const configFile = path.join(directory, 'config');
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.writeFileSync(configFile, source, { mode: 0o600 });
    // -F ignores ambient user/system config. The static projection contains no
    // Include/Match/command directives, so -G is a local, non-executing check.
    const child = Bun.spawn([ssh.realpath, '-G', '-F', configFile, `git@${host}`], {
      cwd: root, env: account, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, , status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const settings = new Map(stdout.trim().split(/\r?\n/).map(line => {
      const space = line.indexOf(' '); return [line.slice(0, space), line.slice(space + 1)] as const;
    }));
    if (status !== 0 || settings.get('hostname')?.toLowerCase() !== host || settings.get('user') !== 'git' || settings.get('port') !== '22') {
      throw new Error('git_ssh_config_unsupported');
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [ssh.realpath, '-F', configFile, '-o', `HostName=${host}`, '-o', 'User=git', '-p', '22', '-o', 'BatchMode=yes'].map(quote).join(' ');
    return { environment: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: 'ssh' }, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export async function executeGitStageCommit(cwd: string, input: {
  skill: GovernedSkill; operation: string; paths: string[];
}): Promise<{ status: 'committed'; commitOid: string; paths: readonly string[] }> {
  requireAuthorization('ECPE_GIT_WRITE_AUTHORIZED');
  if (input.skill !== 'ship') throw new Error('effect_skill_invalid');
  if (input.operation === 'ship.base_sync') throw new Error('git_base_sync_adapter_required');
  const git = await resolveInstalledTool('git');
  const root = (await run('git', [git.realpath, 'rev-parse', '--show-toplevel'], cwd)).trim();
  const headOid = (await run('git', [git.realpath, 'rev-parse', '--verify', 'HEAD'], root)).trim().toLowerCase();
  const requested = [...new Set(input.paths.map(canonicalAssertionPath))].sort();
  if (!requested.length) throw new Error('git_stage_projection_invalid');
  await assertGitStageInputs(git.realpath, root, requested);
  const staged = (await run('git', [git.realpath, 'diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff'], root))
    .split('\0').filter(Boolean).sort();
  if (staged.some((item) => !requested.includes(item))) throw new Error('git_stage_foreign_preimage');
  const indexPreimage = hash(await run('git', [git.realpath, 'diff', '--cached', '--binary', '--no-ext-diff'], root));
  const plan = buildGitStagePlan({
    operation: input.operation, headOid, indexPreimage,
    gateId: `${input.operation}:current`, paths: requested,
  });
  new ProcessLocalGrant(issueGrant(input.skill, 'git_stage', {
    operation: plan.operation, headOid: plan.headOid, indexPreimage: plan.indexPreimage, paths: plan.paths,
  })).consume('git_stage');
  await run('git', [git.realpath, '--literal-pathspecs', ...plan.configArgs, 'add', '--', ...plan.paths], root, { ...plan.environment });
  const stagedAfter = (await run('git', [git.realpath, 'diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff'], root)).split('\0').filter(Boolean);
  if (stagedAfter.some(item => !plan.paths.includes(item))) throw new Error('git_stage_projection_changed');
  const treeOid = (await run('git', [git.realpath, ...plan.configArgs, 'write-tree'], root, { ...plan.environment })).trim();
  const stageIntent = hash(plan);
  buildGitCommitPlan(stageIntent, treeOid);
  new ProcessLocalGrant(issueGrant(input.skill, 'git_commit', { stageIntent, treeOid })).consume('git_commit');
  await run('git', [git.realpath, ...plan.configArgs, 'commit', '-m', 'chore: governed ship delivery'], root, { ...plan.environment });
  const commitOid = (await run('git', [git.realpath, 'rev-parse', '--verify', 'HEAD'], root)).trim().toLowerCase();
  return { status: 'committed', commitOid, paths: plan.paths };
}

export async function executeGitPush(cwd: string, input: {
  skill: GovernedSkill; operation: string;
}): Promise<{ status: 'pushed'; sourceOid: string; destinationRef: string }> {
  requireAuthorization('ECPE_GIT_PUSH_AUTHORIZED');
  if (input.skill !== 'ship' || input.operation !== 'ship.delivery') throw new Error('git_operation_invalid');
  const git = await resolveInstalledTool('git');
  const root = (await run('git', [git.realpath, 'rev-parse', '--show-toplevel'], cwd)).trim();
  const branch = (await run('git', [git.realpath, 'branch', '--show-current'], root)).trim();
  if (!branch) throw new Error('git_detached_head');
  const sourceOid = (await run('git', [git.realpath, 'rev-parse', '--verify', 'HEAD'], root)).trim().toLowerCase();
  await assertGitPushConfig(git.realpath, root);
  const remoteUrl = (await run('git', [git.realpath, 'remote', 'get-url', 'origin'], root)).trim();
  const remote = canonicalProviderRemote(remoteUrl);
  const destinationRef = `refs/heads/${branch}`;
  const transport = resolveGitTransport(remoteUrl, remote.comparisonKey);
  const ssh = transport.mode === 'github_ssh.v1' ? await prepareGitSsh(root, remote.host) : { environment: {}, cleanup: () => {} };
  const config = ['-c', 'protocol.allow=never', '-c', `protocol.${transport.mode === 'github_ssh.v1' ? 'ssh' : 'https'}.allow=always`,
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no'];
  const environment = { ...ssh.environment, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    const remoteLine = (await run('git', [git.realpath, ...config, 'ls-remote', '--heads', transport.normalizedUrl, destinationRef], root, environment)).trim();
    const expectedRemoteOid = remoteLine ? remoteLine.split(/\s+/, 1)[0] : null;
    const plan = buildGitPushPlan({ remoteUrl, expectedRepositoryKey: remote.comparisonKey, sourceOid, destinationRef, expectedRemoteOid });
    await assertGitPushConfig(git.realpath, root);
    new ProcessLocalGrant(issueGrant(input.skill, 'git_push', {
      operation: input.operation, sourceOid, destinationRef, expectedRemoteOid: expectedRemoteOid ?? '',
    })).consume('git_push');
    await run('git', [git.realpath, ...config, 'push', '--no-follow-tags', '--recurse-submodules=no', ...plan.argv.slice(1)], root, environment);
    return { status: 'pushed', sourceOid, destinationRef };
  } finally { ssh.cleanup(); }
}

export async function executeProviderPr(cwd: string, input: {
  skill: GovernedSkill; action: 'create' | 'update'; provider?: ProviderPrKind; base?: string; pr?: number; title: string; bodyFile: string; assertBodySha256: string; lane: Lane;
  assertTargetRef: string; assertReleaseMode: ReleaseMode; assertTitlePolicy: ReleaseTitlePolicy; releaseRequested?: boolean; version?: string;
}): Promise<{ status: 'created' | 'updated'; provider: ProviderPrKind; number: number; url: string }> {
  requireAuthorization('ECPE_PR_AUTHORIZED');
  if (!['create', 'update'].includes(input.action)) throw new Error('provider_pr_action_invalid');
  if (input.skill !== 'ship' || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(input.lane)||!input.title.trim()||/[\r\n]/.test(input.title)) throw new Error('provider_pr_assertion_invalid');
  if (input.action === 'create' && input.pr !== undefined) throw new Error('provider_pr_number_invalid');
  if (input.action === 'update' && (!Number.isSafeInteger(input.pr) || (input.pr ?? 0) <= 0)) throw new Error('provider_pr_number_invalid');
  if (!/^[0-9a-f]{64}$/.test(input.assertBodySha256)) throw new Error('provider_pr_body_hash_invalid');
  const git = await resolveInstalledTool('git');
  const root = (await run('git', [git.realpath, 'rev-parse', '--show-toplevel'], cwd)).trim();
  const resolvedProfile = resolveTrustedWorkProfile({ cwd: root, lane: input.lane, assertTargetRef: input.assertTargetRef });
  const decision = resolveReleasePolicy({ resolvedProfile, releaseRequested: input.releaseRequested, assertReleaseMode:input.assertReleaseMode,assertTitlePolicy: input.assertTitlePolicy, cwd: root });
  if (rewriteResolvedPrTitle({ decision, title: input.title, version: input.version }) !== input.title) throw new Error('provider_pr_assertion_invalid');
  const requestedBodyFile = path.resolve(cwd, input.bodyFile);
  let requestedInfo: fs.Stats;
  try { requestedInfo = fs.lstatSync(requestedBodyFile); } catch { throw new Error('provider_pr_body_invalid'); }
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()
    || (typeof process.getuid === 'function' && requestedInfo.uid !== process.getuid())
    || (requestedInfo.mode & 0o077) !== 0) throw new Error('provider_pr_body_invalid');
  const bodyFile = fs.realpathSync(requestedBodyFile);
  const canonicalRoot = fs.realpathSync(root);
  const canonicalTemp = fs.realpathSync(os.tmpdir());
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  if (!within(canonicalRoot, bodyFile) && !within(canonicalTemp, bodyFile)) throw new Error('provider_pr_body_invalid');
  const body = fs.readFileSync(bodyFile);
  if (hashBytes(body) !== input.assertBodySha256) throw new Error('provider_pr_body_changed');
  const remote = canonicalProviderRemote((await run('git', [git.realpath, 'remote', 'get-url', 'origin'], root)).trim());
  const provider = resolveProviderPrKind(remote, input.provider);
  const repositorySelector = providerPrRepositorySelector(provider, remote);
  const providerTool = await resolveInstalledTool(provider === 'github' ? 'gh' : 'glab');
  const head = (await run('git', [git.realpath, 'branch', '--show-current'], root)).trim();
  if (!head || !/^[A-Za-z0-9._/-]+$/.test(head) || head.includes('..')) throw new Error('provider_pr_branch_invalid');
  if (input.action === 'update') {
    const before = await run(provider, [providerTool.realpath, ...buildProviderPrViewArgs(provider, repositorySelector, input.pr!)], root);
    validateProviderPrSnapshot(provider, remote, { pr: input.pr!, head }, before);
  } else {
    if (!input.base || !/^[A-Za-z0-9._/-]+$/.test(input.base) || input.base.includes('..')) throw new Error('provider_pr_base_invalid');
    const discoveredRaw = await run(provider, [
      providerTool.realpath,
      ...buildProviderPrDiscoveryArgs(provider, repositorySelector, head),
    ], root);
    if (parseProviderPrDiscovery(provider, remote, { head }, discoveredRaw) !== null) {
      throw new Error('provider_pr_already_exists');
    }
  }
  const capability = input.action === 'create' ? 'pr_create' : 'pr_update';
  new ProcessLocalGrant(issueGrant(input.skill, capability, {
    repository: remote.comparisonKey, provider, ...(input.pr ? { pr: input.pr } : {}),
    titleHash: hash(input.title), bodyHash: input.assertBodySha256,
  })).consume(capability);
  let pr: number;
  if (input.action === 'create') {
    const raw = await run(provider, [providerTool.realpath, ...buildProviderPrMutationArgs({
      provider, action: 'create', repositorySelector,
      base: input.base, head, title: input.title, bodyFile: '-',
    })], root, {}, body);
    pr = parseProviderPrCreateOutput(provider, remote, raw).number;
  } else {
    pr = input.pr!;
    await run(provider, [providerTool.realpath, ...buildProviderPrMutationArgs({
      provider, action: 'update', repositorySelector,
      pr, title: input.title, bodyFile: '-',
    })], root, {}, body);
  }
  const snapshot = await run(provider, [providerTool.realpath, ...buildProviderPrViewArgs(provider, repositorySelector, pr)], root);
  const identity = validateProviderPrSnapshot(provider, remote, { pr, head, title: input.title }, snapshot);
  return { status: input.action === 'create' ? 'created' : 'updated', provider, ...identity };
}

export async function discoverProviderPr(cwd: string, input: {
  skill: GovernedSkill;
  provider?: ProviderPrKind;
}): Promise<
  | { status: 'absent'; provider: ProviderPrKind }
  | { status: 'present'; provider: ProviderPrKind; number: number; url: string; title: string }
> {
  if (input.skill !== 'ship') throw new Error('effect_skill_invalid');
  const git = await resolveInstalledTool('git');
  const root = (await run('git', [git.realpath, 'rev-parse', '--show-toplevel'], cwd)).trim();
  const remote = canonicalProviderRemote((await run('git', [git.realpath, 'remote', 'get-url', 'origin'], root)).trim());
  const provider = resolveProviderPrKind(remote, input.provider);
  const repositorySelector = providerPrRepositorySelector(provider, remote);
  const providerTool = await resolveInstalledTool(provider === 'github' ? 'gh' : 'glab');
  const head = (await run('git', [git.realpath, 'branch', '--show-current'], root)).trim();
  if (!head || !/^[A-Za-z0-9._/-]+$/.test(head) || head.includes('..')) throw new Error('provider_pr_branch_invalid');
  const raw = await run(provider, [
    providerTool.realpath,
    ...buildProviderPrDiscoveryArgs(provider, repositorySelector, head),
  ], root);
  const discovered = parseProviderPrDiscovery(provider, remote, { head }, raw);
  return discovered === null
    ? { status: 'absent', provider }
    : { status: 'present', provider, ...discovered };
}

export async function executeProviderComment(cwd: string, input: {
  skill: GovernedSkill; operation: string; pr: number; commentId: string; replyIntent: string; bodyFile: string;
}): Promise<{ status: 'replied'; bodyHash: string }> {
  requireAuthorization('ECPE_EXTERNAL_REPLY_AUTHORIZED');
  const body = fs.readFileSync(path.resolve(cwd, input.bodyFile), 'utf8');
  const [git, gh] = await Promise.all([resolveInstalledTool('git'), resolveInstalledTool('gh')]);
  const remoteUrl = (await run('git', [git.realpath, 'remote', 'get-url', 'origin'], cwd)).trim();
  const remote = canonicalProviderRemote(remoteUrl);
  const plan = buildProviderCommentPlan({ ...input, remoteUrl, expectedRepositoryKey: remote.comparisonKey, body });
  new ProcessLocalGrant(issueGrant(input.skill, 'external_reply', {
    pr: plan.pr, commentId: plan.commentId, replyIntent: plan.replyIntent, bodyHash: plan.bodyHash,
  })).consume('external_reply');
  await run('github', [gh.realpath, 'api', '--hostname', remote.host, '--method', 'POST', plan.endpoint, '-f', `body=${body}`], cwd);
  return { status: 'replied', bodyHash: plan.bodyHash };
}

export async function executeRollback(): Promise<never> {
  requireAuthorization('ECPE_ROLLBACK_AUTHORIZED');
  throw new Error('adapter_operation_unsupported');
}
