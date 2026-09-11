export interface StrictYamlLimits {
  maxBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxScalarLength?: number;
  maxSequenceLength?: number;
  maxMapSize?: number;
}

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from 'yaml';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STANDARD_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
]);

export const DEFAULT_STRICT_YAML_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxNodes: 20_000,
  maxDepth: 32,
  maxScalarLength: 16 * 1024,
  maxSequenceLength: 4_096,
  maxMapSize: 4_096,
});

function fail(code: string): never {
  throw new Error(code);
}

export function parseStrictYaml(source: string, requested: StrictYamlLimits = {}): unknown {
  const limits = { ...DEFAULT_STRICT_YAML_LIMITS, ...requested };
  if (new TextEncoder().encode(source).byteLength > limits.maxBytes) fail('yaml_byte_limit');
  const documents = parseAllDocuments(source, {
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    maxAliasCount: 0,
    keepSourceTokens: true,
    prettyErrors: false,
  });
  if (documents.length !== 1) fail('yaml_document_count');
  const document = documents[0];
  if (document.errors.length) fail(`yaml_parse_error:${document.errors[0].code}`);
  if (document.warnings.length) fail(`yaml_warning:${document.warnings[0].code}`);
  if (document.directives.yaml.explicit || Object.keys(document.directives.tags).some((key) => key !== '!!')) {
    fail('yaml_directive_forbidden');
  }
  if (!document.contents) fail('yaml_empty_document');

  let nodes = 0;
  const convert = (node: Node, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) fail('yaml_node_limit');
    if (depth > limits.maxDepth) fail('yaml_depth_limit');
    if (isAlias(node)) fail('yaml_alias_forbidden');
    if ('anchor' in node && node.anchor) fail('yaml_anchor_forbidden');
    if ('tag' in node && node.tag && !STANDARD_TAGS.has(node.tag)) fail('yaml_tag_forbidden');

    if (isScalar(node)) {
      const value = node.value;
      if (typeof value === 'number' && !Number.isFinite(value)) fail('yaml_number_invalid');
      if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) fail('yaml_scalar_type_invalid');
      if (typeof value === 'string' && new TextEncoder().encode(value).byteLength > limits.maxScalarLength) {
        fail('yaml_scalar_limit');
      }
      return value;
    }
    if (isSeq(node)) {
      if (node.items.length > limits.maxSequenceLength) fail('yaml_sequence_limit');
      return node.items.map((item) => item === null ? null : convert(item as Node, depth + 1));
    }
    if (isMap(node)) {
      if (node.items.length > limits.maxMapSize) fail('yaml_map_limit');
      const output = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      for (const pair of node.items) {
        nodes += 2; // The CST pair and its scalar key are authority-bearing nodes too.
        if (nodes > limits.maxNodes) fail('yaml_node_limit');
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('yaml_key_not_string');
        const key = pair.key.value;
        if (DANGEROUS_KEYS.has(key)) fail('yaml_key_forbidden');
        if (key === '<<') fail('yaml_merge_forbidden');
        if (seen.has(key)) fail('yaml_duplicate_key');
        seen.add(key);
        output[key] = pair.value === null ? null : convert(pair.value as Node, depth + 1);
      }
      return output;
    }
    fail('yaml_node_unsupported');
  };
  return convert(document.contents as Node, 1);
}
