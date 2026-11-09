#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * check-doc-links — the docs lane's link check (lib/doc-links.ts; docs/pregate.md#docs-only).
 *   bun scripts/check-doc-links.ts [--base <ref>] <file.md>...
 * With --base, only links on lines added since <ref> (diffed against the working tree) are checked, so a docs edit is
 * not blocked by an older broken link it did not touch. Prints DOC_LINKS: ok (<n> file(s)) and exits 0, or one line per
 * broken link and DOC_LINKS: broken <n> and exits 1; a git failure prints DOC_LINKS: error and exits 2.
 */
import { addedLines, brokenLinks } from '../lib/doc-links';

const args = process.argv.slice(2);
const at = args.indexOf('--base');
const base = at >= 0 ? args[at + 1] : undefined;
const files = args.filter((a, i) => (at < 0 || (i !== at && i !== at + 1)) && /\.md$/i.test(a));
let added: Map<string, Set<number>> | undefined;
try { added = base ? addedLines(process.cwd(), base, files) : undefined; }
catch (e) { console.log(`DOC_LINKS: error (${(e as Error).message})`); process.exit(2); }
const broken = brokenLinks(process.cwd(), files, added);
for (const b of broken) console.log(`${b.file}:${b.line}: ${b.target}: ${b.reason}; fix: correct the link or add the heading it names`);
console.log(broken.length ? `DOC_LINKS: broken ${broken.length}` : `DOC_LINKS: ok (${files.length} file(s))`);
process.exit(broken.length ? 1 : 0);
