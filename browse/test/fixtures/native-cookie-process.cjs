module.exports = ({ pidsFile, mode }) => ({
  chromium: {
    async launchPersistentContext() {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      require('node:fs').writeFileSync(pidsFile, JSON.stringify([process.pid, child.pid]));
      if (mode === 'worker-crash') setTimeout(() => process.exit(3), 100);
      await new Promise(() => {});
    },
  },
});
