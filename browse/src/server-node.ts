/**
 * Node-compatible server entry point for Windows.
 * Loads Bun polyfills, then runs the regular server.
 */

// Must be imported before anything else to polyfill Bun globals
import './bun-polyfill-win';

// Polyfill import.meta.dir (used by server.ts for state file path)
if (!(import.meta as any).dir) {
  (import.meta as any).dir = import.meta.dirname || __dirname;
}

// Now load the actual server
import './server';
