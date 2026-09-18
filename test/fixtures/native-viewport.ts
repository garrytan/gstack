/** Local PTY child; never runs inside the shared test process. */
if (import.meta.main) {
  const scenario = process.argv[2];
  if (!['normal', 'already-exited', 'body-error'].includes(scenario)) {
    throw new Error('Expected a native viewport scenario');
  }
  const paint = () => {
    const rows = process.stdout.rows;
    process.stdout.write('\x1b[2J\x1b[HNATIVE:' + process.stdout.columns + 'x' + rows + '\x1b[' + (rows - 2) + ';1HLOW:' + rows);
  };
  process.stdout.on('resize', paint);
  paint();
  setInterval(() => {}, 1000);
  if (scenario === 'already-exited') setTimeout(() => process.exit(0), 1200);
}
