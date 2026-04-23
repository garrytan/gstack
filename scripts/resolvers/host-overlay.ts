/**
 * Host overlay resolver — reads host-overlays/{host}.md (or the path declared
 * by the host config) and injects host-runtime guidance into every skill.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHostConfig } from '../../hosts/index';
import type { TemplateContext } from './types';

const ROOT = path.resolve(import.meta.dir, '../..');

export function generateHostOverlay(ctx: TemplateContext): string {
  const hostConfig = getHostConfig(ctx.host);
  const overlayPath = hostConfig.hostOverlay || `host-overlays/${ctx.host}.md`;
  const filePath = path.join(ROOT, overlayPath);

  if (!fs.existsSync(filePath)) return '';

  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return '';

  return `## Host Runtime Patch (${hostConfig.displayName})

The following instructions adapt this generated skill to the ${hostConfig.displayName}
runtime. They are host-specific compatibility rules. If older template wording
mentions another agent host or another tool name, follow this section's mapping.

${content}`;
}
