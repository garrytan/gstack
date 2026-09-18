import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OFFICE_HOURS_DIMENSIONS, assessOfficeHoursReviews, validateOfficeHoursReview,
  renderOfficeHoursReview, renderOfficeHoursReviewerPrompt, extractOfficeHoursReviewBlock, replaceOfficeHoursReviewBlock,
  type OfficeHoursReview,
} from '../lib/office-hours-review';

const cli = path.resolve(import.meta.dir, '../bin/gstack-office-hours-review');
function review(round = 1, count = 1): OfficeHoursReview {
  return {
    version: 1, round, document: '/tmp/design.md', quality_score: 7,
    dimensions: { completeness: count ? 'ISSUES' : 'PASS', consistency: 'PASS', clarity: 'PASS', scope: 'PASS', feasibility: 'PASS' },
    findings: Array.from({ length: count }, (_, index) => ({
      id: `R${round}-${index + 1}`, dimension: 'completeness',
      problem: `Problem ${index + 1} remains undefined.`, remedy: `Define behavior ${index + 1}.`,
    })), prior: [],
  };
}
function recurrence(): OfficeHoursReview[] {
  const first = review(1, 2), second = review(2);
  second.prior = [
    { id: 'R1-1', status: 'persisting', evidence: 'The revised design still omits the same cancellation behavior.', current_id: 'R2-1' },
    { id: 'R1-2', status: 'resolved', evidence: 'The Output section now defines the required roster columns.', current_id: null },
  ];
  return [first, second];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('office-hours canonical review schema', () => {
  test('all five dimensions are explicit; PASS depends on findings, not a perfect score', () => {
    const clean = review(1, 0);
    expect(Object.keys(validateOfficeHoursReview(clean).dimensions)).toEqual([...OFFICE_HOURS_DIMENSIONS]);
    expect(assessOfficeHoursReviews([clean]).stop).toBe('PASS');
    const imperfect = review();
    imperfect.quality_score = 10;
    expect(assessOfficeHoursReviews([imperfect]).stop).toBe('CONTINUE');
  });

  test.each([
    ['version', (item: any) => { item.version = 2; }],
    ['unexpected fields', (item: any) => { item.summary = 'PASS'; }],
    ['missing dimension', (item: any) => { delete item.dimensions.scope; }],
    ['false dimension pass', (item: any) => { item.dimensions.completeness = 'PASS'; }],
    ['empty dimension issues', (item: any) => { item.dimensions.clarity = 'ISSUES'; }],
    ['unknown dimension', (item: any) => { item.findings[0].dimension = 'performance'; }],
    ['wrong round id', (item: any) => { item.findings[0].id = 'R2-1'; }],
    ['duplicate id', (item: any) => { item.findings.push(clone(item.findings[0])); }],
    ['blank problem', (item: any) => { item.findings[0].problem = ' '; }],
    ['missing remedy', (item: any) => { delete item.findings[0].remedy; }],
    ['blank document', (item: any) => { item.document = ''; }],
    ['relative document', (item: any) => { item.document = 'design.md'; }],
    ['invalid score', (item: any) => { item.quality_score = 11; }],
    ['string score', (item: any) => { item.quality_score = '7'; }],
    ['missing first round', (item: any) => { item.round = 2; }],
    ['fabricated prior', (item: any) => { item.prior = [{ id: 'R0-1', status: 'resolved', evidence: 'claimed', current_id: null }]; }],
  ])('rejects %s', (_name, change) => {
    const value = clone(review());
    change(value);
    expect(() => validateOfficeHoursReview(value)).toThrow('Office-hours review:');
  });

  test.each([
    ['omitted prior finding', (item: any) => { item.prior.pop(); }],
    ['duplicate prior reference', (item: any) => { item.prior[1] = clone(item.prior[0]); }],
    ['unknown prior reference', (item: any) => { item.prior[0].id = 'R1-99'; }],
    ['missing persistence reference', (item: any) => { item.prior[0].current_id = null; }],
    ['orphaned unverified finding', (item: any) => { item.prior[0].status = 'unverified'; item.prior[0].current_id = null; }],
    ['unknown current finding', (item: any) => { item.prior[0].current_id = 'R2-99'; }],
    ['resolved with current reference', (item: any) => { item.prior[1].current_id = 'R2-1'; }],
    ['blank resolution evidence', (item: any) => { item.prior[1].evidence = ''; }],
    ['different document', (item: any) => { item.document = '/tmp/other.md'; }],
    ['merged unresolved prior obligations', (item: any) => { item.prior[1].status = 'unverified'; item.prior[1].current_id = 'R2-1'; }],
  ])('rejects %s', (_name, change) => {
    const [first, second] = recurrence();
    change(second);
    expect(() => assessOfficeHoursReviews([first, second])).toThrow('Office-hours review:');
  });
});

describe('office-hours prepared reviewer input', () => {
  function preceding(prompt: string): unknown {
    const section = prompt.slice(prompt.indexOf('## Complete preceding verdict'));
    return JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)![1]);
  }
  test('preserves the entire preceding verdict, including detailed remedies and prior-status evidence', () => {
    const rounds = recurrence();
    rounds[1].prior[0].status = 'unverified';
    rounds[1].findings[0].problem = 'A cancellation mid-merge leaves the chosen roster unspecified.\nDo not silently reuse an earlier event.';
    rounds[1].findings[0].remedy = 'Define the cancellation destination and whether provisional rows are discarded. Keep the prior committed roster unchanged until confirmation.';
    const previous = assessOfficeHoursReviews(rounds).rounds.at(-1)!;
    const prompt = renderOfficeHoursReviewerPrompt({ document: previous.document, verdictPath: '/tmp/reviews/round-3.json', previous });
    expect(preceding(prompt)).toEqual(previous);
    expect(prompt).toContain('"round": 3');
    expect(prompt).toContain('"/tmp/reviews/round-3.json"');
    expect(prompt).toContain('\nDocument: /tmp/design.md\nVerdict: /tmp/reviews/round-3.json\n');
    for (const dimension of OFFICE_HOURS_DIMENSIONS) expect(prompt.toLowerCase()).toContain(`**${dimension}**`);
    expect(prompt).toContain("'The Assignment'");
    expect(prompt).toContain('Absence from the new findings list is not confirmation.');
  });
  test('first review has explicit absent prior evidence; terminal outcomes cannot prepare another review', () => {
    const options = { document: '/tmp/design.md', verdictPath: '/tmp/reviews/round-1.json' };
    expect(preceding(renderOfficeHoursReviewerPrompt(options))).toBe(null);
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, previous: review(1, 0) })).toThrow('terminal');
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, previous: recurrence()[1] })).toThrow('terminal');
    const max = review(3);
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, previous: max })).toThrow('terminal');
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, document: 'design.md' })).toThrow('absolute');
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, verdictPath: '/tmp/review\nother.json' })).toThrow('one line');
    expect(() => renderOfficeHoursReviewerPrompt({ ...options, previous: { ...review(), document: '/tmp/other.md' } })).toThrow('different document');
  });
});

