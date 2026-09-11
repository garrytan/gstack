/** Security-critical CSO routing/proof policy must remain in the always-loaded controller. */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const controller = () => fs.readFileSync(path.join(ROOT, 'cso/SKILL.md'), 'utf8');
const template = () => fs.readFileSync(path.join(ROOT, 'cso/SKILL.md.tmpl'), 'utf8');
const domain = () => fs.readFileSync(path.join(ROOT, 'cso/sections/audit-phases.md'), 'utf8');

describe('CSO v3 always-loaded policy', () => {
  test('dispatch and execution boundaries are available before a host section read', () => {
    const text = controller();
    const stop = text.indexOf('> **STOP.**');
    for (const directive of ['## Arguments', '## Mode Resolution', '**Private startup.**', 'untrusted evidence']) {
      expect(text.indexOf(directive)).toBeGreaterThan(-1);
      if (stop >= 0) expect(text.indexOf(directive)).toBeLessThan(stop);
    }
    for (const phase of [0, 1, 12, 13, 14]) expect(text).toContain(`### Phase ${phase}:`);
  });

  test('every scope and lifecycle entrypoint survives host generation', () => {
    const text = controller();
    for (const flag of ['--infra', '--code', '--skills', '--supply-chain', '--owasp', '--scope', '--diff', '--base', '--budget', '--offline', '--comprehensive', '--doctor', '--resume', '--replay', '--recheck']) {
      expect(text).toContain(flag);
    }
    expect(text).toContain('mutually exclusive');
    for (const command of ['start', 'doctor', 'resume', 'replay', 'recheck', 'inspect', 'read', 'history', 'scan', 'import-sarif', 'submit', 'verify', 'finish', 'import-v2', 'schema']) {
      expect(text).toContain(`gstack-cso ${command}`);
    }
  });

  test('CSO cannot acquire shared preamble execution or content-export hooks', () => {
    for (const forbidden of ['{{PREAMBLE}}', '{{GBRAIN_CONTEXT_LOAD}}', '{{GBRAIN_SAVE_RESULTS}}', '{{LEARNINGS_SEARCH}}', '{{LEARNINGS_LOG}}', '{{CONFIDENCE_CALIBRATION}}']) {
      expect(template()).not.toContain(forbidden);
    }
    const text = controller();
    expect(text).not.toContain('gstack-skill-start');
    expect(text).not.toContain('gstack-telemetry-log');
    expect(text).not.toContain('gstack-review-log');
    expect(text).toContain('Do not send findings, source, secrets, harnesses, or bundles');
    expect(text).toContain('trusted installed gstack distribution');
  });

  test('static review cannot acquire tested or current-source closure labels', () => {
    const text = controller();
    for (const proof of ['CSO evidence rubric', 'identical security assertion', 'legitimate control passes', 'pristine second copy', 'before/after configuration and dependency closures', 'boundary-replacing mocks', 'legacy review evidence', 'new evidence covering the same root cause']) {
      expect(text).toContain(proof);
    }
    expect(text).toContain('Keep finding evidence, reproduction outcome, patch validation, test-completion assurance, review assurance, and current-source closure separate');
    expect(text).toContain('cannot establish that an application booted or a repair passed tests');
  });

  test('runtime and scanner execution claims require qualified catalog profiles', () => {
    const text = controller();
    expect(text).toContain('Static assessment remains available without runtime or scanner profiles');
    expect(text).toContain('matching qualified runtime catalog profile');
    expect(text).toContain('Project-test completion remains `self_reported`');
    expect(text).toContain('target code shares that process and can forge reporter output or terminate the runner');
    expect(text).toContain('The `tested` state remains reserved until a target-independent completion witness exists');
    expect(text).toContain('show assertion, test-completion, and review assurance exactly as recorded');
    expect(domain()).toContain('matching qualified scanner catalog profile');
  });

  test('sensitive helper control files stay out of the audited working tree', () => {
    const text = controller();
    for (const proof of ['Private control files', 'umask 077', 'mode-`0700`', 'mode-`0600`', 'outside the audited repository', 'remove each control file immediately']) expect(text).toContain(proof);
    for (const proof of ['Audited-source access invariant', "only with that run's `inspect`, `read`, and `history`", 'exact `path` from `inspect`', '`displayPath` is only a redacted label', 'Never use host `Read`/`Glob`/`Grep`', 'direct reads bypass']) expect(text).toContain(proof);
    for (const proof of ["copy every record's `domain` and `scope` exactly", 'a new scope leaves the planned scope unassessed', 'Only helper commands may update helper-owned records']) expect(text).toContain(proof);
  });

  test('supported findings are persisted and surfaced before the final report', () => {
    const text = controller();
    expect(text).toContain('Invoke `start` exactly once');
    expect(text).toContain('never call `start` again');
    expect(text).toContain('same ID');
    expect(text).toContain('submit it to the helper **and surface it to the user immediately**');
    expect(text).toContain('do not wait for the final report');
    expect(text).toContain('if the run is interrupted');
  });

  test('empty, partial, redaction failure, persistence failure and expiry stay truthful', () => {
    const text = controller();
    for (const contract of ['**complete**, **partial**, or **not assessed**', 'No supported findings in the assessed scope.', 'PERSISTENCE_FAILED', 'MISSING_INPUT', 'withhold the payload entirely', 'one bounded correction attempt', 'seven days', 'thirty days']) {
      expect(text).toContain(contract);
    }
    expect(text).toContain('Completeness is independent of finding count');
    expect(text).toContain('outside synchronization allowlists');
  });

  test('obsolete blanket exclusions and certainty scores are absent', () => {
    const text = controller() + domain();
    for (const obsolete of ['8/10 confidence gate', '2/10 confidence gate', 'devDependency CVEs are MEDIUM max', "gstack's own skills are trusted", 'User content in the user-message position of an AI conversation is NOT prompt injection', 'pull_request_target` without PR ref checkout is safe', 'Hard exclusions — automatically discard']) {
      expect(text).not.toContain(obsolete);
    }
    expect(text).toContain('Unknown reachability remains');
    expect(text).toContain('sequential challenge; independent agent unavailable');
  });

  test('controller stays compact without moving proof policy behind a section read', () => {
    expect(Buffer.byteLength(template())).toBeLessThan(18_000);
    expect(Buffer.byteLength(controller())).toBeLessThan(20_000);
    expect(Buffer.byteLength(controller() + domain())).toBeLessThan(36_000);
    const frontmatter = controller().match(/^---\n([\s\S]*?)\n---/)![1];
    const description = frontmatter.match(/^description:\s+(.+)$/m)![1].trim();
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description).toContain('(gstack)');
    expect(controller()).toContain('## When to invoke this skill');
  });
});
