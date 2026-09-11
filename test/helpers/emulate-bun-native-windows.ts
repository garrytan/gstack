/**
 * Bun preload fixture for native-Windows policy tests on any host.
 *
 * It combines the recursive-mkdir EEXIST behavior seen in Bun on Windows with
 * Node's Windows identity contract: process.platform is win32 and POSIX uid
 * accessors are unavailable.
 */
import './emulate-bun-windows-eexist';

Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
Object.defineProperty(process, 'geteuid', { configurable: true, value: undefined });
Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
