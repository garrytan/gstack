import { useEffect, useState } from 'react';
import Card from '@/components/Card';
import StatusBadge from '@/components/StatusBadge';
import Spinner from '@/components/Spinner';
import type { EvalRun, EvalSummary } from '@/api/client';
import { getEvalRuns, getEvalSummary } from '@/api/client';

export default function Evals() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getEvalRuns(), getEvalSummary()])
      .then(([r, s]) => {
        setRuns(r);
        setSummary(s);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-8 h-8" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white">Eval Results</h2>
        <p className="text-sm text-gstack-muted mt-1">
          E2E and LLM-as-judge evaluation runs
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-gstack-danger/30 bg-gstack-danger-bg p-4 text-gstack-danger text-sm mb-6">
          {error}
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Total Runs</div>
            <div className="text-2xl font-bold text-white">{summary.totalRuns}</div>
            <div className="text-xs text-gstack-dim mt-1">
              {summary.e2eRuns} E2E &middot; {summary.judgeRuns} Judge
            </div>
          </Card>
          <Card>
            <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Total Spend</div>
            <div className="text-2xl font-bold text-white">${summary.totalCost.toFixed(2)}</div>
            <div className="text-xs text-gstack-dim mt-1">
              avg E2E: ${summary.avgE2ECost.toFixed(2)}
            </div>
          </Card>
          <Card>
            <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Avg Duration</div>
            <div className="text-2xl font-bold text-white">
              {Math.round(summary.avgE2EDuration / 1000)}s
            </div>
          </Card>
          <Card>
            <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Avg Detection</div>
            <div className="text-2xl font-bold text-white">
              {summary.avgDetection !== null ? summary.avgDetection.toFixed(1) : 'N/A'}
            </div>
          </Card>
        </div>
      )}

      {/* Flaky tests */}
      {summary && summary.flakyTests.length > 0 && (
        <Card title={`Flaky Tests (${summary.flakyTests.length})`} className="mb-8">
          <div className="space-y-1">
            {summary.flakyTests.map((test) => (
              <div key={test} className="flex items-center gap-2 text-sm">
                <span className="text-gstack-warning">~</span>
                <span className="font-mono text-gstack-text">{test}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Runs list */}
      {runs.length === 0 ? (
        <Card>
          <div className="text-center py-12 text-gstack-dim">
            <p className="text-lg mb-2">No eval runs yet</p>
            <p className="text-sm">
              Run{' '}
              <code className="font-mono bg-gstack-border px-1.5 py-0.5 rounded">
                EVALS=1 bun run test:evals
              </code>{' '}
              to generate evaluation data
            </p>
          </div>
        </Card>
      ) : (
        <Card title={`Eval Runs (${runs.length})`}>
          <div className="divide-y divide-gstack-border">
            {runs.map((run) => (
              <div key={run.file}>
                <button
                  className="w-full flex items-center justify-between py-3 text-left hover:bg-white/5 transition-colors px-2 rounded"
                  onClick={() =>
                    setExpandedRun(expandedRun === run.file ? null : run.file)
                  }
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge
                      status={run.passed === run.total ? 'ok' : 'warning'}
                      label={`${run.passed}/${run.total}`}
                    />
                    <div>
                      <span className="text-sm font-mono text-white">
                        {run.timestamp.replace('T', ' ').slice(0, 16)}
                      </span>
                      <p className="text-xs text-gstack-dim">
                        {run.branch} &middot; {run.tier} &middot; v{run.version}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gstack-dim">
                    <span>${run.cost.toFixed(2)}</span>
                    {run.turns > 0 && <span>{run.turns}t</span>}
                    {run.duration > 0 && <span>{Math.round(run.duration / 1000)}s</span>}
                    <span className="text-gstack-muted">{expandedRun === run.file ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </button>
                {expandedRun === run.file && (
                  <div className="pb-3 px-2">
                    <div className="rounded border border-gstack-border bg-gstack-bg p-3 space-y-1">
                      {run.tests.map((test) => (
                        <div
                          key={test.name}
                          className="flex items-center justify-between text-xs py-1"
                        >
                          <div className="flex items-center gap-2">
                            <span className={test.passed ? 'text-gstack-accent' : 'text-gstack-danger'}>
                              {test.passed ? '\u2713' : '\u2717'}
                            </span>
                            <span className="font-mono text-gstack-text">{test.name}</span>
                          </div>
                          <div className="flex items-center gap-3 text-gstack-dim">
                            <span>${test.cost_usd.toFixed(2)}</span>
                            {test.turns_used !== undefined && <span>{test.turns_used}t</span>}
                            <span>{Math.round(test.duration_ms / 1000)}s</span>
                            {test.detection_rate !== undefined && (
                              <span>det: {test.detection_rate}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
