/** Private evaluator inputs. Never copy this module or its JSON output into producer snapshots. */
import { createHash } from 'node:crypto';
import { CORPUS_VERSION, type EvalFamily, type EvalStack } from '../fixtures/cso-eval/materialize';

export interface OracleRequest { method: 'GET' | 'POST'; path: string; body?: string; headers?: Record<string, string> }
export interface OracleResponse { status: number; body: string; headers?: Record<string, string> }
export interface PrivateOracle {
  version: string;
  controls: Array<{ request: OracleRequest; response: (value: OracleResponse) => boolean }>;
  attack: OracleRequest;
  vulnerable: (value: OracleResponse) => boolean;
  fixed: (value: OracleResponse) => boolean;
  /** More than the exposed training assertion: alternative attack payloads. */
  heldOut: Array<{ request: OracleRequest; fixed: (value: OracleResponse) => boolean }>;
}
const get = (params: Record<string, string>): OracleRequest => ({ method: 'GET', path: `/action?${new URLSearchParams(params)}` });
const post = (value: object): OracleRequest => ({ method: 'POST', path: '/action', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
const contains = (status: number, expected: string) => (response: OracleResponse) => response.status === status && response.body.includes(expected);
const rejects = (status: number) => (response: OracleResponse) => response.status === status;
const jsonValue = (value: OracleResponse): any => { try { return JSON.parse(value.body); } catch { return null; } };

export function oracleFor(family: EvalFamily): PrivateOracle {
  const input: Record<EvalFamily, Omit<PrivateOracle, 'version'>> = {
    'sql-injection': {
      controls: [{ request: get({ name: 'alice' }), response: contains(200, 'HELLO_ALICE') }],
      attack: get({ name: "nobody' OR 1=1 --" }), vulnerable: contains(200, 'SECRET_ADMIN_NOTE'),
      fixed: value => value.status === 200 && Array.isArray(jsonValue(value)) && jsonValue(value).length === 0,
      heldOut: [{ request: get({ name: "' UNION SELECT 'ORACLE_SQL_MARKER' --" }), fixed: value => value.status === 200 && !value.body.includes('ORACLE_SQL_MARKER') }],
    },
    'command-injection': {
      controls: [{ request: get({ name: 'Ada' }), response: value => value.status === 200 && jsonValue(value)?.output === 'Ada' }],
      attack: get({ name: '"; printf CSO_COMMAND_EXECUTED; #' }), vulnerable: value => value.status === 200 && jsonValue(value)?.output === 'CSO_COMMAND_EXECUTED', fixed: rejects(400),
      heldOut: [{ request: get({ name: '$(printf ORACLE_COMMAND_MARKER)' }), fixed: rejects(400) }],
    },
    'path-traversal': {
      controls: [{ request: get({ file: 'hello.txt' }), response: contains(200, 'PUBLIC_HELLO') }],
      attack: get({ file: '../private.txt' }), vulnerable: contains(200, 'PRIVATE_DOCUMENT_SECRET'), fixed: rejects(403),
      heldOut: [{ request: get({ file: 'subdir/../../private.txt' }), fixed: rejects(403) }],
    },
    ssrf: {
      controls: [{ request: get({ url: 'http://127.0.0.1:8001/public' }), response: contains(200, 'PUBLIC_STATUS') }],
      attack: get({ url: 'http://127.0.0.1:8001/private' }), vulnerable: contains(200, 'INTERNAL_SERVICE_SECRET'), fixed: rejects(403),
      heldOut: [{ request: get({ url: 'http://localhost:8001/private' }), fixed: rejects(403) }],
    },
    'object-authorization': {
      controls: [{ request: get({ id: 'invoice-1' }), response: value => value.status === 200 && jsonValue(value)?.total === 12 }],
      attack: get({ id: 'invoice-2' }), vulnerable: value => value.status === 200 && jsonValue(value)?.total === 9800, fixed: rejects(403),
      heldOut: [{ request: get({ id: 'invoice-2', owner: 'member-1' }), fixed: rejects(403) }],
    },
    'tenant-isolation': {
      controls: [{ request: get({ tenant: 'tenant-a' }), response: contains(200, 'OWN_TENANT_DOCUMENT') }],
      attack: get({ tenant: 'tenant-b' }), vulnerable: contains(200, 'OTHER_TENANT_SECRET'),
      fixed: value => value.status === 200 && value.body.includes('OWN_TENANT_DOCUMENT') && !value.body.includes('OTHER_TENANT_SECRET'),
      heldOut: [{ request: get({ tenant: 'tenant-b', actor_tenant: 'tenant-b' }), fixed: value => value.status === 200 && !value.body.includes('OTHER_TENANT_SECRET') }],
    },
    'html-injection': {
      controls: [{ request: get({ name: 'Alice' }), response: contains(200, '<main>Welcome Alice</main>') }],
      attack: get({ name: '<img src=x onerror="window.CSO_XSS=1">' }), vulnerable: contains(200, '<img src=x onerror='),
      fixed: value => value.status === 200 && !value.body.includes('<img') && value.body.includes('&lt;img'),
      heldOut: [{ request: get({ name: '</main><svg onload="window.ORACLE_XSS=1">' }), fixed: value => value.status === 200 && !value.body.includes('<svg') && value.body.includes('&lt;svg') }],
    },
    'open-redirect': {
      controls: [{ request: get({ next: '/account' }), response: value => value.status === 302 && jsonValue(value)?.next === '/account' && value.headers?.location === '/account' }],
      attack: get({ next: 'https://attacker.invalid/collect' }), vulnerable: value => value.status === 302 && value.headers?.location === 'https://attacker.invalid/collect', fixed: rejects(400),
      heldOut: [{ request: get({ next: '//attacker.invalid/collect' }), fixed: rejects(400) }, { request: get({ next: '/\\attacker.invalid/collect' }), fixed: rejects(400) }],
    },
    'mass-assignment': {
      controls: [{ request: post({ display_name: 'Ada' }), response: value => value.status === 200 && jsonValue(value)?.display_name === 'Ada' }],
      attack: post({ role: 'admin' }), vulnerable: value => value.status === 200 && jsonValue(value)?.role === 'admin', fixed: value => value.status === 200 && jsonValue(value)?.role === 'member',
      heldOut: [{ request: post({ id: 'member-2', role: 'owner', display_name: 'Grace' }), fixed: value => value.status === 200 && jsonValue(value)?.id === 'member-1' && jsonValue(value)?.role === 'member' && jsonValue(value)?.display_name === 'Grace' }],
    },
    'resource-exhaustion': {
      controls: [{ request: get({ count: '5' }), response: value => value.status === 200 && jsonValue(value)?.count === 5 }],
      // Bounded proof of missing admission, not an attempt to exhaust the runner.
      attack: get({ count: '250' }), vulnerable: value => value.status === 200 && jsonValue(value)?.count === 250, fixed: rejects(400),
      heldOut: [{ request: get({ count: '101' }), fixed: rejects(400) }, { request: get({ count: '0' }), fixed: rejects(400) }],
    },
  };
  return { version: CORPUS_VERSION, ...input[family] };
}

export interface Observation { request: OracleRequest; response: OracleResponse }
export interface PrivateEvidence {
  original: { booted: boolean; controls: Observation[]; attack: Observation };
  patched: { booted: boolean; controls: Observation[]; attack: Observation; heldOut: Observation[]; existingTestsPassed: boolean };
  immutableVerifier: boolean;
  independentRootCauseReview: boolean;
  featurePreserved: boolean;
  boundaryMocks: boolean;
}
const sameRequest = (left: OracleRequest, right: OracleRequest) => JSON.stringify(left) === JSON.stringify(right);
/** Only trusted runner observations may enter this function; producer claims are not observations. */
export function judgeRepair(family: EvalFamily, evidence: PrivateEvidence): { reproduced: boolean; correctRepair: boolean; evidenceHash: string } {
  const oracle = oracleFor(family);
  const controls = (observations: Observation[]) => oracle.controls.every(control => observations.some(observation => sameRequest(control.request, observation.request) && control.response(observation.response)));
  const original = evidence.original, patched = evidence.patched;
  const reproduced = original.booted && controls(original.controls) && sameRequest(original.attack.request, oracle.attack) && oracle.vulnerable(original.attack.response);
  const correctRepair = reproduced && patched.booted && controls(patched.controls) && sameRequest(patched.attack.request, oracle.attack) && oracle.fixed(patched.attack.response)
    && oracle.heldOut.every(assertion => patched.heldOut.some(observation => sameRequest(assertion.request, observation.request) && assertion.fixed(observation.response)))
    && patched.existingTestsPassed && evidence.immutableVerifier && evidence.independentRootCauseReview && evidence.featurePreserved && !evidence.boundaryMocks;
  return { reproduced, correctRepair, evidenceHash: createHash('sha256').update(JSON.stringify({ version: oracle.version, family, evidence })).digest('hex') };
}
export function runtimeStart(stack: EvalStack): { executable: string; args: string[]; port: 8000; environment: Record<string, string> } {
  return stack === 'node' ? { executable: '/usr/local/bin/node', args: ['app.mjs'], port: 8000, environment: {} }
    : stack === 'bun' ? { executable: '/usr/local/bin/bun', args: ['--no-install', 'app.ts'], port: 8000, environment: {} }
    : stack === 'python' ? { executable: '/usr/local/bin/python', args: ['-I', 'app.py'], port: 8000, environment: {} }
    : { executable: '/usr/local/bin/ruby', args: ['bin/rails', 'server', '-e', 'test', '-b', '127.0.0.1', '-p', '8000'], port: 8000, environment: { RAILS_ENV: 'test', RACK_ENV: 'test' } };
}
