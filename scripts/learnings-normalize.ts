const VALID_TYPES = new Set(['pattern', 'pitfall', 'preference', 'architecture', 'tool', 'operational']);

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function slugifyLearningsKey(value: unknown): string {
  return getString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function normalizeLearningsType(entry: Record<string, unknown>): string {
  const directType = getString(entry.type).toLowerCase();
  if (VALID_TYPES.has(directType)) return directType;

  const category = getString(entry.category).toLowerCase();
  if (!category) return '';

  const tokens = category.split(/[^a-z0-9]+/).filter(Boolean);

  if (tokens.includes('pitfall') || tokens.includes('gotcha') || tokens.includes('trap')) return 'pitfall';
  if (tokens.includes('architecture') || tokens.includes('architectural') || tokens.includes('arch')) return 'architecture';
  if (tokens.includes('preference') || tokens.includes('pref')) return 'preference';
  if (tokens.includes('pattern')) return 'pattern';
  if (tokens.includes('operational') || tokens.includes('workflow') || tokens.includes('process') || tokens.includes('ops')) return 'operational';
  if (tokens.includes('tool')) return 'tool';

  for (const token of tokens) {
    if (VALID_TYPES.has(token)) return token;
  }

  return '';
}

export function normalizeLearningsEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  const type = normalizeLearningsType(entry);
  const insight = getString(entry.insight) || getString(entry.detail) || getString(entry.summary);
  const key = getString(entry.key) || slugifyLearningsKey(entry.summary);

  if (!type || !key || !insight) return null;

  return {
    ...entry,
    type,
    key,
    insight,
    confidence: getNumber(entry.confidence) ?? 5,
    skill: getString(entry.skill) || 'learn',
  };
}
