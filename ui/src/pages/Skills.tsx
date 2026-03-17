import { useEffect, useState } from 'react';
import Card from '@/components/Card';
import StatusBadge from '@/components/StatusBadge';
import Spinner from '@/components/Spinner';
import type { SkillSummary } from '@/api/client';
import { getSkills } from '@/api/client';

export default function Skills() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSkills()
      .then(setSkills)
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

  const okCount = skills.filter((s) => s.status === 'ok').length;
  const warnCount = skills.filter((s) => s.status === 'warning').length;
  const errCount = skills.filter((s) => s.status === 'error').length;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white">Skills</h2>
        <p className="text-sm text-gstack-muted mt-1">
          SKILL.md validation and health status
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-gstack-danger/30 bg-gstack-danger-bg p-4 text-gstack-danger text-sm mb-6">
          {error}
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <Card>
          <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Healthy</div>
          <div className="text-2xl font-bold text-gstack-accent">{okCount}</div>
        </Card>
        <Card>
          <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Warnings</div>
          <div className="text-2xl font-bold text-gstack-warning">{warnCount}</div>
        </Card>
        <Card>
          <div className="text-xs text-gstack-muted uppercase tracking-wide mb-1">Errors</div>
          <div className="text-2xl font-bold text-gstack-danger">{errCount}</div>
        </Card>
      </div>

      {/* Skills list */}
      <Card title={`All Skills (${skills.length})`}>
        <div className="divide-y divide-gstack-border">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-3">
                <StatusBadge status={skill.status} />
                <div>
                  <span className="text-sm font-medium text-white">/{skill.name}</span>
                  <p className="text-xs text-gstack-dim font-mono mt-0.5">{skill.path}</p>
                </div>
              </div>
              <div className="flex items-center gap-6 text-xs">
                <div className="text-right">
                  <span className="text-gstack-muted">Commands</span>
                  <p className="font-mono text-white">{skill.commandCount}</p>
                </div>
                {skill.invalidCount > 0 && (
                  <div className="text-right">
                    <span className="text-gstack-danger">Invalid</span>
                    <p className="font-mono text-gstack-danger">{skill.invalidCount}</p>
                  </div>
                )}
                <div className="text-right">
                  <span className="text-gstack-muted">Template</span>
                  <p className={skill.hasTemplate ? 'text-gstack-accent' : 'text-gstack-dim'}>
                    {skill.hasTemplate ? 'yes' : 'no'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
