import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoPairedProject } from './helpers/ceo-paired-fixture';
import { processPayment, PaymentFailure, ProviderError, type Payment } from './fixtures/paired-payment/src/payment';

test('paired review gets runnable existing coverage that leaves both intended gaps open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-payment-fixture-'));
  try {
    seedCeoPairedProject(dir, '# Add two payment tests\n');
    const file = path.join(dir, 'src/payment.ts'); const original = fs.readFileSync(file, 'utf8');
    // The review's two missing tests are injected only for this free proof,
    // never copied into the agent's seeded baseline.
    const checks = {
      receipt: `test('target receipt: first success returns the correct value without a retry', async () => {
        let calls = 0; const waits: number[] = [];
        expect(await processPayment(payment, {
          chargeOnce: async () => { calls++; return { id: 'charge-42' }; },
          sleep: async ms => { waits.push(ms); },
        })).toEqual({ chargeId: 'charge-42', amount: 1200, currency: 'usd' });
        expect(calls).toBe(1); expect(waits).toEqual([]);
      });`,
      failure: `test.each(['502', 'timeout'] as const)('target failure: repeated %s stops after one wait and retry', async code => {
        const causes = [new ProviderError(code), new ProviderError(code)];
        const requests: Readonly<Payment>[] = []; const waits: number[] = [];
        const result = processPayment(payment, {
          chargeOnce: async request => { requests.push(request); throw causes[Math.min(requests.length - 1, 1)]; },
          sleep: async ms => { waits.push(ms); },
        });
        const failure = await result.then(() => { throw new Error('expected rejection'); }, error => error);
        expect(failure).toBeInstanceOf(PaymentFailure);
        expect(failure).toMatchObject({ key: payment.key, outcomeUnknown: true });
        expect(failure.cause).toBe(causes[1]);
        expect(requests).toEqual([payment, payment]); expect(requests[0]).toBe(requests[1]);
        expect(waits).toEqual([100]);
      });`,
    };
    type Target = keyof typeof checks;
    const targetFile = path.join(dir, 'target-check.test.ts');
    expect(fs.existsSync(targetFile)).toBe(false);
    const run = (source: string, targets: Target[]) => {
      fs.writeFileSync(file, source);
      fs.writeFileSync(targetFile, `import { expect, test } from 'bun:test';
        import { PaymentFailure, ProviderError, processPayment, type Payment } from './src/payment';
        const payment: Payment = { key: 'order-42', amount: 1200, currency: 'usd' };
        ${targets.map(target => checks[target]).join('\n')}`);
      return Bun.spawnSync([process.execPath, 'test', './contract.test.ts', './target-check.test.ts'], {
        cwd: dir, timeout: 5000, env: { PATH: process.env.PATH ?? '' },
      });
    };
    const variants = [
      { target: null, source: original },
      { target: 'receipt', source: original.replace('amount: request.amount, currency:', 'amount: request.amount + (attempt === 0 ? 1 : 0), currency:') },
      { target: 'failure', source: original.replace('attempt === 1', 'attempt === 2') },
    ] as const;
    expect(new Set(variants.map(variant => variant.source)).size).toBe(3);
    // Baseline detects neither target mutant. Each missing contract catches its
    // own mutant and leaves the other live; adding both catches both.
    for (const targets of [[], ['receipt'], ['failure'], ['receipt', 'failure']] as Target[][]) {
      for (const variant of variants) {
        const result = run(variant.source, targets);
        const output = result.stderr.toString();
        const killed = variant.target !== null && targets.includes(variant.target);
        expect(result.exitCode, `${targets.join('+') || 'baseline'} / ${variant.target || 'original'}\n${output}`).toBe(killed ? 1 : 0);
        if (killed) {
          expect(output).toContain(`(fail) target ${variant.target}:`);
        } else {
          expect(output).toContain(`${20 + (targets.includes('receipt') ? 1 : 0) + (targets.includes('failure') ? 2 : 0)} pass`);
          expect(output).toContain('0 fail');
        }
      }
    }
    // The fixture must enforce its advertised pre-existing contracts without
    // closing either of the review's missing first-success/exhaustion tests.
    for (const [source, failedTest] of [
      [original.replace('amount: request.amount, currency:', 'amount: request.amount + 1, currency:'), 'recovery after one 502'],
      [original.replace('await io.sleep(100);', 'void io.sleep(100);'), 'recovery after one 502'],
      [original.replace('outcomeUnknown, error);', 'outcomeUnknown, new ProviderError((error as ProviderError).code));'), 'declined is never retried'],
      [original.replace('outcomeUnknown ||= retryable;', 'outcomeUnknown = retryable;'), 'uncertain 502 followed by declined stays unknown'],
      [original.replace("error.code === '502' || error.code === 'timeout'", "error.code === '502'"), 'recovery after one timeout'],
      [original.replace('throw new PaymentFailure(request.key, outcomeUnknown, cause);', 'throw cause;'), 'rejected backoff after 502'],
    ]) {
      expect(source).not.toBe(original);
      const result = run(source!, []);
      expect(result.exitCode, result.stderr.toString()).toBe(1);
      expect(result.stderr.toString()).toContain('(fail) ' + failedTest);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing payment behavior supports the missing happy and exhausted-retry tests', async () => {
  const payment: Payment = { key: 'order-42', amount: 1200, currency: 'usd' };
  let calls = 0; const delays: number[] = [];
  const receipt = await processPayment(payment, {
    chargeOnce: async () => { calls++; return { id: 'charge-42' }; },
    sleep: async ms => { delays.push(ms); },
  });
  expect(receipt).toEqual({ chargeId: 'charge-42', amount: 1200, currency: 'usd' });
  expect(calls).toBe(1); expect(delays).toEqual([]);
  for (const code of ['502', 'timeout'] as const) {
    const requests: Readonly<Payment>[] = []; const waits: number[] = []; const cause = new ProviderError(code);
    const outcome = processPayment(payment, {
      chargeOnce: async request => { requests.push(request); throw cause; },
      sleep: async ms => { waits.push(ms); },
    });
    await expect(outcome).rejects.toBeInstanceOf(PaymentFailure);
    await expect(outcome).rejects.toMatchObject({ key: payment.key, outcomeUnknown: true, cause });
    expect(requests).toEqual([payment, payment]); expect(requests[0]).toBe(requests[1]);
    expect(waits).toEqual([100]);
  }
  const causes = [new ProviderError('timeout'), new ProviderError('auth')];
  let mixedCalls = 0;
  await expect(processPayment(payment, {
    chargeOnce: async () => { throw causes[mixedCalls++]; }, sleep: async () => {},
  })).rejects.toMatchObject({ key: payment.key, outcomeUnknown: true, cause: causes[1] });
  expect(mixedCalls).toBe(2);
});
