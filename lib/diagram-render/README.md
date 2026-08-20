# diagram-render

Offline diagram rendering for make-pdf and /diagram. One self-contained HTML
page (`dist/diagram-render.html`, ~9MB) bundles mermaid, the excalidraw export
utilities, and the official mermaid→excalidraw converter. The browse daemon
loads it with `load-html`; callers drive it through `browse js` and pull bytes
back with `js --out`.

The built page is **committed** (eng-review D2): rendering works with zero
network at install time and render time, and there is no npm supply-chain
surface in `./setup`. The drift test (`test/diagram-render-drift.test.ts`)
fails CI if `dist/` is edited by hand or falls out of sync with `BUILD_INFO.json`.

## Page API (window functions)

| Function | In → Out |
|---|---|
| `__renderMermaid(id, text)` | mermaid text → SVG string. `id` must be unique per fence (`mermaid-fence-<n>`) — it namespaces every internal SVG id. |
| `__mermaidToExcalidraw(text)` | mermaid text → `.excalidraw` scene JSON (flowcharts fully; other types degrade upstream). |
| `__excalidrawToSvg(sceneJson)` | scene JSON → SVG string (Excalifont embedded, offline). |
| `__rasterize(svg, targetWidthPx)` | SVG → PNG data URL. Callers own DPI math: `targetWidthPx = placed width (in) × 300`. Throws on tainted canvas. |
| `__downscaleRaster(dataUri, targetWidthPx, mime)` | raster data URI → smaller data URI at `targetWidthPx` (same mime). make-pdf uses it to normalize oversized photos to print resolution. |
| `__mountForScreenshot(svg, px)` | taint-proof fallback: mounts SVG at `#raster-stage` for `browse screenshot --selector`. |
| `__probeImage(src)` | data URI/URL → `{width, height}` JSON. |
| `__bundleInfo` | `{ name, deps }` — pinned dependency versions baked at build. |

Readiness: poll until `#status` text is `ready` (or `browse wait '#done'`).
Page errors accumulate in `window.__errors`.

## Updating

```bash
# 1. edit the exact pin in package.json
cd lib/diagram-render && bun install
# 2. rebuild (deterministic; build twice → same sha)
bun run build
# 3. commit package.json + bun.lock + dist/ together
```

Render contract details (securityLevel strict, htmlLabels false, print-css font
lock, `<base href>` + `</scri` escaping) are documented in `src/entry.ts` and
`scripts/build.ts` — read both before touching either.
