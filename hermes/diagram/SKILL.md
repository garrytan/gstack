---
name: diagram
description: Use when turn an english description (or mermaid source) into a diagram triplet: the source, an editable . (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/diagram/SKILL.md
---
## When to Use

The SVG/PNG use clean mermaid style; the
.excalidraw carries the hand-drawn aesthetic. Fully offline.
Use when asked to "make a diagram", "draw the architecture", "create a
flowchart", "diagram this", or "visualize this flow".

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

Direct, concrete, builder-to-builder. Name the file, function, command, and user-visible impact. No filler.

No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted. Never corporate or academic. Short paragraphs. End with what to do.

The user has context you do not. Cross-model agreement is a recommendation, not a decision. The user decides.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## Step 1 — Author the diagram

Write mermaid for the user's request. Rules:

- **Flowcharts (`graph LR`/`graph TD`)** are the sweet spot: they convert to a
  fully editable excalidraw scene. Prefer `graph LR` for pipelines/flows,
  `graph TD` for hierarchies.
- Sequence, state, gantt, and other mermaid types render to SVG/PNG fine, but
  the official converter only supports flowcharts — for those types the
  `.excalidraw` artifact is skipped and you MUST tell the user:
  "sequence diagrams render but aren't excalidraw-editable yet (upstream
  converter limitation — flowcharts are)."
- Keep node labels short; put detail in edge labels. 5-15 nodes is the
  readable range. If the user's ask needs more, split into multiple diagrams
  and say why.

Decide the output directory: `./diagrams/` when the cwd is a git repo
(artifacts the user can commit), else `/tmp/gstack-diagrams/`. Derive
`<slug>` from the diagram's subject (kebab-case, ≤40 chars).

## Step 2 — Stage the render bundle (once per session)

The staged copy is content-addressed (same convention as make-pdf's pre-pass),
so concurrent sessions and mixed gstack versions never clobber each other:

```bash
BUNDLE=""
for c in "$HOME/.hermes/skills/gstack/lib/diagram-render/dist/diagram-render.html" \
         "$(git rev-parse --show-toplevel 2>/dev/null)/lib/diagram-render/dist/diagram-render.html"; do
  [ -f "$c" ] && BUNDLE="$c" && break
done
[ -z "$BUNDLE" ] && echo "BUNDLE_MISSING — run: cd ~/.hermes/skills/gstack && bun run build:diagram-render" && exit 1
SHA=$(shasum -a 256 "$BUNDLE" | cut -c1-16)
STAGED="/tmp/gstack-diagram-render-$SHA.html"
[ -f "$STAGED" ] && shasum -a 256 "$STAGED" | grep -q "^$SHA" || { cp "$BUNDLE" "$STAGED.$$" && mv "$STAGED.$$" "$STAGED"; }
TAB=$(terminal newtab --json | sed -n 's/.*"tabId":\s*\([0-9]*\).*/\1/p')
[ -z "$TAB" ] && echo "TAB_OPEN_FAILED — daemon busy? check browse status" && exit 1
terminal load-html "$STAGED" --tab-id "$TAB"
terminal wait '#done' --tab-id "$TAB"
echo "RENDER_TAB_READY: tab $TAB"
```

Remember `$TAB` — **every** `terminal js` / `terminal wait` / `terminal closetab` below MUST pass
`--tab-id $TAB`. Without it, calls hit whatever tab is active, which may be a
live /qa or /scrape session sharing the daemon.

If `BUNDLE_MISSING`: stop and show the user the build command. Do not improvise
a CDN fallback — offline is the contract.

## Step 3 — Render the triplet

Write the mermaid source to `<outdir>/<slug>.mmd` first (Write tool). The page
cannot read files itself, so ship the source in via **base64** — never splice
file contents into a JS template literal (backticks, `${`, and backslashes in
the source would be interpreted and corrupt it):

```bash
# SVG (always). atob() decodes the base64 inside the page.
terminal js --tab-id "$TAB" "window.__renderMermaid('diagram-1', atob('$(base64 < <outdir>/<slug>.mmd | tr -d '\n')')).then(s => { window.__svg = s; return 'SVG OK ' + s.length })"
terminal js --tab-id "$TAB" "window.__svg" --out <outdir>/<slug>.svg

# PNG at 300dpi of a 6.5in placement (1950px)
terminal js --tab-id "$TAB" "window.__rasterize(window.__svg, 1950)" --out <outdir>/<slug>.png

# Editable scene (flowcharts only)
terminal js --tab-id "$TAB" "window.__mermaidToExcalidraw(atob('$(base64 < <outdir>/<slug>.mmd | tr -d '\n')')).then(j => { window.__scene = j; return 'SCENE OK ' + JSON.parse(j).elements.length + ' elements' })"
terminal js --tab-id "$TAB" "window.__scene" --out <outdir>/<slug>.excalidraw
```

Note: `atob()` yields Latin-1; for sources with non-ASCII labels use
`decodeURIComponent(escape(atob('…')))` to recover UTF-8 exactly.

If the mermaid render returns an error, show the parse error to the user, fix
the mermaid, and retry — do not hand the user a broken source file. If
`__mermaidToExcalidraw` fails on a non-flowchart type, skip the `.excalidraw`
artifact and deliver the rest with the limitation note from Step 1.

## Step 4 — Show and deliver

1. Read the PNG with the read_file tool so the user sees the diagram inline.
2. List the triplet paths.
3. One-line editability note: "The `.excalidraw` file opens at excalidraw.com
   (File → Open) — edit it there and I can re-render from the edited scene."
4. If the user wants changes, edit the `.mmd` source and re-run Step 3 — the
   source is the single source of truth.

Re-rendering an EDITED `.excalidraw` (user round-trip): load the scene file
and export without touching the mermaid — base64 transport again, since scene
JSON is full of quotes and backslashes:

```bash
terminal js --tab-id "$TAB" "window.__excalidrawToSvg(atob('$(base64 < <outdir>/<slug>.excalidraw | tr -d '\n')')).then(s => { window.__svg = s; return 'OK' })"
terminal js --tab-id "$TAB" "window.__svg" --out <outdir>/<slug>.svg
terminal js --tab-id "$TAB" "window.__rasterize(window.__svg, 1950)" --out <outdir>/<slug>.png
```

## Rules

- **Never ship the triplet without rendering it.** A `.mmd` file alone is not
  a diagram. If rendering is impossible (bundle missing, browse down), say so
  and stop.
- **Cleanup:** close the render tab when the conversation's diagram work is
  done (`terminal closetab $TAB`), not between diagrams.
- For diagrams destined for a PDF: remind the user that `make-pdf` renders
  ` ```mermaid ` fences natively — embedding the `.mmd` in their markdown is
  better than embedding the PNG.

## Completion status

- DONE — triplet (or SVG/PNG pair + limitation note) delivered and shown.
- BLOCKED — bundle or browse unavailable; build/setup command surfaced.
