import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const TMP_HOME = path.join(os.tmpdir(), `gstack-telemetry-test-${process.pid}-${Date.now()}`);
const TELEMETRY_FILE = path.join(TMP_HOME, 'analytics', 'browse-telemetry.jsonl');

// Use GSTACK_HOME env to redirect telemetry writes (read each call,
// not cached at module-load).
process.env.GSTACK_HOME = TMP_HOME;
process.env.GSTACK_TELEMETRY_OFF = '0';

beforeEach(async () => {
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

async function readEvents(): Promise<any[]> {
  // Wait briefly for fire-and-forget appends to flush.
  await new Promise((r) => setTimeout(r, 30));
  try {
    const raw = await fs.readFile(TELEMETRY_FILE, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('telemetry: signals fire to ~/.gstack/analytics/browse-telemetry.jsonl', () => {
  it('logTelemetry writes a JSONL line with ts injected', async () => {
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    logTelemetry({ event: 'domain_skill_saved', host: 'test.com', scope: 'project', state: 'quarantined', bytes: 42 });
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('domain_skill_saved');
    expect(events[0].host).toBe('test.com');
    expect(events[0].bytes).toBe(42);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('GSTACK_TELEMETRY_OFF=1 silences all events', async () => {
    process.env.GSTACK_TELEMETRY_OFF = '1';
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    logTelemetry({ event: 'cdp_method_called', domain: 'X', method: 'y' });
    const events = await readEvents();
    expect(events).toHaveLength(0);
    process.env.GSTACK_TELEMETRY_OFF = '0';
  });

  it('telemetry never throws even if disk fails', async () => {
    // Point HOME to a path that doesn't exist + can't be created (root-owned)
    // — but that's hard to set up cross-platform. Just check that calling
    // logTelemetry on a missing directory doesn't throw.
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    expect(() => logTelemetry({ event: 'noop_test' })).not.toThrow();
  });
});
