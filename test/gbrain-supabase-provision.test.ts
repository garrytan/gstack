/**
 * gstack-gbrain-supabase-provision — Supabase Management API wrapper.
 *
 * All tests run against a per-test local mock HTTP server (Bun.serve)
 * that returns fixture responses. Never hits the real Supabase API, never
 * requires a live PAT.
 *
 * Covers the D21 HTTP error suite (401/403/402/409/429/5xx), the happy
 * path for each subcommand (list-orgs, create, wait, pooler-url), the
 * verified schema corrections (POST /v1/projects with organization_slug,
 * GET /config/database/pooler), PAT + DB_PASS env-var discipline, retry
 * + backoff on transient errors, pooler URL construction using the
 * generated DB_PASS (not the API response's templated connection_string).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-gbrain-supabase-provision');

// Minimal PATH that finds jq/curl but excludes user bins.
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

type Handler = (req: Request) => Response | Promise<Response>;

interface MockServer {
  url: string;
  close: () => void;
  requests: Array<{ method: string; path: string; body?: string }>;
}

function startMock(routes: Record<string, Handler>): MockServer {
  const requests: MockServer['requests'] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const key = `${req.method} ${u.pathname}`;
      // Log method+path only. Handlers that need the body read it themselves;
      // Response bodies can only be consumed once.
      requests.push({ method: req.method, path: u.pathname });
      const handler = routes[key] || routes[`${req.method} *`];
      if (!handler) {
        return new Response(
          JSON.stringify({ message: `no mock for ${key}` }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        );
      }
      return handler(req);
    },
  });
  const base = `http://localhost:${server.port}`;
  return {
    url: base,
    close: () => server.stop(true),
    requests,
  };
}

async function runBin(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; status: number }> {
  // Use Bun.spawn (async) rather than spawnSync. spawnSync blocks the Bun
  // event loop, which prevents Bun.serve mocks from responding — every
  // HTTP call would hit curl's timeout instead of round-tripping.
  const proc = Bun.spawn([BIN, ...args], {
    env: { PATH: SAFE_PATH, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), status };
}

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let mock: MockServer;

afterEach(() => {
  if (mock) mock.close();
});

describe('list-orgs', () => {
  test('happy path: returns orgs from GET /v1/organizations', async () => {
    mock = startMock({
      'GET /v1/organizations': () =>
        jsonResp([
          { id: 'deprec-1', slug: 'acme', name: 'Acme Inc' },
          { id: 'deprec-2', slug: 'personal', name: 'Personal' },
        ]),
    });
    const r = await runBin(['list-orgs', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test_pat',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.orgs).toEqual([
      { slug: 'acme', name: 'Acme Inc' },
      { slug: 'personal', name: 'Personal' },
    ]);
  });

  test('sends Authorization: Bearer <PAT> header', async () => {
    let authHeader = '';
    mock = startMock({
      'GET /v1/organizations': (req) => {
        authHeader = req.headers.get('authorization') || '';
        return jsonResp([]);
      },
    });
    await runBin(['list-orgs', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_expected_pat_xxx',
      SUPABASE_API_BASE: mock.url,
    });
    expect(authHeader).toBe('Bearer sbp_expected_pat_xxx');
  });

  test('exits 3 with auth error when SUPABASE_ACCESS_TOKEN is missing', async () => {
    const r = await runBin(['list-orgs']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('SUPABASE_ACCESS_TOKEN is not set');
  });

  test('exits 3 on 401 Unauthorized', async () => {
    mock = startMock({
      'GET /v1/organizations': () => jsonResp({ message: 'Invalid JWT' }, 401),
    });
    const r = await runBin(['list-orgs'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_bad',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('401 Unauthorized');
  });

  test('exits 3 on 403 Forbidden', async () => {
    mock = startMock({
      'GET /v1/organizations': () => jsonResp({ message: 'Forbidden' }, 403),
    });
    const r = await runBin(['list-orgs'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_noperm',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('403 Forbidden');
  });
});

describe('create', () => {
  test('happy path: POST /v1/projects with organization_slug, no `plan` field', async () => {
    let sentBody: any = null;
    mock = startMock({
      'POST /v1/projects': async (req) => {
        sentBody = JSON.parse(await req.text());
        return jsonResp({
          id: 'deprec',
          ref: 'abcdefghijklmnopqrst',
          organization_slug: 'acme',
          name: 'gbrain',
          region: 'us-east-1',
          created_at: '2026-04-23T00:00:00Z',
          status: 'COMING_UP',
        }, 201);
      },
    });
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'generated-secret-pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ref).toBe('abcdefghijklmnopqrst');
    expect(j.status).toBe('COMING_UP');
    // Verify the request body had the right shape
    expect(sentBody.name).toBe('gbrain');
    expect(sentBody.region).toBe('us-east-1');
    expect(sentBody.organization_slug).toBe('acme');
    expect(sentBody.db_pass).toBe('generated-secret-pw');
    // Critical: no `plan` field, since it's ignored server-side per OpenAPI
    expect(sentBody.plan).toBeUndefined();
  });

  test('passes desired_instance_size when --instance-size flag is used', async () => {
    let sentBody: any = null;
    mock = startMock({
      'POST /v1/projects': async (req) => {
        sentBody = JSON.parse(await req.text());
        return jsonResp({ ref: 'r', status: 'COMING_UP' }, 201);
      },
    });
    await runBin(['create', 'gbrain', 'us-east-1', 'acme', '--instance-size', 'small', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(sentBody.desired_instance_size).toBe('small');
  });

  test('exits 4 on 402 Payment Required (quota)', async () => {
    mock = startMock({
      'POST /v1/projects': () => jsonResp({ message: 'project limit reached' }, 402),
    });
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('402 Payment Required');
    expect(r.stderr).toContain('quota exceeded');
  });

  test('exits 5 on 409 Conflict (duplicate name)', async () => {
    mock = startMock({
      'POST /v1/projects': () => jsonResp({ message: 'conflict' }, 409),
    });
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('409 Conflict');
    expect(r.stderr).toContain('duplicate project name');
  });

  test('fails when DB_PASS is missing', async () => {
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DB_PASS env var is required');
  });

  test('missing positional args rejected with exit 2', async () => {
    const r = await runBin(['create', 'gbrain'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing');
  });

  test('retries on 429 rate limit with backoff and eventually succeeds', async () => {
    let count = 0;
    mock = startMock({
      'POST /v1/projects': () => {
        count += 1;
        if (count < 2) return jsonResp({ message: 'too many requests' }, 429);
        return jsonResp({ ref: 'r', status: 'COMING_UP' }, 201);
      },
    });
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    expect(count).toBe(2);
  }, 15000);

  test('exits 8 on persistent 5xx after max retries', async () => {
    let count = 0;
    mock = startMock({
      'POST /v1/projects': () => {
        count += 1;
        return jsonResp({ message: 'internal server error' }, 502);
      },
    });
    const r = await runBin(['create', 'gbrain', 'us-east-1', 'acme'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(8);
    expect(r.stderr).toContain('502');
    expect(count).toBeGreaterThanOrEqual(3);
  }, 30000);
});

describe('wait', () => {
  test('happy path: polls until ACTIVE_HEALTHY', async () => {
    let count = 0;
    mock = startMock({
      'GET /v1/projects/abc': () => {
        count += 1;
        if (count < 2) return jsonResp({ ref: 'abc', status: 'COMING_UP' });
        return jsonResp({ ref: 'abc', status: 'ACTIVE_HEALTHY' });
      },
    });
    const r = await runBin(['wait', 'abc', '--timeout', '30', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.status).toBe('ACTIVE_HEALTHY');
    expect(j.ref).toBe('abc');
  }, 30000);

  test('exits 7 on terminal INIT_FAILED state', async () => {
    mock = startMock({
      'GET /v1/projects/abc': () => jsonResp({ ref: 'abc', status: 'INIT_FAILED' }),
    });
    const r = await runBin(['wait', 'abc', '--timeout', '10'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('INIT_FAILED');
  });

  test('exits 6 on timeout with resume-provision hint', async () => {
    // Stay in COMING_UP forever.
    mock = startMock({
      'GET /v1/projects/abc': () => jsonResp({ ref: 'abc', status: 'COMING_UP' }),
    });
    const r = await runBin(['wait', 'abc', '--timeout', '0'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(6);
    expect(r.stderr).toContain('wait timed out');
    expect(r.stderr).toContain('--resume-provision abc');
  }, 15000);
});

describe('pooler-url', () => {
  const REF = 'abcdefghijklmnopqrst';
  const POOLER_OK = {
    db_user: `postgres.${REF}`,
    db_host: 'aws-0-us-east-1.pooler.supabase.com',
    db_port: 6543,
    db_name: 'postgres',
    pool_mode: 'session',
    connection_string:
      'postgresql://postgres.abcdefghijklmnopqrst:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
  };

  test('constructs URL from db_user/host/port/name + DB_PASS (not response connection_string)', async () => {
    mock = startMock({
      [`GET /v1/projects/${REF}/config/database/pooler`]: () => jsonResp(POOLER_OK),
    });
    const r = await runBin(['pooler-url', REF, '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'my-real-password',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.pooler_url).toBe(
      `postgresql://postgres.${REF}:my-real-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
    );
    // The API's templated connection_string is NOT what we output.
    expect(j.pooler_url).not.toContain('[PASSWORD]');
  });

  test('handles array response by preferring session pool_mode entry', async () => {
    mock = startMock({
      [`GET /v1/projects/${REF}/config/database/pooler`]: () =>
        jsonResp([
          { ...POOLER_OK, pool_mode: 'transaction', db_port: 6543 },
          { ...POOLER_OK, pool_mode: 'session', db_port: 5432 },
        ]),
    });
    const r = await runBin(['pooler-url', REF, '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    // Picked session entry with port 5432 (for this fixture)
    expect(j.pooler_url).toContain(':5432/postgres');
  });

  test('fails cleanly when pooler config is missing required fields', async () => {
    mock = startMock({
      [`GET /v1/projects/${REF}/config/database/pooler`]: () =>
        jsonResp({ identifier: 'x', pool_mode: 'session' }),
    });
    const r = await runBin(['pooler-url', REF], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      DB_PASS: 'pw',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing pooler config fields');
  });

  test('requires DB_PASS to construct URL', async () => {
    const r = await runBin(['pooler-url', REF], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DB_PASS env var is required');
  });
});

describe('list-orphans (D20)', () => {
  const MOCK_PROJECTS = [
    { ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'gbrain', created_at: '2026-04-20', region: 'us-east-1' },
    { ref: 'bbbbbbbbbbbbbbbbbbbb', name: 'gbrain-backup', created_at: '2026-04-21', region: 'us-east-1' },
    { ref: 'cccccccccccccccccccc', name: 'my-production', created_at: '2026-04-15', region: 'us-west-2' },
    { ref: 'dddddddddddddddddddd', name: 'gbrain', created_at: '2026-04-22', region: 'eu-west-1' },
  ];

  test('lists gbrain-prefixed projects that are NOT the active brain', async () => {
    mock = startMock({
      'GET /v1/projects': () => jsonResp(MOCK_PROJECTS),
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-orphan-'));
    // use top-level fs
    fs.mkdirSync(path.join(home, '.gbrain'));
    fs.writeFileSync(
      path.join(home, '.gbrain', 'config.json'),
      JSON.stringify({
        engine: 'postgres',
        // Active brain points at aaaaaaaaaaaaaaaaaaaa
        database_url: 'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:pw@host:6543/postgres',
      })
    );
    try {
      const r = await runBin(['list-orphans', '--json'], {
        SUPABASE_ACCESS_TOKEN: 'sbp_test',
        SUPABASE_API_BASE: mock.url,
        HOME: home,
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.active_ref).toBe('aaaaaaaaaaaaaaaaaaaa');
      expect(j.orphans.length).toBe(2);
      const refs = j.orphans.map((o: any) => o.ref).sort();
      expect(refs).toEqual(['bbbbbbbbbbbbbbbbbbbb', 'dddddddddddddddddddd']);
      // my-production is NOT in orphans — filtered out by gbrain prefix
      expect(refs).not.toContain('cccccccccccccccccccc');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('treats all gbrain-prefixed projects as orphans when no active config exists', async () => {
    mock = startMock({
      'GET /v1/projects': () => jsonResp(MOCK_PROJECTS),
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-no-cfg-'));
    try {
      const r = await runBin(['list-orphans', '--json'], {
        SUPABASE_ACCESS_TOKEN: 'sbp_test',
        SUPABASE_API_BASE: mock.url,
        HOME: home,
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.active_ref).toBeNull();
      // All 3 gbrain-prefixed projects are orphans when no active config
      expect(j.orphans.length).toBe(3);
    } finally {
      // use top-level fs
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('respects custom --name-prefix', async () => {
    mock = startMock({
      'GET /v1/projects': () =>
        jsonResp([
          { ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'my-prefix-one', created_at: '2026-04-20' },
          { ref: 'bbbbbbbbbbbbbbbbbbbb', name: 'gbrain', created_at: '2026-04-20' },
        ]),
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-prefix-'));
    try {
      const r = await runBin(['list-orphans', '--name-prefix', 'my-prefix', '--json'], {
        SUPABASE_ACCESS_TOKEN: 'sbp_test',
        SUPABASE_API_BASE: mock.url,
        HOME: home,
      });
      const j = JSON.parse(r.stdout);
      expect(j.orphans.length).toBe(1);
      expect(j.orphans[0].name).toBe('my-prefix-one');
    } finally {
      // use top-level fs
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('delete-project (D20)', () => {
  test('issues DELETE /v1/projects/<ref> and returns the deleted ref', async () => {
    let deletedPath = '';
    mock = startMock({
      'DELETE /v1/projects/abcdefghijklmnopqrst': (req) => {
        deletedPath = new URL(req.url).pathname;
        return jsonResp({ id: 1, ref: 'abcdefghijklmnopqrst', name: 'gbrain' });
      },
    });
    const r = await runBin(['delete-project', 'abcdefghijklmnopqrst', '--json'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    expect(deletedPath).toBe('/v1/projects/abcdefghijklmnopqrst');
    const j = JSON.parse(r.stdout);
    expect(j.deleted_ref).toBe('abcdefghijklmnopqrst');
  });

  test('surfaces 404 when the project does not exist', async () => {
    mock = startMock({
      'DELETE /v1/projects/nonexistent': () => jsonResp({ message: 'Project not found' }, 404),
    });
    const r = await runBin(['delete-project', 'nonexistent'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
      SUPABASE_API_BASE: mock.url,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('404');
  });

  test('requires a ref', async () => {
    const r = await runBin(['delete-project'], {
      SUPABASE_ACCESS_TOKEN: 'sbp_test',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing');
  });
});

describe('general', () => {
  test('unknown subcommand exits 2', async () => {
    const r = await runBin(['nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown subcommand');
  });

  test('no args prints usage and exits 2', async () => {
    const r = await runBin([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});
