// Native Windows reports regular .exe files as 0666 (or 0444), with uid 0.
// Keep actual file reads, hashing, and Bun --version execution in the test.
import './emulate-bun-windows-eexist';
const fs = require('node:fs');
const original = fs.lstatSync;
fs.lstatSync = (...args: unknown[]) => {
  const info = original(...args);
  if (info.isFile()) { info.mode = 0o100666; info.uid = 0; }
  return info;
};
Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
