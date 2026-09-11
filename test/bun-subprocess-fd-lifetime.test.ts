import { expect, test } from 'bun:test';

// Run the ownership probe in a child: an affected Bun can close arbitrary
// recycled descriptors, including the test runner's own sockets and pipes.
// Playwright uses the same extra-stdio slots for Chromium's CDP transport.
// Upstream ownership fixes: oven-sh/bun#32520 and oven-sh/bun#33828.
const fixture = String.raw`
  const { spawn } = require('node:child_process');
  const rounds = 4;
  const listenersPerRound = 8;
  for (let round = 0; round < rounds; round++) {
    let child = spawn(process.execPath, ['-e', ''], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    await Promise.all(child.stdio.slice(3).map(socket => {
      if (socket.closed) return;
      return new Promise(resolve => {
        // Subscribe before destroy: descriptor reuse must follow the actual
        // close event, not a delay that may expire before close under load.
        socket.once('close', resolve);
        socket.destroy();
      });
    }));

    // The OS can now reuse the closed extra-stdio descriptors for these
    // listeners. Capture their URLs before GC; affected runtimes can also
    // invalidate server.port when the underlying listener vanishes.
    const listeners = Array.from({ length: listenersPerRound }, () => {
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0, fetch: () => new Response('alive'),
      });
      return { server, url: 'http://127.0.0.1:' + server.port + '/' };
    });
    child = null;
    Bun.gc(true);
    await Bun.sleep(0);
    Bun.gc(true);

    const failures = [];
    for (const { url } of listeners) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        const body = await response.text();
        if (response.status !== 200 || body !== 'alive') {
          failures.push({ url, status: response.status, body });
        }
      } catch (error) {
        failures.push({ url, error: String(error) });
      }
    }
    if (failures.length) {
      console.error(JSON.stringify({ bun: Bun.version, round, failures }));
      // Only this isolated process is affected. Avoid asking the broken
      // runtime to close descriptors again; process exit releases them.
      process.exit(1);
    }
    for (const { server } of listeners) await server.stop(true);
  }
  console.log(JSON.stringify({ checkedListeners: rounds * listenersPerRound }));
`;

test.skipIf(process.platform === 'win32')('extra-stdio cleanup preserves unrelated HTTP listeners after GC', async () => {
  const child = Bun.spawn([process.execPath, '-e', fixture], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000, killSignal: 'SIGKILL',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const diagnosis = `Bun ${Bun.version} failed the subprocess descriptor-ownership probe. `
    + 'Install the repository\'s pinned Bun version (1.4.0 or newer); '
    + 'older Bun can double-close extra stdio and destroy unrelated browser/server sockets '
    + '(oven-sh/bun#32520, #33828).\n'
    + `exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  expect(code, diagnosis).toBe(0);
  expect(JSON.parse(stdout), diagnosis).toEqual({ checkedListeners: 32 });
  expect(stderr, diagnosis).toBe('');
}, 15_000);
