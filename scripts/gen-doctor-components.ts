#!/usr/bin/env bun
/**
 * Generate bin/gstack-doctor-components.sh — the Bash render of the doctor's
 * component table (lib/doctor-components.ts) and result-code anchors
 * (lib/result-codes.ts). The doctor must report with Bun absent, so the table
 * ships as a committed sourced file, refreshed from scripts/gen-skill-docs.ts
 * and checked for freshness by test/doctor-components.test.ts, the way the
 * agents digest is.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderDoctorComponentsSh } from '../lib/doctor-components';

const ROOT = path.resolve(import.meta.dir, '..');
export const DOCTOR_COMPONENTS_RELPATH = 'bin/gstack-doctor-components.sh';

export function writeDoctorComponentsSh(opts?: { outRoot?: string }): { outPath: string; bytes: number } {
  const content = renderDoctorComponentsSh();
  const outPath = path.join(opts?.outRoot ?? ROOT, DOCTOR_COMPONENTS_RELPATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  return { outPath, bytes: Buffer.byteLength(content, 'utf-8') };
}

if (import.meta.main) {
  const { outPath, bytes } = writeDoctorComponentsSh();
  console.log(`[gen-doctor-components] ${path.relative(ROOT, outPath)}: ${bytes} bytes`);
}
