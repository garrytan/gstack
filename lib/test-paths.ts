/**
 * Test file arguments for `bun test`. Bun reads a bare relative path as a name filter, and that filter's search skips
 * hidden folders, so `bun test .github/scripts/x.test.mjs` finds nothing and exits 1 (GST-2640, Bun 1.4.4). A path that
 * starts with `./`, `../` or `/` is read as a path. Bun still drops a missing path from a run of several files without
 * an error, so a caller rejects a missing file before Bun runs.
 */

/** A command that runs `bun test` as a whole command word, with or without Bun's own flags before `test`. */
export const BUN_TEST = /(?:^|[\s;&|(])bun(?:\s+--?[\w-]+(?:=\S+)?)*\s+test\b/;

/** `file` as a path Bun reads as a path: `./` added unless it already starts with `./`, `../` or `/`. */
export const explicitPath = (file: string): string => (/^\.{0,2}\//.test(file) ? file : `./${file}`);

/** The file arguments for `command`: explicit paths when it runs `bun test`, the files unchanged for any other runner. */
export const testFileArgs = (command: string, files: readonly string[]): string[] => (BUN_TEST.test(command) ? files.map(explicitPath) : [...files]);
