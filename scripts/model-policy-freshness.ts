import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { collectFreshnessSources, type Fetcher } from '../lib/model-policy-freshness-sources';
import { assessFreshness, freshnessCatalogIdentity, renderFreshnessReport, type FreshnessObservation } from '../lib/model-policy-freshness';
import { freshnessGitHub } from '../lib/model-policy-freshness-github';
import { publishFreshness, type FreshnessGitHub } from '../lib/model-policy-freshness-publication';

export async function runModelPolicyFreshness(options: {
  env?: NodeJS.ProcessEnv; fetcher?: Fetcher; github?: FreshnessGitHub; now?: () => string; publish?: boolean;
}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const catalog = freshnessCatalogIdentity(readFileSync(new URL('../lib/model-catalog.ts', import.meta.url), 'utf8'));
  const sources = await collectFreshnessSources(options.fetcher);
  const observation: FreshnessObservation = {
    catalog,
    checkedAt: now(), run: { id: env.GITHUB_RUN_ID ?? '0', attempt: Number(env.GITHUB_RUN_ATTEMPT ?? '1'), startedAt, headSha: env.GITHUB_SHA ?? '0'.repeat(40) }, sources,
  };
  let report = assessFreshness(observation);
  let publication;
  if (options.publish) {
    if (!env.GITHUB_REF) throw new Error('publication-ref-missing');
    if (env.GITHUB_REF === 'refs/heads/main' && (!env.GITHUB_REPOSITORY || !env.GH_TOKEN || !env.GITHUB_RUN_ID || !env.GITHUB_SHA)) throw new Error('github-publication-prerequisites-missing');
    try {
      const github = options.github ?? (env.GITHUB_REF === 'refs/heads/main' ? freshnessGitHub(env.GITHUB_REPOSITORY!, env.GH_TOKEN!, options.fetcher) : null);
      publication = github ? await publishFreshness(observation, github, env.GITHUB_REF) : { action: 'report-only' as const };
      if ('report' in publication && publication.report) report = publication.report;
    } catch (error) {
      const reason = error instanceof Error && /^[a-z0-9: /.-]{1,160}$/i.test(error.message) ? error.message : 'publication-unavailable';
      publication = { action: 'failed' as const, error: reason };
      report = { ...report, status: 'unknown/source-unavailable', complete: false, errors: [...report.errors, `publication:${reason}`] };
    }
  }
  return { schemaVersion: 1, observation, report, publication };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--publish', '--help'].includes(arg))) { console.error('Usage: bun scripts/model-policy-freshness.ts [--publish]'); return 2; }
  if (args.includes('--help')) {
    console.log('Check four official public model recommendation/lifecycle sources without paid calls. Default: report-only. --publish requires main/default-branch identity and GITHUB_TOKEN-backed GH_TOKEN; no catalog or pin writes. JSON goes to stdout. Optional MODEL_FRESHNESS_REPORT writes the same artifact; GITHUB_STEP_SUMMARY receives the human report.');
    return 0;
  }
  const result = await runModelPolicyFreshness({ publish: args.includes('--publish') });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.MODEL_FRESHNESS_REPORT) writeFileSync(process.env.MODEL_FRESHNESS_REPORT, output, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderFreshnessReport(result.report)}\n`);
  console.log(output.trimEnd());
  if (result.publication?.action.startsWith('rejected-') || result.publication?.action === 'failed') return 1;
  return result.report.status === 'unknown/source-unavailable' || result.report.status === 'stale' ? 1 : 0;
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Model-policy freshness or report delivery failed. Confirm the tracking issue state; do not infer freshness from this run. Check the workflow logs, official sources, issue permissions/state, and docs/troubleshooting.md#model-policy-freshness.');
    process.exitCode = 1;
  });
}
