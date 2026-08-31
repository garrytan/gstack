#!/usr/bin/env bun
/**
 * Derive the Chrome extension ID from the "key" field in
 * extension/manifest.json.
 *
 * Chrome computes an extension's ID as the first 16 bytes of the SHA-256
 * hash of the DER-encoded public key, with each hex nibble mapped from
 * 0-9a-f to a-p (the "mpdecimal" alphabet). Pinning the public key in the
 * manifest pins the ID, which lets the browse server verify the Origin
 * header on POST /extension-token against a single known extension
 * identity (GSTACK_EXTENSION_ID in browse/src/server.ts).
 *
 * The private half of the keypair is intentionally NOT in the repo — the
 * extension is loaded unpacked (or baked into Browser.app), so only the
 * public key is needed to pin the ID. Regenerating the keypair changes
 * the ID and requires updating both the manifest "key" and the
 * GSTACK_EXTENSION_ID constant.
 *
 * Usage: bun browse/scripts/extension-id.ts [path/to/manifest.json]
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const manifestPath = process.argv[2]
  ?? path.join(import.meta.dir, '../../extension/manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
  console.error(`No "key" field in ${manifestPath}`);
  process.exit(1);
}

export function extensionIdFromPublicKey(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const c of hex) {
    id += String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16));
  }
  return id;
}

console.log(extensionIdFromPublicKey(manifest.key));
