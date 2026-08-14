/**
 * Minimal ambient types for the `diff` package (v7.0.0), which ships no
 * bundled .d.ts and whose @types/diff entry is a no-op stub (assumes a
 * newer diff version that bundles its own types). Covers only the API
 * surface this repo actually calls.
 */
declare module 'diff' {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }

  export function diffLines(oldStr: string, newStr: string): Change[];
}