describe('office-hours lifecycle and deterministic preservation', () => {
  test('convergence precedes further editing even when another finding is new', () => {
    const rounds = recurrence();
    rounds[1].findings.push({ id: 'R2-2', dimension: 'clarity', problem: 'Encoding fallback has no user-visible policy.', remedy: 'Specify whether the latin-1 fallback emits a warning or is intentionally silent.' });
    rounds[1].dimensions.clarity = 'ISSUES';
    const result = renderOfficeHoursReview(rounds);
    expect(result.stop).toBe('CONVERGENCE');
    expect(result.metrics).toEqual({ iterations: 2, issues_found: 4, issues_fixed: 1, remaining: 2, quality_score: 7, attempted_fix_rounds: 1 });
    for (const output of [result.concerns, result.report]) {
      for (const finding of rounds[1].findings) {
        expect(output).toContain(finding.problem);
        expect(output).toContain(finding.remedy);
      }
      expect(output).toContain('Disposition: CONCERNS_RECORDED');
    }
    expect(result.report).toContain('recurrences count again');
    expect(() => assessOfficeHoursReviews([...rounds, review(3)])).toThrow('terminal');
  });

  test('unverified stays unresolved without triggering convergence; round 3 still stops', () => {
    const rounds = recurrence();
    rounds[1].prior[0].status = 'unverified';
    expect(assessOfficeHoursReviews(rounds).stop).toBe('CONTINUE');
    const third = review(3);
    third.prior = [{ id: 'R2-1', status: 'unverified', evidence: 'Still cannot establish a behavior from the updated document.', current_id: 'R3-1' }];
    expect(renderOfficeHoursReview([...rounds, third]).stop).toBe('MAX_ITERATIONS');
    expect(() => assessOfficeHoursReviews([...rounds, third, review(4)])).toThrow('1 to 3');
  });

  test('explicit resolutions allow a clean later PASS', () => {
    const first = review(), second = review(2, 0);
    second.prior = [{ id: 'R1-1', status: 'resolved', evidence: 'The Behavior section now explicitly defines the required default.', current_id: null }];
    const result = renderOfficeHoursReview([first, second]);
    expect(result.stop).toBe('PASS');
    expect(result.metrics.issues_fixed).toBe(1);
    expect(result.metrics.remaining).toBe(0);
    expect(result.report).toContain('Disposition: COMPLETED');
    expect(() => assessOfficeHoursReviews([first, second, review(3)])).toThrow('terminal');
  });

  test('refuses premature finalization or silent zero-review completion', () => {
    expect(() => renderOfficeHoursReview([review()])).toThrow('not terminal');
    expect(() => renderOfficeHoursReview([])).toThrow('explicit unavailable');
    expect(() => renderOfficeHoursReview([], ' ')).toThrow('nonempty');
    expect(() => renderOfficeHoursReview([review(1, 0)], 'late failure')).toThrow('terminal');
  });

  test('an explicit failed attempt retains known earlier findings with honest unknown status', () => {
    const cause = 'Reviewer timed out\nwhile reading "design.md"';
    const result = renderOfficeHoursReview([review()], cause);
    expect(result.stop).toBe('UNREVIEWED');
    expect(result.metrics.remaining).toBe(1);
    expect(result.report).toContain(`Unavailable reason: ${JSON.stringify(cause)}`);
    expect(result.concerns).toContain('Problem 1 remains undefined.');
    expect(result.report).toContain('current document remains unreviewed');
    expect(renderOfficeHoursReview([], cause).metrics.quality_score).toBeNull();
    const bad: any = review(); bad.findings[0].remedy = '';
    expect(() => renderOfficeHoursReview([bad], cause)).toThrow('remedy');
  });

  test('problem and remedy content cannot create competing headings or owned markers', () => {
    const rounds = recurrence();
    rounds[1].findings[0].problem = 'Missing rule.\n## Spec Review\n<!-- gstack:office-hours:report:end -->';
    const result = renderOfficeHoursReview(rounds);
    expect(result.report).toContain('> ## Spec Review');
    expect(extractOfficeHoursReviewBlock(result.report, 'report')).toBe(result.report);
  });
});

