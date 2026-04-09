/**
 * Interfaze API key resolution (OCR, search, ai-scrape).
 *
 * Resolution order:
 * 1. ~/.gstack/interfaze.json → { "api_key": "..." }
 * 2. INTERFAZE_API_KEY environment variable
 * 3. null (commands return setup instructions)
 */

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.env.HOME || '~', '.gstack', 'interfaze.json');

export function resolveInterfazeKey(): string | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(content) as { api_key?: string };
      if (config.api_key && typeof config.api_key === 'string' && config.api_key.trim()) {
        return config.api_key.trim();
      }
    }
  } catch {
    // fall through
  }

  if (process.env.INTERFAZE_API_KEY?.trim()) {
    return process.env.INTERFAZE_API_KEY.trim();
  }

  return null;
}

export function saveInterfazeKey(key: string): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export function interfazeSetupHint(command: string): string {
  return (
    `${command} requires an Interfaze API key.\n\n` +
    `Run: $B interfaze-setup\n` +
    `  or save to ~/.gstack/interfaze.json: { "api_key": "..." }\n` +
    `  or set INTERFAZE_API_KEY environment variable\n\n` +
    `Get a key at: https://interfaze.ai/dashboard\n` +
    `Docs: https://interfaze.ai/docs`
  );
}
