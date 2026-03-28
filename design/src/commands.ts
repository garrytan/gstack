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
    usage: "generate --brief \"...\" --output /path.png",
    flags: ["--brief", "--brief-file", "--output", "--check", "--retry", "--size", "--quality"],
  }],
  ["variants", {
    description: "Generate N design variants from a brief",
    usage: "variants --brief \"...\" --count 3 --output-dir /path/",
    flags: ["--brief", "--brief-file", "--count", "--output-dir", "--size", "--quality", "--viewports"],
  }],
  ["iterate", {
    description: "Iterate on an existing mockup with feedback",
    usage: "iterate --session /path/session.json --feedback \"...\" --output /path.png",
    flags: ["--session", "--feedback", "--output"],
  }],
  ["check", {
    description: "Vision-based quality check on a mockup",
    usage: "check --image /path.png --brief \"...\"",
    flags: ["--image", "--brief"],
  }],
  ["compare", {
    description: "Generate HTML comparison board for user review",
    usage: "compare --images /path/*.png --output /path/board.html [--serve]",
    flags: ["--images", "--output", "--serve", "--timeout"],
  }],
  ["diff", {
    description: "Visual diff between two mockups",
    usage: "diff --before old.png --after new.png",
    flags: ["--before", "--after", "--output"],
  }],
  ["evolve", {
    description: "Generate improved mockup from existing screenshot",
    usage: "evolve --screenshot current.png --brief \"make it calmer\" --output /path.png",
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
    description: "Generate HTML timeline of all design explorations for a project",
    usage: "gallery --designs-dir ~/.gstack/projects/$SLUG/designs/ --output /path/gallery.html",
    flags: ["--designs-dir", "--output"],
  }],
  ["serve", {
    description: "Serve comparison board over HTTP and collect user feedback",
    usage: "serve --html /path/board.html [--timeout 600]",
    flags: ["--html", "--timeout"],
  }],
  ["setup", {
    description: "Guided API key setup + smoke test",
    usage: "setup",
    flags: [],
  }],
]);