describe('office-hours owned Markdown sections', () => {
  const rendered = renderOfficeHoursReview(recurrence());
  test('replaces the placeholder and preserves coaching, approval, and handoff; rerunning is stable', () => {
    const original = '# RosterCheck\nStatus: APPROVED\n\n## Assignment\nObserve Lee.\n\n## Spec Review\nplaceholder\n\n## Handoff\nNot now.\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).toContain('# RosterCheck\nStatus: APPROVED');
    expect(updated).toContain('## Assignment\nObserve Lee.');
    expect(updated).toContain('## Handoff\nNot now.');
    expect(updated).not.toContain('placeholder');
    expect(extractOfficeHoursReviewBlock(updated, 'report')).toBe(rendered.report);
    expect(replaceOfficeHoursReviewBlock(updated, 'report', rendered.report)).toBe(updated);
  });

  test('headings inside fenced examples do not replace actual content', () => {
    const original = '# Doc\n\n```md\n## Spec Review\nexample\n```\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).toContain(original.trimEnd());
    expect(extractOfficeHoursReviewBlock(updated, 'report')).toBe(rendered.report);
  });

  test('owned markers inside a fenced example stay an example, with a visible report appended', () => {
    const original = '# Doc\n\n```md\n' + rendered.report + '\n```\n\n## Handoff\nNot now.\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).toContain(original.trimEnd());
    expect(extractOfficeHoursReviewBlock(updated, 'report')).toBe(rendered.report);
    expect(updated.slice(original.length)).toContain('## Spec Review');
  });

  test('rejects open fences and owned markers enclosing another section', () => {
    expect(() => replaceOfficeHoursReviewBlock('# Doc\n```md\nexample', 'report', rendered.report)).toThrow('unterminated');
    const crossSection = rendered.report.replace('<!-- gstack:office-hours:report:end -->', '## Handoff\nNot now.\n<!-- gstack:office-hours:report:end -->');
    expect(() => replaceOfficeHoursReviewBlock(crossSection, 'report', rendered.report)).toThrow('cross another section');
    expect(() => extractOfficeHoursReviewBlock(crossSection, 'report')).toThrow('cross another section');
  });

  test.each(['**Handoff**\nNot now.', '**Assignment:** Observe Lee.', '**Assignment**: Observe Lee.', '**What I noticed about how you think**\nYou checked the evidence.'])('preserves the closing boundary %s', closing => {
    const original = '# Report\n\n## Spec Review\nplaceholder\n\n' + closing + '\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).toContain(closing);
    expect(extractOfficeHoursReviewBlock(updated, 'report')).toBe(rendered.report);
    const crossed = rendered.report.replace('<!-- gstack:office-hours:report:end -->', closing + '\n<!-- gstack:office-hours:report:end -->');
    expect(() => replaceOfficeHoursReviewBlock(crossed, 'report', rendered.report)).toThrow('cross another section');
  });

  test.each(['Handoff — the relationship closing', 'Handoff - the relationship closing'])('preserves the supported combined closing %s', label => {
    const closing = `**${label}:**\nNext: /plan-ceo-review. The user declined launching it now.\n\n### Follow-up\nPreserve this saved closing.`;
    const original = '# Report\n\n## Spec Review\nplaceholder\n\n' + closing + '\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).toContain(closing);
    expect(updated).not.toContain('placeholder');
    expect(extractOfficeHoursReviewBlock(updated, 'report')).toBe(rendered.report);
    expect(replaceOfficeHoursReviewBlock(updated, 'report', rendered.report)).toBe(updated);
    const crossed = rendered.report.replace('<!-- gstack:office-hours:report:end -->', closing + '\n<!-- gstack:office-hours:report:end -->');
    expect(() => replaceOfficeHoursReviewBlock(crossed, 'report', rendered.report)).toThrow('cross another section');
    expect(() => extractOfficeHoursReviewBlock(crossed, 'report')).toThrow('cross another section');
  });

  test.each([
    '**Handoff — an unresolved review question**',
    '**Handoff-ish — the relationship closing**',
    '> **Handoff — the relationship closing**',
    '```markdown\n**Handoff — the relationship closing**\n```',
  ])('keeps non-closing or quoted emphasis inside the review: %s', reviewText => {
    const original = '# Report\n\n## Spec Review\n' + reviewText + '\n\n## Handoff\nNot now.\n';
    const updated = replaceOfficeHoursReviewBlock(original, 'report', rendered.report);
    expect(updated).not.toContain(reviewText);
    expect(updated).toContain('## Handoff\nNot now.');
    const owned = rendered.report.replace('<!-- gstack:office-hours:report:end -->', reviewText + '\n<!-- gstack:office-hours:report:end -->');
    expect(extractOfficeHoursReviewBlock(owned, 'report')).toBe(owned);
  });

  test.each([
    '<!-- gstack:office-hours:report:start -->',
    '<!-- gstack:office-hours:report:end -->',
    rendered.report + '\n' + rendered.report,
  ])('rejects ambiguous or partial managed output', content => {
    expect(() => replaceOfficeHoursReviewBlock(content, 'report', rendered.report)).toThrow('markers');
  });
  test('rejects duplicate legacy report sections', () => {
    expect(() => replaceOfficeHoursReviewBlock('## Spec Review\na\n## Spec Review\nb', 'report', rendered.report)).toThrow('duplicate');
    expect(() => replaceOfficeHoursReviewBlock('## Spec Review\nlegacy\n' + rendered.report, 'report', rendered.report)).toThrow('duplicate');
  });
});

