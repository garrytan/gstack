/**
 * Command registry — single source of truth for all design commands.
 *
 * Dependency graph:
 *   commands.ts ──▶ cli.ts (runtime dispatch)
 *              ──▶ gen-skill-docs.ts (doc generation)
 *              ──▶ tests (validation)
 *
 * Zero side effects. Safe to import from build scripts and tests.
 */

export const COMMANDS = new Map<string, {
  description: string;
  usage: string;
  flags?: string[];
}>([
  ["generate", {
    description: "Generate a UI mockup from a design brief",
    usage: "generate --brief \"...\" --output /path.png [--check --retry N]  (never overwrites: bumps to /path-2.png; each --retry attempt is its own saved image; prints outputPath, attempts + run fields)",
    flags: ["--brief", "--brief-file", "--output", "--check", "--retry", "--size", "--quality"],
  }],
  ["variants", {
    description: "Generate N design variants from a brief, or one variant per entry of a briefs file",
    usage: "variants --brief \"...\" --count 3 --output-dir /path/ [--viewports desktop,tablet,mobile] | variants --briefs-file briefs.json --output-dir /path/  (never overwrites: variant-A.png bumps to variant-A-2.png; prints paths, errors + run fields. briefs.json: [{\"brief\": \"Calm dashboard...\"}, {\"brief\": \"Bolder header...\", \"screenshot\": \"current.png\"}], 1-7 entries; per-variant status, saved paths and check in variants[])",
    flags: ["--brief", "--brief-file", "--briefs-file", "--count", "--output-dir", "--size", "--quality", "--viewports"],
  }],
  ["iterate", {
    description: "Iterate on an existing mockup with feedback",
    usage: "iterate --session /path/session.json --feedback \"...\" --output /path.png  (never overwrites; prints outputPath + run fields)",
    flags: ["--session", "--feedback", "--output"],
  }],
  ["check", {
    description: "Vision-based quality check on a mockup",
    usage: "check --image /path.png --brief \"...\"",
    flags: ["--image", "--brief"],
  }],
  ["compare", {
    description: "Generate HTML comparison board for user review",
    usage: "compare --images-file /path/board-images.json | --images '[\"a.png\"]' | --images /path/*.png | --images a.png,b.png --output /path/board.html [--serve [--no-daemon] [--title \"...\"]]  (letters A, B, C follow list order)",
    flags: ["--images", "--images-file", "--output", "--serve", "--no-daemon", "--title", "--timeout"],
  }],
  ["diff", {
    description: "Visual diff between two mockups",
    usage: "diff --before old.png --after new.png",
    flags: ["--before", "--after", "--output"],
  }],
  ["evolve", {
    description: "Generate improved mockup from existing screenshot",
    usage: "evolve --screenshot current.png --brief \"make it calmer\" --output /path.png  (never overwrites; prints outputPath + run fields)",
    flags: ["--screenshot", "--brief", "--output"],
  }],
  ["verify", {
    description: "Compare live site screenshot against approved mockup",
    usage: "verify --mockup approved.png --screenshot live.png",
    flags: ["--mockup", "--screenshot", "--output"],
  }],
  ["prompt", {
    description: "Generate structured implementation prompt from approved mockup",
    usage: "prompt --image approved.png",
    flags: ["--image"],
  }],
  ["extract", {
    description: "Extract design language from approved mockup into DESIGN.md",
    usage: "extract --image approved.png",
    flags: ["--image"],
  }],
  ["gallery", {
    description: "Generate HTML timeline of all design explorations (oldest to newest; letters do not identify rounds)",
    usage: "gallery --designs-dir ~/.gstack/projects/$SLUG/designs/ --output /path/gallery.html",
    flags: ["--designs-dir", "--output"],
  }],
  ["serve", {
    description: "Serve comparison board over HTTP and collect user feedback",
    usage: "serve --html /path/board.html [--no-daemon] [--title \"...\"] [--timeout 600]",
    flags: ["--html", "--no-daemon", "--title", "--timeout"],
  }],
  ["daemon", {
    description: "Manage the persistent design board daemon (sub-commands: status, stop)",
    usage: "daemon status | daemon stop [--force]",
    flags: ["--force"],
  }],
  ["setup", {
    description: "Guided API key setup (OpenAI or Gemini) + smoke test",
    usage: "setup [--provider openai|gemini] [--key-stdin]",
    flags: ["--provider", "--key-stdin"],
  }],
]);

/**
 * The $D output contract: what each image command prints on stdout, its exit
 * codes, and which skills read it. Printed by `$D` usage.
 */
export const OUTPUT_CONTRACT = `Paid images are never overwritten. A taken name gets -2, -3 ... -999 appended to
its stem (x.png -> x-2.png, x-2.png -> x-2-2.png), stderr prints
"note: <requested> exists; saved to <actual> (existing file kept)", and the JSON
reports the actual path. Read paths from the JSON, never from a fixed file name.

Run fields printed by generate, iterate, evolve and variants (on every exit):
  requested  images requested          saved      every saved path, in order
  selected   outputPath or paths       failures   [{file, reason}] not saved
  recovered  [{path, reason}] private recovery copies in the temp dir

  command   extra fields                                     readers
  generate  outputPath sessionFile responseId checkResult    design-review, design-shotgun,
            attempts[{path, check}] (one per --retry try)     plan-design-review
  iterate   outputPath sessionFile responseId iteration      plan-design-review, design-consultation
  evolve    outputPath sourceScreenshot brief attempts       design-shotgun
  variants  outputDir count succeeded failed paths errors    office-hours, plan-design-review,
            viewports (--viewports only)                     design-consultation, design-shotgun
            validated variants[{variant, path, saved, status,
            check}] (--briefs-file only)
  compare   board HTML; --serve prints {id, url, sourceDir}   all board flows (--images-file)

Exit codes: 0 a selected result exists; 2 nothing was saved; 3 stopped after
saving at least one image but before its selected result (interrupted retry);
1 invalid flags rejected before any API call (no JSON).`;
