/**
 * Fake Ubicloud API and fake VM for scripts/ubicloud/ubi-runner.sh, shared by the
 * test/ubicloud-runner-*.test.ts parts split from test/ubicloud-runner.test.ts (GSTA-151).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');
export const DIR = join(ROOT, 'scripts/ubicloud');
export const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Fake Ubicloud API that can create: create adds the name to the listed file
 * (or answers the quota refusal in refuse with HTTP 400), show is running at
 * 192.0.2.1 while listed, destroy unlists. The fake VM is the directory vm/:
 * the fake ssh records every remote command in ssh.log, keeps copies of
 * ~/.ubirun-env and ~/.ubirun-setup.sh under the fixture root, serves pulls
 * from remote-fs/, and runs every other command there for real (HOME=vm/,
 * vmbin/ first on PATH), so uploads unpack, detached phases write their pid,
 * output and exit files, tail --pid follows them and pkill ends them. The stub
 * make in vmbin/ echoes `ran: make ARGS`, or runs command-mode or
 * make-<target>.sh from the fixture root. No network, no VM.
 */
export function fakeVm(opts: { listed?: string; refuse?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ubi-run-'));
  const bin = join(root, 'bin'), state = join(root, 'state'), log = join(root, 'calls.log'), sshLog = join(root, 'ssh.log'), record = join(root, 'vms.tsv');
  const vm = join(root, 'vm'), vmbin = join(root, 'vmbin'), srcDir = join(root, 'src'), checkpoints = join(root, 'checkpoints');
  mkdirSync(vm); mkdirSync(vmbin); mkdirSync(srcDir);
  writeFileSync(join(srcDir, 'README'), 'fixture checkout\n');
  mkdirSync(bin); mkdirSync(state, { recursive: true });
  writeFileSync(join(root, 'listed'), opts.listed ?? '');
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\n' +
    'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n' +
    'body=$(cat); echo "$body" >> ' + JSON.stringify(log) + '\n' +
    'listed=' + JSON.stringify(join(root, 'listed')) + '\n' +
    'loc=$(printf \'%s\' "$body" | sed -n \'s/.*"vm", *"\\([^/"]*\\)\\/[^"]*".*/\\1/p\')\n' +
    'name=$(printf \'%s\' "$body" | sed -n \'s/.*"vm", *"[^/"]*\\/\\([^"]*\\)".*/\\1/p\')\n' +
    'case "$body" in\n' +
    '  *\'"create"\'*) if [ -n ' + JSON.stringify(opts.refuse ?? '') + ' ]; then printf \'%s\' ' + JSON.stringify(opts.refuse ?? '') + ' > "$out"; printf 400; else echo "$loc $name" >> "$listed"; : > "$out"; printf 200; fi ;;\n' +
    '  *destroy*) : > "$out"; if [ -f "$listed.destroy-fails" ]; then printf 500; else grep -v " $name$" "$listed" > "$listed.tmp"; mv "$listed.tmp" "$listed"; printf 200; fi ;;\n' +
    '  *\'"list"\'*) if [ -f "$listed.list-fails" ]; then echo down > "$out"; printf 503; else cat "$listed" "$listed.ghost" > "$out" 2>/dev/null; printf 200; fi ;;\n' +
    '  *\'"show"\'*) [ -z "${FAKE_SHOW_DELAY:-}" ] || sleep "$FAKE_SHOW_DELAY"; if [ -f "$listed.show-fails" ]; then echo down > "$out"; printf 503; elif grep -q " $name$" "$listed"; then printf \'state: running\\nsize: standard-16\\nip4: 192.0.2.1\\n\' > "$out"; printf 200; else : > "$out"; printf 404; fi ;;\n' +
    '  *) : > "$out"; printf 200 ;;\n' +
    'esac\n');
  writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\n' +
    'root=' + JSON.stringify(root) + '; vm="$root/vm"\n' +
    'cmd=${*: -1}\n' +
    'printf \'%s\\n\' "$cmd" >> "$root/ssh.log"\n' +
    'export HOME="$vm" PATH="$root/vmbin:$PATH"\n' +
    'cd "$vm" || exit 255\n' +
    'case "$cmd" in\n' +
    '  *pkill*) echo "$cmd" >> "$root/cancel.log"; exec bash -c "$cmd" ;;\n' +
    '  *captured*) cat > "$root/captured" ;;\n' +
    '  *"cat > ~/.ubirun-env"*) tee "$root/ubirun-env" > "$vm/.ubirun-env" ;;\n' +
    '  *"cat > ~/.ubirun-setup.sh"*) tee "$root/ubirun-setup.sh" > "$vm/.ubirun-setup.sh" ;;\n' +
    '  *"tar -czf -"*) base=${cmd##* }; tar -czf - -C "$root/remote-fs" "$base" ;;\n' +
    '  *"ls -d -- "*) : ;;\n' +
    '  *) exec bash -c "$cmd" ;;\n' +
    'esac\n');
  writeFileSync(join(vmbin, 'make'), '#!/usr/bin/env bash\n' +
    'root=' + JSON.stringify(root) + '\n' +
    'if [ -f "$root/command-mode" ]; then exec bash -c "$(cat "$root/command-mode")"; fi\n' +
    'echo "ran: make $*"\n' +
    '[ ! -f "$root/make-$1.sh" ] || exec bash "$root/make-$1.sh"\n');
  chmodSync(join(bin, 'curl'), 0o755); chmodSync(join(bin, 'ssh'), 0o755); chmodSync(join(vmbin, 'make'), 0o755);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: state, UBI_POLL_SECONDS: '1', UBI_VM_RECORD: record, UBI_OWNER: 'thrd1', UBI_HEARTBEAT: '0', UBI_CHECKPOINT_DIR: checkpoints };
  const run = (args: string[], extra: Record<string, string> = {}, stdin?: string) =>
    Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), ...args], { env: { ...env, ...extra }, stdin: stdin === undefined ? undefined : Buffer.from(stdin), timeout: 90_000 });
  const spawn = (args: string[], extra: Record<string, string> = {}) =>
    Bun.spawn(['bash', join(DIR, 'ubi-runner.sh'), ...args], { env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  return {
    root, state, record, run, spawn, vm, src: srcDir, checkpoints,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    ssh: () => (existsSync(sshLog) ? readFileSync(sshLog, 'utf8') : ''),
    listed: () => readFileSync(join(root, 'listed'), 'utf8'),
  };
}

export const src = (f: { root: string }, cfg: unknown) => {
  const dir = join(f.root, 'repo');
  mkdirSync(join(dir, '.gstack'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/boot.sh'), 'echo boot\n');
  writeFileSync(join(dir, '.gstack/ubicloud.json'), JSON.stringify(cfg));
  return dir;
};

export const run = (f: ReturnType<typeof fakeVm>, args: string[], extra: Record<string, string> = {}, stdin?: string) => f.run(args, extra, stdin);

// GSTA-158 P3: detached phases, reattach and tier checkpoints.
export const until = async (cond: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!cond()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await Bun.sleep(100); }
};
export const vmDirs = (f: ReturnType<typeof fakeVm>) => (existsSync(f.state) ? readdirSync(f.state).filter(d => d.startsWith('ubirun-')) : []);
export const phaseStarted = (f: ReturnType<typeof fakeVm>, phase: string) => vmDirs(f).some(d => existsSync(join(f.state, d, 'phase.' + phase + '.start')));
export const creates = (f: ReturnType<typeof fakeVm>) => f.calls().split('\n').filter(l => l.includes('"create"')).length;
export const killSession = async (f: ReturnType<typeof fakeVm>, phase: string) => {
  const pidFile = join(f.vm, '.ubirun-' + phase + '.pid');
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 10_000);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 10_000);
};
export const gitSrc = (f: ReturnType<typeof fakeVm>, cfg?: unknown) => {
  const dir = cfg === undefined ? join(f.root, 'repo') : src(f, cfg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README'), 'fixture repo\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'fixture']]) {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr.toString());
  }
  return dir;
};
export const TIERS = { setup: 'scripts/boot.sh', tiers: [{ name: 't1', command: 'make t1' }, { name: 't2', command: 'make t2' }, { name: 't3', command: 'make t3' }] };
export const bootCounts = (f: ReturnType<typeof fakeVm>, dir: string) => writeFileSync(join(dir, 'scripts/boot.sh'), 'echo boot >> ~/setup-count\n');
export const verifyLine = (out: string) => out.split('\n').find(l => l.startsWith('UBI_VERIFY: ')) ?? '';
export type FakeVm = ReturnType<typeof fakeVm>;
