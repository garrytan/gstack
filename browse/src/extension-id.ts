/**
 * The one extension origin allowed to reach browse's local control surfaces:
 * POST /extension-token on the server and the terminal agent's /ws.
 *
 * GSTACK_EXTENSION_ID is derived from the "key" field in
 * extension/manifest.json (first 16 bytes of SHA-256 of the DER public key,
 * hex nibbles mapped 0-9a-f → a-p). Reproduce with:
 *   bun browse/scripts/extension-id.ts
 * If the manifest keypair is ever rotated, update this constant in the same
 * commit.
 *
 * Forks and self-built extensions override it with
 * `gstack-config set browse_extension_id <id>`. There is deliberately no
 * environment override: a project's .env must never be able to widen it.
 */
import { readGstackConfigYamlKey } from './config';

export const GSTACK_EXTENSION_ID = 'dgbkdbjebeiblbajiilljmhjdpmiglep';

/** `chrome-extension://<id>` for the pinned or configured extension. */
export function allowedExtensionOrigin(): string {
  const configured = readGstackConfigYamlKey('browse_extension_id');
  const id = configured && /^[a-p]{32}$/.test(configured) ? configured : GSTACK_EXTENSION_ID;
  return `chrome-extension://${id}`;
}