describe('office-hours review CLI', () => {
  function fixture(run: (dir: string, invoke: (...args: string[]) => ReturnType<typeof Bun.spawnSync>) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-review-'));
    try {
      run(dir, (...args) => Bun.spawnSync([process.execPath, cli, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 5000 }));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  function files(dir: string) {
    const design = path.join(dir, 'design.md'), report = path.join(dir, 'REPORT.md');
    fs.writeFileSync(design, '# Design\nStatus: DRAFT\n\n## Assignment\nObserve a real event.\n');
    fs.writeFileSync(report, '# Report\n\n## Spec Review\nplaceholder\n\n## Handoff\nNot now.\n');
    const rounds = recurrence();
    const artifacts = rounds.map(item => {
      item.document = design;
      const file = path.join(dir, `round-${item.round}.json`);
      fs.writeFileSync(file, JSON.stringify(item));
      return file;
    });
    return { design, report, artifacts, rounds };
  }
  test('prepare assigns rounds and writes the complete canonical prompt without rewriting input evidence', () => fixture((dir, invoke) => {
    const data = files(dir), outDir = path.join(dir, 'reviews');
    fs.mkdirSync(outDir);
    const before = fs.readFileSync(data.design, 'utf8');
    const first = invoke('prepare', '--design', data.design, '--out-dir', outDir);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const prepared = JSON.parse(first.stdout.toString());
    expect(prepared.round).toBe(1);
    expect(prepared.verdictPath).toBe(path.join(outDir, 'round-1.json'));
    expect(fs.existsSync(prepared.verdictPath)).toBe(false);
    for (const name of [prepared.promptPath, data.design, prepared.verdictPath]) expect(prepared.dispatch).toContain(name);
    expect(prepared.dispatch).toContain(`\nDocument: ${data.design}\nPrompt: ${prepared.promptPath}\nVerdict: ${prepared.verdictPath}`);
    expect(fs.readFileSync(prepared.promptPath, 'utf8')).toBe(renderOfficeHoursReviewerPrompt({ document: data.design, verdictPath: prepared.verdictPath }));
    if (process.platform !== 'win32') expect(fs.statSync(prepared.promptPath).mode & 0o777).toBe(0o600);
    const mtime = fs.statSync(prepared.promptPath).mtimeMs;
    expect(invoke('prepare', '--design', data.design, '--out-dir', outDir).exitCode).toBe(0);
    expect(fs.statSync(prepared.promptPath).mtimeMs).toBe(mtime);
    fs.writeFileSync(prepared.verdictPath, JSON.stringify(data.rounds[0]));
    const saved = fs.readFileSync(prepared.verdictPath, 'utf8');
    const second = invoke('prepare', '--design', data.design, '--out-dir', outDir, prepared.verdictPath);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    const next = JSON.parse(second.stdout.toString());
    expect(next.round).toBe(2);
    expect(fs.readFileSync(next.promptPath, 'utf8')).toBe(renderOfficeHoursReviewerPrompt({ document: data.design, verdictPath: next.verdictPath, previous: data.rounds[0] }));
    expect(fs.readFileSync(prepared.verdictPath, 'utf8')).toBe(saved);
    expect(fs.readFileSync(data.design, 'utf8')).toBe(before);
  }));
  test('prepare refuses stale output, malformed or terminal history, and incomplete ordered history', () => fixture((dir, invoke) => {
    const data = files(dir), outDir = path.join(dir, 'reviews');
    fs.mkdirSync(outDir);
    const invokePrepare = (...rounds: string[]) => invoke('prepare', '--design', data.design, '--out-dir', outDir, ...rounds);
    fs.writeFileSync(path.join(outDir, 'round-1.prompt.md'), 'shortened prior summary');
    expect(invokePrepare().stderr.toString()).toContain('differs');
    expect(fs.readFileSync(path.join(outDir, 'round-1.prompt.md'), 'utf8')).toBe('shortened prior summary');
    fs.unlinkSync(path.join(outDir, 'round-1.prompt.md'));
    fs.writeFileSync(path.join(outDir, 'round-1.json'), '{}');
    expect(invokePrepare().stderr.toString()).toContain('already exists');
    expect(invokePrepare(...data.artifacts).stderr.toString()).toContain('terminal');
    expect(invokePrepare(data.artifacts[1]).exitCode).toBe(1);
    fs.writeFileSync(data.artifacts[0], '{bad');
    expect(invokePrepare(data.artifacts[0]).exitCode).toBe(1);
    expect(fs.readdirSync(outDir)).toEqual(['round-1.json']);
  }));
  test('prepare refuses missing destinations and overlap with the design or saved verdict', () => fixture((dir, invoke) => {
    const data = files(dir);
    expect(invoke('prepare', '--design', data.design).exitCode).toBe(1);
    expect(invoke('prepare', '--design', data.design, '--out-dir', path.join(dir, 'missing')).exitCode).toBe(1);
    expect(invoke('prepare', '--design', path.join(dir, 'missing.md'), '--out-dir', dir).exitCode).toBe(1);
    const design = path.join(dir, 'round-1.prompt.md');
    fs.writeFileSync(design, '# Actual design, not disposable prompt content.');
    expect(invoke('prepare', '--design', design, '--out-dir', dir).stderr.toString()).toContain('overlaps');
    expect(fs.readFileSync(design, 'utf8')).toBe('# Actual design, not disposable prompt content.');
    const aliasArtifact = path.join(dir, 'round-2.prompt.md');
    const saved = JSON.stringify(data.rounds[0]);
    fs.writeFileSync(aliasArtifact, saved);
    expect(invoke('prepare', '--design', data.design, '--out-dir', dir, aliasArtifact).stderr.toString()).toContain('overlaps');
    expect(fs.readFileSync(aliasArtifact, 'utf8')).toBe(saved);
  }));
  test('check is read-only; finalize renders both authoritative files from the same inventory', () => fixture((dir, invoke) => {
    const data = files(dir), before = fs.readFileSync(data.design, 'utf8');
    const check = invoke('check', ...data.artifacts);
    expect(check.exitCode, check.stderr.toString()).toBe(0);
    expect(JSON.parse(check.stdout.toString()).stop).toBe('CONVERGENCE');
    expect(fs.readFileSync(data.design, 'utf8')).toBe(before);
    const finalized = invoke('finalize', '--design', data.design, '--report', data.report, ...data.artifacts);
    expect(finalized.exitCode, finalized.stderr.toString()).toBe(0);
    const expected = renderOfficeHoursReview(data.rounds);
    expect(extractOfficeHoursReviewBlock(fs.readFileSync(data.design, 'utf8'), 'concerns')).toBe(expected.concerns);
    expect(extractOfficeHoursReviewBlock(fs.readFileSync(data.report, 'utf8'), 'report')).toBe(expected.report);
    expect(fs.readFileSync(data.report, 'utf8')).toContain('## Handoff\nNot now.');
    expect(JSON.parse(finalized.stdout.toString()).report).toBe(expected.report);
    const beforeRepeat = [fs.statSync(data.design).mtimeMs, fs.statSync(data.report).mtimeMs];
    expect(invoke('finalize', '--design', data.design, '--report', data.report, ...data.artifacts).exitCode).toBe(0);
    expect([fs.statSync(data.design).mtimeMs, fs.statSync(data.report).mtimeMs]).toEqual(beforeRepeat);
  }));
  test('invalid artifact cannot be ignored by --unreviewed and no destination changes', () => fixture((dir, invoke) => {
    const data = files(dir), before = fs.readFileSync(data.design, 'utf8');
    fs.writeFileSync(data.artifacts[1], '{bad');
    const result = invoke('finalize', '--design', data.design, '--unreviewed', 'timeout', ...data.artifacts);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(data.artifacts[1]);
    expect(fs.readFileSync(data.design, 'utf8')).toBe(before);
  }));
  test('wrong document, malformed report markers, and missing artifacts fail before publication', () => fixture((dir, invoke) => {
    const data = files(dir), before = fs.readFileSync(data.design, 'utf8');
    const wrong = invoke('finalize', '--design', path.join(dir, 'other.md'), ...data.artifacts);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr.toString()).toContain('does not match');
    fs.writeFileSync(data.report, '<!-- gstack:office-hours:report:start -->');
    expect(invoke('finalize', '--design', data.design, '--report', data.report, ...data.artifacts).exitCode).toBe(1);
    expect(fs.readFileSync(data.design, 'utf8')).toBe(before);
    expect(invoke('check', path.join(dir, 'missing.json')).exitCode).toBe(1);
    const missingReport = invoke('finalize', '--design', data.design, '--report', path.join(dir, 'missing-report.md'), ...data.artifacts);
    expect(missingReport.exitCode).toBe(1);
    expect(missingReport.stderr.toString()).toContain('missing-report.md');
    expect(fs.readFileSync(data.design, 'utf8')).toBe(before);
  }));
  test('explicit unavailable review can finalize without pretending a review ran', () => fixture((dir, invoke) => {
    const data = files(dir);
    const result = invoke('finalize', '--design', data.design, '--report', data.report, '--unreviewed', 'Agent tool unavailable');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const outcome = JSON.parse(result.stdout.toString());
    expect(outcome.stop).toBe('UNREVIEWED');
    expect(outcome.metrics.iterations).toBe(0);
    expect(fs.readFileSync(data.report, 'utf8')).toContain('Unavailable reason: "Agent tool unavailable"');
  }));
  test('finalization cannot overwrite its input evidence, including a symlink alias', () => fixture((dir, invoke) => {
    const data = files(dir), before = fs.readFileSync(data.artifacts[0], 'utf8');
    const direct = invoke('finalize', '--design', data.design, '--report', data.artifacts[0], ...data.artifacts);
    expect(direct.exitCode).toBe(1);
    expect(direct.stderr.toString()).toContain('overlaps');
    expect(fs.readFileSync(data.artifacts[0], 'utf8')).toBe(before);
    if (process.platform !== 'win32') {
      const alias = path.join(dir, 'alias.md');
      fs.symlinkSync(data.artifacts[0], alias);
      expect(invoke('finalize', '--design', data.design, '--report', alias, ...data.artifacts).exitCode).toBe(1);
      expect(fs.readFileSync(data.artifacts[0], 'utf8')).toBe(before);
    }
  }));
});
