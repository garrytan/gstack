/**
 * Render a string as a YAML inline scalar value (the text after `key: `),
 * quoting only when a plain scalar would be invalid or ambiguous.
 *
 * The bug this guards (#1778): a description like "Ship workflow: detect..."
 * emitted as a plain scalar has an interior ": " that a strict YAML parser
 * (Codex/OpenAI skill loading) reads as a nested mapping and rejects with
 * "mapping values are not allowed in this context". When quoting is needed we
 * fall back to JSON.stringify, which produces a double-quoted scalar that YAML
 * accepts verbatim (YAML is a superset of JSON for flow scalars). Strings that
 * are already valid plain scalars pass through unchanged to keep regen diffs small.
 *
 * Every writer of generated frontmatter goes through here: the doc generator
 * (scripts/gen-skill-docs.ts) and the harness renderer (lib/harness-register.ts,
 * whose router description carries a colon and is read by harnesses that parse
 * frontmatter with a strict YAML loader, e.g. Pi).
 */
export function toYamlInlineScalar(s: string): string {
  const needsQuote =
    s.length === 0 ||
    s !== s.trim() ||                       // leading/trailing whitespace
    /:(\s|$)/.test(s) ||                    // "foo: bar" / trailing colon → mapping ambiguity
    /\s#/.test(s) ||                        // " #" → inline comment
    /\.\.\./.test(s) ||                     // "..." → document-end marker; strict parsers reject mid-scalar (catalog-trim truncation appends it)
    /^[\s>|&*!%@`"'#,\[\]{}?-]/.test(s);    // leading YAML indicator char
  return needsQuote ? JSON.stringify(s) : s;
}
