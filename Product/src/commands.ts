/**
 * Command registry for the drawing inspection CLI.
 */

export const COMMANDS = new Map<string, { description: string; usage: string }>([
  ["inspect", {
    description: "Run drawing inspection on a file",
    usage: "inspect --input <file> [--output <report.html>] [--provider claude|openai] [--config <checks.json>]",
  }],
  ["layout", {
    description: "Analyze drawing layout (regions only, no checks)",
    usage: "layout --input <file> [--output <annotated.png>] [--provider claude|openai]",
  }],
  ["classify", {
    description: "Classify part from drawing",
    usage: "classify --input <file> [--provider claude|openai]",
  }],
  ["list-checks", {
    description: "List all configured check items",
    usage: "list-checks [--config <checks.json>]",
  }],
  ["setup", {
    description: "Configure API keys",
    usage: "setup",
  }],
]);
