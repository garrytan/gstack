import * as path from 'node:path';
import {
  acquireDurableOwnerLock,
  releaseDurableOwnerLock,
} from './durable-owner-lock';

export function harnessProducerGateTarget(stateRoot: string): string {
  return path.join(
    path.resolve(stateRoot),
    'ecpe',
    'milestones',
    'ecpe-v3-pilot.harness.t4.gate',
  );
}

export function withHarnessProducerGate<T>(
  stateRoot: string,
  callback: () => T,
  busyTimeoutMs = 30_000,
): T {
  const owned = acquireDurableOwnerLock(
    harnessProducerGateTarget(stateRoot),
    'harness_producer_gate_busy',
    busyTimeoutMs,
  );
  try {
    return callback();
  } finally {
    releaseDurableOwnerLock(owned);
  }
}

export async function withHarnessProducerGateAsync<T>(
  stateRoot: string,
  callback: () => Promise<T>,
  busyTimeoutMs = 30_000,
): Promise<T> {
  const owned = acquireDurableOwnerLock(
    harnessProducerGateTarget(stateRoot),
    'harness_producer_gate_busy',
    busyTimeoutMs,
  );
  try {
    return await callback();
  } finally {
    releaseDurableOwnerLock(owned);
  }
}
