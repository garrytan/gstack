/**
 * pregate/environment — tells a failure the machine caused from one the diff
 * caused (Lane D, GSTA-112; truther #617). A check that could not run its
 * command (a runner or guard binary missing from PATH, a network error or a
 * quota refusal before any test ran, a full disk) is `incomplete` under
 * PREGATE_ENVIRONMENT with `cause: 'environment'`, a kind and the line that
 * proves it, so a lane waives by cause and a reader never mistakes it for the
 * branch's fault. The classifier reads a command's output and exit code only;
 * the caller decides when to ask it: a local lane whose runner printed a test
 * summary is the diff's failure whatever its log says, and only a run with no
 * summary (nothing ran) is classified from its output, and only before any
 * test file started. A missing binary is the machine's only when the command's
 * own binary is off PATH: a script the diff controls that exits 127 or prints
 * "command not found" is the diff's failure (`classifyCommandEnvironment`).
 */
import type { CheckResult, EnvironmentCause, EnvironmentKind } from './types';

/** A cause established at launch: a spawn failure, a binary off PATH, a runtime or tool refusal. */
export const launchCause = (kind: EnvironmentKind, evidence: string): EnvironmentCause => ({ kind, evidence, proof: 'launch' });

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The shell's own "no such command" text (POSIX and cmd.exe); exit 127 says the same without text. */
const NOT_FOUND = /command not found|is not recognized as an internal or external command/;
const RULES: Array<{ kind: EnvironmentKind; re: RegExp }> = [
  { kind: 'missing-binary', re: new RegExp(`${NOT_FOUND.source}|No such file or directory: ['"]?[\\w./-]+|spawn \\S+ ENOENT|\\bENOENT\\b.*\\bspawn\\b|not on PATH`) },
  { kind: 'arg-limit', re: /\bE2BIG\b|[Aa]rgument list too long/ },
  { kind: 'quota', re: /\bquota\b|\b429 Too Many Requests|status(?: code)?[:= ]+429\b|HTTP(?:\/[\d.]+)? 429\b|\brate.?limit(?:ed)?\b|insufficient_quota/i },
  { kind: 'network', re: /\bE(?:NOTFOUND|CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|PIPE)\b|getaddrinfo|Could not resolve host|Connection refused|Connection reset|Network is unreachable|fetch failed|TLS handshake|certificate verify failed|UNABLE_TO_GET_ISSUER_CERT|Temporary failure in name resolution/ },
  { kind: 'disk', re: /\bENOSPC\b|No space left on device|\bEDQUOT\b|Disk quota exceeded/ },
];

/** The first line (trimmed, capped) of ANSI-free `text` that matches `re`, else its first line. */
function evidenceLine(text: string, re: RegExp): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return (lines.find(l => re.test(l)) ?? lines[0] ?? '').replace(/^(?:Error|error|ERROR):\s*/, '').slice(0, 200);
}

/**
 * The environment cause a command's output and exit code show, or null for an
 * ordinary failure. Exit 127 (the shell found no such command) is
 * missing-binary with or without text; a disk rule outranks quota (EDQUOT is a
 * disk quota); otherwise the first rule in order whose text appears wins.
 * Exit 127 is proved at launch; a text match is `proof: 'output'`, which the
 * diff's own output could have written, and the fix says so.
 */
export function classifyEnvironment(output: string, exit: number | null): EnvironmentCause | null {
  const text = output.replace(ANSI, '');
  if (exit === 127 || NOT_FOUND.test(text)) return { kind: 'missing-binary', evidence: evidenceLine(text, RULES[0]!.re) || 'exit 127: the shell found no such command', proof: exit === 127 ? 'launch' : 'output' };
  const disk = RULES.find(r => r.kind === 'disk')!;
  if (disk.re.test(text)) return { kind: 'disk', evidence: evidenceLine(text, disk.re), proof: 'output' };
  for (const rule of RULES) if (rule.kind !== 'disk' && rule.re.test(text)) return { kind: rule.kind, evidence: evidenceLine(text, rule.re), proof: 'output' };
  return null;
}

/** The binary a shell command runs: the first word after a leading `(cd … &&` and any `NAME=value` assignments. */
export function commandBinary(command: string): string | null {
  const words = command.replace(/^\(\s*cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '').trim().split(/\s+/);
  return words.find(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? null;
}

/**
 * `classifyEnvironment` for a command that started and exited: missing-binary
 * holds only when the command's own binary is off `env.PATH`. A runner or
 * guard that resolved and then exited 127, or printed "command not found" from
 * a script the diff controls, is the diff's failure.
 */
export function classifyCommandEnvironment(command: string, output: string, exit: number | null, env: NodeJS.ProcessEnv): EnvironmentCause | null {
  const cause = classifyEnvironment(output, exit);
  if (cause?.kind !== 'missing-binary') return cause;
  const bin = commandBinary(command);
  return bin && Bun.which(bin, { PATH: env.PATH ?? '' }) ? null : { ...cause, proof: 'launch' };
}

const FIX: Record<EnvironmentKind, string> = {
  'missing-binary': 'install the named tool on this machine (or put it on PATH), or run the lane remotely (--remote, or clear it with a run URL)',
  'arg-limit': 'the command line or environment passed to the runner is over the system\'s argument limit (E2BIG); gstack splits a lane\'s file list to stay under it, so report this as a gstack bug with this line, and meanwhile run the lane remotely or split the selection',
  network: 'check the network, proxy or registry this machine reaches, then rerun; or run the lane remotely',
  quota: 'wait for the quota or raise it, free the backend\'s capacity, then rerun',
  disk: 'free disk space (or move the state root) and rerun',
  runtime: 'repair the runtime the line names (the install verdict or the pinned Bun), then rerun',
  tool: 'repair or reinstall the named gstack tool, then rerun',
};
/** The fix's last clause: a launch-proved cause clears the diff; an output-inferred one asks for confirmation elsewhere, since the diff's own output could have written the line. */
export const PROOF_NOTE = {
  launch: 'the diff is not at fault',
  output: 'inferred from the output alone (no test was counted), which the diff could have written: confirm on another machine or with --remote before treating the diff as clear',
} as const;

/** An `incomplete` result under PREGATE_ENVIRONMENT: cause, kind, evidence, an `environment:` line and the kind's fix. */
export function environmentResult(base: CheckResult, cause: EnvironmentCause, detail: string): CheckResult {
  return { ...base, status: 'incomplete', code: 'PREGATE_ENVIRONMENT', cause: 'environment', environment: cause, detail, fix: `${FIX[cause.kind]}; ${PROOF_NOTE[cause.proof]}`, lines: [...(base.lines ?? []), environmentLine(cause)] };
}

export const environmentLine = (cause: EnvironmentCause) => `environment: ${cause.kind} — ${cause.evidence}${cause.proof === 'output' ? ' (inferred from output)' : ''}`;
