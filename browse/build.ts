/**
 * Platform-aware build script — produces browse.exe on Windows, browse on Unix.
 */

import { $ } from 'bun';

const ext = process.platform === 'win32' ? '.exe' : '';
await $`bun build --compile browse/src/cli.ts --outfile browse/dist/browse${ext}`;
