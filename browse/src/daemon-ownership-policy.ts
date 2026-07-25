export type TerminationAction = 'retain' | 'shutdown';

export interface DaemonOwnership {
  startedHeaded: boolean;
  tunnelActive: boolean;
}

/**
 * Decide whether an external lifecycle signal owns the daemon.
 *
 * Browser mode can change from headless to headed during `handoff`. That
 * transition must not transfer ownership back to the already-exited one-shot
 * CLI process. Only a daemon launched headed, or one serving an active tunnel,
 * should shut down when its launch parent disappears or sends SIGTERM.
 */
export function terminationAction(ownership: DaemonOwnership): TerminationAction {
  return ownership.startedHeaded || ownership.tunnelActive ? 'shutdown' : 'retain';
}
