---
name: hyperframes
preamble-tier: 2
version: 1.0.0
description: |
  HTML-to-video rendering: author video compositions as plain HTML files using
  data- attributes, then render to MP4 via Puppeteer + FFmpeg. Wraps the open-source
  HyperFrames framework (heygen-com/hyperframes) — write HTML, render video,
  built for agents. Requirements: Node.js >= 22, FFmpeg on PATH.
  Use when: "make a video", "render this as video", "create a video from HTML",
  "turn this into an MP4", "animate this design", "produce a reel". (gstack)
voice-triggers:
  - "make a video"
  - "render this as video"
  - "produce a reel"
triggers:
  - make a video
  - render this as video
  - create a video from html
  - produce a reel
  - animate this design
  - turn this into an mp4
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# /hyperframes: HTML-to-Video Renderer

You produce MP4 video files from HTML compositions using the open-source
[HyperFrames](https://github.com/heygen-com/hyperframes) framework by HeyGen.
HTML is the authoring format — standard elements with `data-` timing attributes.
No React, no special DSL. Deterministic: same input → same output. Built for AI agents.

---

## Requirements Check

Before any rendering work, verify the environment:

```bash
node --version       # must be >= 22
ffmpeg -version      # must be installed
npx hyperframes --version 2>/dev/null || echo "hyperframes not found"
```

If Node.js < 22 or FFmpeg is missing, inform the user and stop. Suggest:
- macOS: `brew install ffmpeg`
- Linux (apt): `sudo apt install ffmpeg`
- Node.js upgrade: `nvm install 22 && nvm use 22`

---

## Step 1: Gather Composition Intent

Ask or infer from context:
- **Content**: What elements go in the video? (text, images, video clips, audio)
- **Duration**: How long? (default: 10 seconds)
- **Resolution**: Width × Height? (default: 1920×1080)
- **Output file**: Where to save? (default: `output.mp4`)
- **Animations**: Any transitions or motion effects? (GSAP, CSS, Lottie)

---

## Step 2: Choose a Path

### A. New project from scratch

```bash
npx hyperframes init my-video
cd my-video
```

The scaffolded `index.html` contains a `#stage` div with the required attributes.
Populate it with timed elements following the composition format below.

### B. Edit an existing composition

The user points you to an existing HTML file — read it, understand the timing
layout, then make the requested changes.

### C. Quick one-off render

Write a composition HTML file directly (see format below) without scaffolding,
then render it immediately.

---

## Composition Format

A HyperFrames composition is a standard HTML file with a `#stage` root element:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; background: #000; }
    #stage {
      position: relative;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="stage"
       data-composition-id="my-video"
       data-width="1920"
       data-height="1080"
       data-fps="30"
       data-duration="10">

    <!-- Background video: plays full composition -->
    <video id="bg"
           data-start="0"
           data-duration="10"
           src="background.mp4"
           style="position:absolute; width:100%; height:100%;">
    </video>

    <!-- Text title: appears at t=1s for 4 seconds -->
    <h1 id="title"
        data-start="1"
        data-duration="4"
        style="position:absolute; top:400px; left:200px; color:#fff; font-size:80px; font-family:sans-serif;">
      Hello, World
    </h1>

    <!-- Logo: appears at t=5s for 3 seconds -->
    <img id="logo"
         data-start="5"
         data-duration="3"
         src="logo.png"
         style="position:absolute; bottom:80px; right:80px; width:200px;" />

    <!-- Background audio track -->
    <audio id="music"
           data-start="0"
           data-duration="10"
           src="music.wav">
    </audio>

  </div>
</body>
</html>
```

### Core `data-` attributes

| Attribute | Required | Description |
|---|---|---|
| `data-composition-id` | ✓ (stage) | Unique ID for this composition |
| `data-width` | ✓ (stage) | Canvas width in pixels |
| `data-height` | ✓ (stage) | Canvas height in pixels |
| `data-fps` | ✗ | Frames per second (default: 30) |
| `data-duration` | ✓ | Duration in seconds (stage = total; element = visibility window) |
| `data-start` | ✗ | When element appears, in seconds (default: 0) |
| `data-adapter` | ✗ | Animation adapter: `gsap`, `lottie`, `css`, `anime`, `three` |

---

## Step 3: Lint Before Render

Always run the linter before committing to a full render:

```bash
npx hyperframes lint index.html
```

Fix all errors. Warnings are informational.

---

## Step 4: Preview (Optional)

```bash
cd <project-dir>
npx hyperframes preview   # opens live browser preview on localhost
```

Recommend this for compositions > 10 seconds so the user can verify timing
before the full render.

---

## Step 5: Render

```bash
npx hyperframes render --input index.html --output output.mp4
```

Common flags:
- `--fps 30` — frame rate
- `--width 1920 --height 1080` — override canvas dimensions
- `--format mp4` — output format (mp4 is default)

Warn the user if rendering a composition > 60 seconds — it will take a while.

---

## Step 6: Report

After rendering completes, report:
- Output file path and file size
- Duration and resolution
- Any linter warnings from `npx hyperframes lint`

---

## Integration with Other Skills

- `/design-html` → `/hyperframes`: Build a static layout with design-html, then
  animate it into video with hyperframes.
- `/design-shotgun` → `/design-html` → `/hyperframes`: Full pipeline from concept
  to rendered video.
- `reels-html/`: The browser-based FFmpeg-WASM editor is an alternative for
  interactive editing. HyperFrames is the CLI/agent-native headless path.

> Run `bun run gen:skill-docs` to regenerate this file from `SKILL.md.tmpl`
> with the full shared preamble injected.
