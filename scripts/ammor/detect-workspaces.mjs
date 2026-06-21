#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function hasAnyMarker(candidatePath, markers) {
  return markers.some((marker) => {
    const candidate = path.join(candidatePath, marker);
    return fs.existsSync(candidate);
  });
}

function isLikelyWorkspaceDir(candidatePath) {
  const normalized = candidatePath.replace(/\\/g, "/");
  if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isDirectory()) {
    return { match: false, reasons: ["not a directory"] };
  }

  const ignore = ["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".cache"];
  const base = path.basename(candidatePath);
  if (ignore.includes(base)) {
    return { match: false, reasons: ["ignored workspace"] };
  }

  const markers = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "apps",
    "src",
    "public",
    "pages",
    "app",
    "components",
    "README.md",
  ];

  const strongSignals = ["package.json", "vite.config", "next.config", "playwright.config", "tsconfig.json"];

  const hasPackage = fs.existsSync(path.join(candidatePath, "package.json"));
  const hasSource = hasAnyMarker(candidatePath, ["src", "app", "pages", "components"]);
  const hasWebManifest = hasAnyMarker(candidatePath, ["public", "static", "assets"]);
  const hasStrongSignal = hasAnyMarker(candidatePath, strongSignals);
  const hasAMMORHint = /ammor|fraud|claims|cases|evidence|gov|government|insurance|portal|dashboard/i.test(normalized);

  const match = hasPackage || (hasSource && (hasStrongSignal || hasWebManifest || hasAMMORHint));
  return {
    match,
    reasons: {
      hasPackage,
      hasSource,
      hasWebManifest,
      hasStrongSignal,
      hasAMMORHint,
    },
  };
}

function detectPaths() {
  const candidates = new Set([
    "apps",
    "app",
    "web",
    "frontend",
    "portal",
    "gov-portal",
    "government-portal",
    "insurance-portal",
    "dashboard",
    "client",
    "ui",
    "packages",
    "services",
    "server",
    "api",
    "src/app",
    "src/web",
    "src/ui",
    "src/portal",
  ]);

  const expanded = new Set();
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (!fs.existsSync(absolute)) continue;

    const stat = fs.statSync(absolute);
    if (stat.isDirectory() && candidate.indexOf("/") === -1) {
      const entries = fs.readdirSync(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(absolute, entry.name);
        if (/^\.|__tests?$|dist|build|node_modules$/i.test(entry.name)) continue;
        expanded.add(child);
      }
    }

    expanded.add(absolute);
  }

  const matches = [];
  for (const candidatePath of expanded) {
    const result = isLikelyWorkspaceDir(candidatePath);
    if (!result.match) continue;

    const relative = path.relative(root, candidatePath).replace(/\\/g, "/");
    const label = path.basename(candidatePath).toLowerCase();
    const priorityHint =
      /ammor|fraud|claims|cases/i.test(label) ? "critical" :
      /government|gov|public|portal/i.test(label) ? "high" :
      /insurance/i.test(label) ? "high" :
      /dashboard|ui|client|frontend|web/i.test(label) ? "medium" :
      "low";

    const type =
      /govern|gov/i.test(label) ? "government-portal" :
      /insur/i.test(label) ? "insurance-portal" :
      /case|claim|evidence/i.test(label) ? "case-management" :
      /dashboard|ui|frontend|web|portal/i.test(label) ? "portal" :
      "service";

    matches.push({
      id: relative.replace(/[\\/]/g, "-"),
      path: relative,
      type,
      priority: priorityHint,
      hints: result.reasons,
    });
  }

  matches.sort((a, b) => {
    const priority = { critical: 0, high: 1, medium: 2, low: 3 };
    if (priority[a.priority] !== priority[b.priority]) return priority[a.priority] - priority[b.priority];
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.path.localeCompare(b.path);
  });

  const uniq = [];
  const seen = new Set();
  for (const m of matches) {
    const key = `${m.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }
  return uniq;
}

const outputFormat = getArg("output", "json");
const workspaces = detectPaths();

if (outputFormat === "github-output" || outputFormat === "github") {
  console.log(`workspaces_json=${JSON.stringify(workspaces)}`);
  console.log(`workspace_count=${workspaces.length}`);
} else {
  console.log(JSON.stringify({ detected: workspaces.length, workspaces }, null, 2));
}
