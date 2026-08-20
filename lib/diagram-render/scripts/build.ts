/**
 * Build dist/diagram-render.html — the single-file offline render page.
 *
 * One command updates everything: `bun run build` (in this directory) or
 * `bun run build:diagram-render` (repo root). To bump a dependency: edit the
 * exact pin in package.json, `bun install`, rebuild, commit src + dist +
 * BUILD_INFO.json together. The drift test (test/diagram-render-drift.test.ts)
 * fails CI when dist and BUILD_INFO disagree.
 *
 * Page assembly notes (learned in the spike, do not "simplify" away):
 *  - The script MUST be `type="module"` — mermaid's bundle contains
 *    import.meta, which throws in a classic script.
 *  - `</scri` sequences inside the minified JS MUST be escaped to `<\/scri`,
 *    or the inline <script> terminates early ("Unexpected end of input").
 *  - A <base href> with an absolute URL is required: the page lives at
 *    about:blank (page.setContent), where relative URL construction throws.
 */
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = path.join(ROOT, "src", "entry.ts");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_HTML = path.join(DIST_DIR, "diagram-render.html");
const BUILD_INFO = path.join(DIST_DIR, "BUILD_INFO.json");

const pkg = await Bun.file(path.join(ROOT, "package.json")).json();
const deps: Record<string, string> = pkg.dependencies;

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  minify: true,
  define: {
    __BUNDLE_INFO_DEPS__: JSON.stringify(deps),
    "process.env.NODE_ENV": '"production"',
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const js = await result.outputs[0].text();

// Escape inline-script terminators (see header note).
const inlineJs = js.replaceAll("</scri", "<\\/scri");

const head = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base href="https://gstack-render.localhost/">
<title>gstack diagram-render</title>
<style>
  body { font-family: Helvetica, "Liberation Sans", Arial, sans-serif; margin: 0; }
</style>
<script>
window.__errors = [];
window.onerror = function (msg, src, line, col, err) {
  window.__errors.push(String(msg) + " @" + line + ":" + col);
};
window.addEventListener("unhandledrejection", function (e) {
  window.__errors.push("unhandledrejection: " + String(e.reason).slice(0, 500));
});
</script>
</head>
<body>
<div id="status">loading</div>
<script type="module">
`;
const tail = `
</script>
</body>
</html>
`;

const html = head + inlineJs + tail;
await Bun.write(DIST_HTML, html);

const sha256 = createHash("sha256").update(html).digest("hex");
// Source fingerprint: lets the drift test catch "edited src, forgot to
// rebuild dist" WITHOUT needing node_modules for a full rebuild (the deep
// rebuild check only runs where deps are installed).
const srcSha256 = createHash("sha256")
  .update(await Bun.file(ENTRY).text())
  .update(await Bun.file(import.meta.path).text())
  .digest("hex");
const info = {
  name: "gstack-diagram-render",
  sha256,
  srcSha256,
  bytes: Buffer.byteLength(html),
  bunVersion: Bun.version,
  deps,
};
await Bun.write(BUILD_INFO, JSON.stringify(info, null, 2) + "\n");

console.log(`built ${path.relative(process.cwd(), DIST_HTML)} (${(info.bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`sha256 ${sha256}`);
