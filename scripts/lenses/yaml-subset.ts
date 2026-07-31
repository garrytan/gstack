/**
 * Minimal YAML subset parser for gstack lens metadata and project policy files.
 *
 * Supported syntax:
 * - mappings by indentation
 * - scalar sequences (`- value`)
 * - inline arrays (`[a, "b", c]`)
 * - quoted and unquoted strings, booleans, numbers, and null
 *
 * Deliberately unsupported:
 * - anchors, aliases, tags, block scalars, flow mappings, and multi-document YAML
 *
 * The lens contract does not need the full YAML language. Keeping the parser
 * constrained makes the accepted configuration surface explicit and testable.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
export type YamlObject = { [key: string]: YamlValue };

interface ParsedLine {
  indent: number;
  text: string;
  line: number;
}

function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function splitInlineArray(input: string): string[] {
  const values: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      values.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  values.push(input.slice(start).trim());
  return values.filter((value) => value.length > 0);
}

function parseQuoted(input: string): string {
  if (input.startsWith('"')) {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new Error(`Invalid double-quoted YAML string: ${input} (${String(error)})`);
    }
  }
  return input.slice(1, -1).replace(/''/g, "'");
}

export function parseYamlScalar(input: string): YamlValue {
  const value = input.trim();
  if (value === '') return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return parseQuoted(value);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInlineArray(value.slice(1, -1)).map(parseYamlScalar);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function tokenize(input: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  input.split(/\r?\n/).forEach((raw, index) => {
    if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) {
      throw new Error(`Tabs are not allowed for YAML indentation (line ${index + 1})`);
    }
    const noComment = stripComment(raw);
    if (noComment.trim() === '') return;
    const indent = noComment.length - noComment.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`YAML indentation must use multiples of two spaces (line ${index + 1})`);
    }
    lines.push({ indent, text: noComment.trim(), line: index + 1 });
  });
  return lines;
}

function parseSequence(lines: ParsedLine[], start: number, indent: number): [YamlValue[], number] {
  const result: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith('-')) break;
    const rest = line.text.slice(1).trim();
    if (rest === '') {
      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        result.push(null);
        index += 1;
      } else {
        const [child, nextIndex] = parseBlock(lines, index + 1, next.indent);
        result.push(child);
        index = nextIndex;
      }
      continue;
    }
    // The lens configuration intentionally represents structured trigger entries
    // as strings such as `pr_label=privileged-surface`. Reject sequence mappings
    // rather than silently accepting a YAML shape the runtime cannot validate.
    if (/^[A-Za-z0-9_.-]+:\s*/.test(rest)) {
      throw new Error(`Sequence mappings are not supported by the lens YAML subset (line ${line.line})`);
    }
    result.push(parseYamlScalar(rest));
    index += 1;
  }
  return [result, index];
}

function parseMapping(lines: ParsedLine[], start: number, indent: number): [YamlObject, number] {
  const result: YamlObject = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      throw new Error(`Unexpected indentation at line ${line.line}`);
    }
    if (line.text.startsWith('-')) break;
    const match = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    if (!match) throw new Error(`Invalid YAML mapping at line ${line.line}: ${line.text}`);
    const [, key, rest] = match;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`Duplicate YAML key '${key}' at line ${line.line}`);
    }
    if (rest !== undefined) {
      result[key] = parseYamlScalar(rest);
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      result[key] = {};
      index += 1;
      continue;
    }
    const [child, nextIndex] = parseBlock(lines, index + 1, next.indent);
    result[key] = child;
    index = nextIndex;
  }
  return [result, index];
}

function parseBlock(lines: ParsedLine[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [{}, start];
  const first = lines[start];
  if (first.indent !== indent) {
    throw new Error(`Expected indentation ${indent}, found ${first.indent} at line ${first.line}`);
  }
  return first.text.startsWith('-')
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

export function parseYamlSubset(input: string): YamlObject {
  const lines = tokenize(input);
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new Error(`Top-level YAML must start at column 1 (line ${lines[0].line})`);
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    throw new Error(`Could not parse YAML at line ${lines[next].line}`);
  }
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    throw new Error('Top-level YAML must be a mapping');
  }
  return value as YamlObject;
}

export interface FrontmatterDocument {
  frontmatter: YamlObject;
  body: string;
}

export function parseFrontmatterDocument(content: string): FrontmatterDocument {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    throw new Error('Lens file must begin with YAML frontmatter');
  }
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Lens file frontmatter is missing a closing --- marker');
  return {
    frontmatter: parseYamlSubset(normalized.slice(4, end)),
    body: normalized.slice(end + 5).trim(),
  };
}
