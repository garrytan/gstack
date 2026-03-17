import { useEffect, useState } from 'react';
import Card from '@/components/Card';
import HealthScoreRing from '@/components/HealthScoreRing';
import Spinner from '@/components/Spinner';
import type { QAReport } from '@/api/client';
import { getQAReports } from '@/api/client';

export default function QAReports() {
  const [reports, setReports] = useState<QAReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getQAReports()
      .then(setReports)
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
        <h2 className="text-2xl font-bold text-white">QA Reports</h2>
        <p className="text-sm text-gstack-muted mt-1">
          Quality assurance test results and health scores
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-gstack-danger/30 bg-gstack-danger-bg p-4 text-gstack-danger text-sm mb-6">
          {error}
        </div>
      )}

      {reports.length === 0 ? (
        <Card>
          <div className="text-center py-12 text-gstack-dim">
            <p className="text-lg mb-2">No QA reports yet</p>
            <p className="text-sm">
              Run <code className="font-mono bg-gstack-border px-1.5 py-0.5 rounded">/qa</code> in
              Claude Code to generate reports
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {reports.map((report) => (
            <Card key={report.file}>
              <div className="flex items-center gap-6">
                <HealthScoreRing score={report.healthScore} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-white truncate">
                      {report.url}
                    </h3>
                    <span className="text-xs px-2 py-0.5 rounded bg-gstack-border text-gstack-muted">
                      {report.tier}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gstack-dim">
                    <span>{report.date}</span>
                    <span className="font-mono">{report.branch}</span>
                    <span>{report.duration}</span>
                    {report.framework !== 'Unknown' && <span>{report.framework}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-6 text-center">
                  <div>
                    <div className="text-lg font-bold text-white">{report.issueCount}</div>
                    <div className="text-xs text-gstack-muted">Issues</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-white">{report.pagesVisited}</div>
                    <div className="text-xs text-gstack-muted">Pages</div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
