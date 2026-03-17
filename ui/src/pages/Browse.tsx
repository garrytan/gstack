import { useEffect, useState, useCallback } from 'react';
import Card from '@/components/Card';
import StatusBadge from '@/components/StatusBadge';
import Spinner from '@/components/Spinner';
import type { BrowseServerStatus } from '@/api/client';
import { getBrowseStatus, sendBrowseCommand } from '@/api/client';

export default function Browse() {
  const [status, setStatus] = useState<BrowseServerStatus | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);

  const refreshStatus = useCallback(() => {
    getBrowseStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleExecute = async () => {
    if (!command.trim() || executing) return;
    setExecuting(true);
    setError(null);

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);

    try {
      const result = await sendBrowseCommand(cmd, args);
      setOutput((prev) => [
        ...prev,
        `> ${command}`,
        result,
        '',
      ]);
      setCommand('');
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutput((prev) => [...prev, `> ${command}`, `ERROR: ${msg}`, '']);
    } finally {
      setExecuting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-8 h-8" />
      </div>
    );
  }

  const isRunning = status?.health?.status === 'healthy';

  return (
    <div className="p-8">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white">Browse</h2>
        <p className="text-sm text-gstack-muted mt-1">
          Headless browser control panel
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-gstack-danger/30 bg-gstack-danger-bg p-4 text-gstack-danger text-sm mb-6">
          {error}
        </div>
      )}

      {/* Server status */}
      <Card title="Server Status" className="mb-6">
        {status ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <StatusBadge
                status={isRunning ? 'running' : 'warning'}
                label={isRunning ? 'Running' : 'Unhealthy'}
              />
              <span className="text-sm text-gstack-dim font-mono">
                PID {status.pid} &middot; port {status.port}
              </span>
            </div>
            {status.health && (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gstack-muted">Uptime</span>
                  <p className="font-mono text-white">{formatUptime(status.health.uptime)}</p>
                </div>
                <div>
                  <span className="text-gstack-muted">Tabs</span>
                  <p className="font-mono text-white">{status.health.tabs}</p>
                </div>
                <div>
                  <span className="text-gstack-muted">Current URL</span>
                  <p className="font-mono text-gstack-info truncate">{status.health.currentUrl}</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <StatusBadge status="stopped" label="Not running" />
            <span className="text-sm text-gstack-dim">
              Browse server is not running. Start it by running a browse command.
            </span>
          </div>
        )}
      </Card>

      {/* Command panel */}
      <Card title="Command Console" className="mb-6">
        <div className="space-y-4">
          {/* Output area */}
          <div className="h-80 overflow-y-auto rounded border border-gstack-border bg-gstack-bg p-3 font-mono text-xs leading-relaxed">
            {output.length === 0 ? (
              <div className="text-gstack-dim">
                Enter a browse command below. Examples:
                <br />
                <span className="text-gstack-accent">goto</span> https://example.com
                <br />
                <span className="text-gstack-accent">snapshot</span> -i
                <br />
                <span className="text-gstack-accent">screenshot</span> /tmp/shot.png
                <br />
                <span className="text-gstack-accent">text</span>
                <br />
                <span className="text-gstack-accent">console</span> --errors
                <br />
                <span className="text-gstack-accent">help</span>
              </div>
            ) : (
              output.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith('> ')
                      ? 'text-gstack-accent'
                      : line.startsWith('ERROR:')
                        ? 'text-gstack-danger'
                        : 'text-gstack-text whitespace-pre-wrap'
                  }
                >
                  {line}
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gstack-accent font-mono text-sm">
                $B
              </span>
              <input
                type="text"
                className="w-full pl-10 pr-3 py-2 rounded-lg border border-gstack-border bg-gstack-bg text-gstack-text font-mono text-sm outline-none focus:border-gstack-accent/50 transition-colors"
                placeholder="goto https://example.com"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleExecute();
                }}
                disabled={!isRunning || executing}
              />
            </div>
            <button
              className="px-4 py-2 rounded-lg bg-gstack-accent text-black font-medium text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gstack-accent/90 transition-colors"
              onClick={handleExecute}
              disabled={!isRunning || executing || !command.trim()}
            >
              {executing ? <Spinner className="w-4 h-4 border-black border-t-transparent" /> : 'Run'}
            </button>
          </div>
          {!isRunning && (
            <p className="text-xs text-gstack-dim">
              Start the browse server first to run commands.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
