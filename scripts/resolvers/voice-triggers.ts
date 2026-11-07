/**
 * Voice triggers: speech-to-text aliases a template lists under
 * `voice-triggers:` in its frontmatter.
 *
 * Every host folds them into the skill's description, but Claude's catalog trim
 * keeps only the lead sentence. {{VOICE_TRIGGER_ROUTING}} gives them a cheap home
 * in the root router's routing block instead: one routing line per skill.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from './types';
import { discoverTemplates, includesSkill, RETIRED_SKILLS } from '../discover-skills';
import { getHostConfig } from '../../hosts/index';

const ROOT = path.resolve(import.meta.dir, '..', '..');

/**
 * Extract voice-triggers YAML list from frontmatter.
 * Returns an array of trigger strings, or [] if no voice-triggers field.
 */
export function extractVoiceTriggers(content: string): string[] {
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return [];
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return [];
  const frontmatter = content.slice(fmStart + 4, fmEnd);

  const triggers: string[] = [];
  let inVoice = false;
  for (const line of frontmatter.split('\n')) {
    if (/^voice-triggers:/.test(line)) { inVoice = true; continue; }
    if (inVoice) {
      const m = line.match(/^\s+-\s+"(.+)"$/);
      if (m) triggers.push(m[1]);
      else if (!/^\s/.test(line)) break;
    }
  }
  return triggers;
}

/**
 * Claude only: other hosts keep the voice triggers in each skill's description.
 * The template places this at the end of the last routing line, so each line
 * starts with its own newline and an empty result leaves the list unchanged.
 */
export function generateVoiceTriggerRouting(ctx: TemplateContext): string {
  if (ctx.host !== 'claude') return '';
  const hostConfig = getHostConfig(ctx.host);
  let out = '';
  // Sorted so the render doesn't depend on filesystem iteration order.
  const skillDirs = discoverTemplates(ROOT).map(t => path.dirname(t.tmpl)).sort();
  for (const skillDir of skillDirs) {
    if (skillDir === '.' || RETIRED_SKILLS.includes(skillDir) || !includesSkill(hostConfig, skillDir)) continue;
    const content = fs.readFileSync(path.join(ROOT, skillDir, 'SKILL.md.tmpl'), 'utf-8').replace(/\r\n/g, '\n');
    const triggers = extractVoiceTriggers(content);
    if (triggers.length === 0) continue;
    out += `\n- Voice trigger ${triggers.map(t => `"${t}"`).join(', ')} → invoke \`/${skillDir}\``;
  }
  return out;
}
