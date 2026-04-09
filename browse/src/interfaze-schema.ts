/**
 * Build a Zod object schema from CLI --schema JSON hints:
 * { "name": "string", "price": "number", "ok": "boolean" }
 */

import { z } from 'zod';

const TYPE_ALIASES: Record<string, 'string' | 'number' | 'boolean'> = {
  string: 'string',
  str: 'string',
  text: 'string',
  number: 'number',
  num: 'number',
  float: 'number',
  int: 'number',
  integer: 'number',
  boolean: 'boolean',
  bool: 'boolean',
};

export function buildZodFromHints(hints: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(hints)) {
    const t = String(raw).toLowerCase().trim();
    const norm = TYPE_ALIASES[t] ?? 'string';
    if (norm === 'number') shape[key] = z.number();
    else if (norm === 'boolean') shape[key] = z.boolean();
    else shape[key] = z.string();
  }
  if (Object.keys(shape).length === 0) {
    throw new Error('Schema must be a non-empty JSON object, e.g. {"title":"string","count":"number"}');
  }
  return z.object(shape);
}

export function parseSchemaJson(jsonStr: string): z.ZodObject<Record<string, z.ZodTypeAny>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid JSON for --schema');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--schema must be a JSON object, e.g. {"field":"string"}');
  }
  return buildZodFromHints(parsed as Record<string, unknown>);
}
