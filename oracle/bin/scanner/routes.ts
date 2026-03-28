/**
 * scanner/routes.ts — Framework detection and route discovery
 *
 * Detects the routing framework (React Router, Next.js App/Pages)
 * and discovers page routes, API endpoints, and workers.
 *
 * Discovery strategies (layered):
 *   1. Filesystem-based: scan pages/, app/ directories
 *   2. Router content parsing: createBrowserRouter, <Route> patterns
 *   3. Edge Functions: supabase/functions/ detection
 */

import * as fs from "fs";
import * as path from "path";
import { findFiles } from "./core";
import type { DiscoveredRoute } from "./core";
import { readPackageJson, hasDependency } from "./utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FrameworkDetectionResult {
  framework:
    | "react-router" | "nextjs-pages" | "nextjs-app"
    | "sveltekit" | "nuxt" | "tanstack-router" | "vue-router" | "wouter" | "remix" | "astro"
    | "unknown";
  routerContent?: string;
}

// ─── Framework Detection ────────────────────────────────────────────────────

function findRouterContent(projectRoot: string): string | undefined {
  const candidates = [
    "src/router.tsx", "src/router.ts",
    "src/routes.tsx", "src/routes.ts",
    "src/App.tsx", "src/App.ts",
    "app/router.tsx", "app/routes.tsx",
  ];
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    if (fs.existsSync(full)) {
      try {
        return fs.readFileSync(full, "utf-8");
      } catch {
        // Skip unreadable
      }
    }
  }
  return undefined;
}

export function detectFramework(projectRoot: string): FrameworkDetectionResult {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return { framework: "unknown" };

  // Next.js
  if (hasDependency(pkg, "next")) {
    const appDir = path.join(projectRoot, "app");
    if (fs.existsSync(appDir)) {
      return { framework: "nextjs-app" };
    }
    return { framework: "nextjs-pages" };
  }

  // React Router
  if (hasDependency(pkg, "react-router-dom") || hasDependency(pkg, "react-router")) {
    const routerContent = findRouterContent(projectRoot);
    return { framework: "react-router", routerContent };
  }

  // SvelteKit
  if (hasDependency(pkg, "@sveltejs/kit")) {
    return { framework: "sveltekit" };
  }

  // Nuxt
  if (hasDependency(pkg, "nuxt")) {
    return { framework: "nuxt" };
  }

  // Remix
  if (hasDependency(pkg, "@remix-run/react") || hasDependency(pkg, "@remix-run/node")) {
    return { framework: "remix" };
  }

  // TanStack Router
  if (hasDependency(pkg, "@tanstack/react-router")) {
    return { framework: "tanstack-router" };
  }

  // Vue Router
  if (hasDependency(pkg, "vue-router")) {
    return { framework: "vue-router" };
  }

  // Wouter (lightweight React router — same Route JSX patterns as React Router)
  if (hasDependency(pkg, "wouter")) {
    const routerContent = findRouterContent(projectRoot);
    return { framework: "wouter", routerContent };
  }

  // Astro
  if (hasDependency(pkg, "astro")) {
    return { framework: "astro" };
  }

  return { framework: "unknown" };
}

// ─── Route Discovery ────────────────────────────────────────────────────────

function discoverNextAppRoutes(projectRoot: string): DiscoveredRoute[] {
  const appDir = path.join(projectRoot, "app");
  if (!fs.existsSync(appDir)) return [];

  const pageFiles = findFiles(appDir, /^(page|route)\.(tsx?|jsx?)$/);
  const routes: DiscoveredRoute[] = [];

  for (const fullPath of pageFiles) {
    const relFromApp = path.relative(appDir, fullPath);
    const dir = path.dirname(relFromApp);
    const basename = path.basename(fullPath);
    const isApi = basename.startsWith("route.");

    // Convert directory path to route path
    let routePath = "/" + dir.replace(/\\/g, "/");
    if (routePath === "/.") routePath = "/";
    // Strip route groups: (group)/page.tsx → /page
    routePath = routePath.replace(/\/\([^)]+\)/g, "");
    // Clean trailing slashes
    if (routePath !== "/" && routePath.endsWith("/")) {
      routePath = routePath.slice(0, -1);
    }

    const relPageFile = path.relative(projectRoot, fullPath);
    routes.push({
      routePath,
      type: isApi ? "api" : "page",
      pageFile: relPageFile,
    });
  }

  return routes;
}

function discoverNextPagesRoutes(projectRoot: string): DiscoveredRoute[] {
  const pagesDir = path.join(projectRoot, "pages");
  if (!fs.existsSync(pagesDir)) return [];

  const pageFiles = findFiles(pagesDir, /\.(tsx?|jsx?)$/);
  const routes: DiscoveredRoute[] = [];

  for (const fullPath of pageFiles) {
    const relFromPages = path.relative(pagesDir, fullPath);
    const isApi = relFromPages.startsWith("api/") || relFromPages.startsWith("api\\");

    // Convert file path to route path
    let routePath = "/" + relFromPages
      .replace(/\\/g, "/")
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/\/index$/, "");
    if (routePath === "/") routePath = "/";

    const relPageFile = path.relative(projectRoot, fullPath);
    routes.push({
      routePath,
      type: isApi ? "api" : "page",
      pageFile: relPageFile,
    });
  }

  return routes;
}

function discoverReactRouterRoutes(
  projectRoot: string,
  routerContent?: string,
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  // Strategy 1: Scan src/pages/ directory (convention-based)
  const pagesDir = path.join(projectRoot, "src", "pages");
  if (fs.existsSync(pagesDir)) {
    const pageFiles = findFiles(pagesDir, /\.(tsx?|jsx?)$/);
    for (const fullPath of pageFiles) {
      const relFromPages = path.relative(pagesDir, fullPath);
      const stem = relFromPages
        .replace(/\\/g, "/")
        .replace(/\.(tsx?|jsx?)$/, "");

      // Skip index files, map directly
      let routePath: string;
      if (stem.toLowerCase() === "index") {
        routePath = "/";
      } else {
        routePath = "/" + stem.toLowerCase();
      }

      const relPageFile = path.relative(projectRoot, fullPath);
      routes.push({ routePath, type: "page", pageFile: relPageFile });
    }
  }

  // Strategy 2: Parse router content for path definitions
  if (routerContent) {
    // Match createBrowserRouter path strings: path: "/dashboard"
    const pathRegex = /path:\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(routerContent)) !== null) {
      const routePath = match[1];
      // Check if this route is already discovered via filesystem
      if (!routes.some(r => r.routePath === routePath)) {
        // Try to find the page file for this route
        const pageFile = findPageFileForRoute(routerContent, routePath, path.join(projectRoot, "src"));
        if (pageFile) {
          routes.push({
            routePath,
            type: "page",
            pageFile: path.relative(projectRoot, pageFile),
          });
        }
      }
    }

    // Match JSX Route patterns: <Route path="/about"
    const jsxRouteRegex = /<Route\s+[^>]*path=['"]([^'"]+)['"]/g;
    while ((match = jsxRouteRegex.exec(routerContent)) !== null) {
      const routePath = match[1];
      if (!routes.some(r => r.routePath === routePath)) {
        const pageFile = findPageFileForRoute(routerContent, routePath, path.join(projectRoot, "src"));
        if (pageFile) {
          routes.push({
            routePath,
            type: "page",
            pageFile: path.relative(projectRoot, pageFile),
          });
        }
      }
    }
  }

  return routes;
}

function discoverSupabaseEdgeFunctions(projectRoot: string): DiscoveredRoute[] {
  const functionsDir = path.join(projectRoot, "supabase", "functions");
  if (!fs.existsSync(functionsDir)) return [];

  const routes: DiscoveredRoute[] = [];
  try {
    const entries = fs.readdirSync(functionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const indexFile = path.join(functionsDir, entry.name, "index.ts");
      if (fs.existsSync(indexFile)) {
        routes.push({
          routePath: `/functions/${entry.name}`,
          type: "api",
          pageFile: path.relative(projectRoot, indexFile),
        });
      }
    }
  } catch {
    // Skip unreadable
  }

  return routes;
}

// ─── SvelteKit Routes ──────────────────────────────────────────────────────

function discoverSvelteKitRoutes(projectRoot: string): DiscoveredRoute[] {
  const routesDir = path.join(projectRoot, "src", "routes");
  if (!fs.existsSync(routesDir)) return [];

  const routes: DiscoveredRoute[] = [];
  const pageFiles = findFiles(routesDir, /\+page\.svelte$/);
  const serverFiles = findFiles(routesDir, /\+server\.(ts|js)$/);

  for (const fullPath of pageFiles) {
    const relFromRoutes = path.relative(routesDir, fullPath);
    let routePath = "/" + path.dirname(relFromRoutes).replace(/\\/g, "/");
    if (routePath === "/.") routePath = "/";
    routePath = routePath.replace(/\/\([^)]+\)/g, ""); // strip route groups
    routes.push({ routePath, type: "page", pageFile: path.relative(projectRoot, fullPath) });
  }

  for (const fullPath of serverFiles) {
    const relFromRoutes = path.relative(routesDir, fullPath);
    let routePath = "/" + path.dirname(relFromRoutes).replace(/\\/g, "/");
    if (routePath === "/.") routePath = "/";
    if (!routes.some(r => r.routePath === routePath)) {
      routes.push({ routePath, type: "api", pageFile: path.relative(projectRoot, fullPath) });
    }
  }

  return routes;
}

// ─── Nuxt Routes ───────────────────────────────────────────────────────────

function discoverNuxtRoutes(projectRoot: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  // Pages
  const pagesDir = path.join(projectRoot, "pages");
  if (fs.existsSync(pagesDir)) {
    const vueFiles = findFiles(pagesDir, /\.vue$/);
    for (const fullPath of vueFiles) {
      const rel = path.relative(pagesDir, fullPath);
      let routePath = "/" + rel.replace(/\\/g, "/").replace(/\.vue$/, "").replace(/\/index$/, "");
      if (routePath === "/") routePath = "/";
      routes.push({ routePath, type: "page", pageFile: path.relative(projectRoot, fullPath) });
    }
  }

  // Server API
  const serverDir = path.join(projectRoot, "server", "api");
  if (fs.existsSync(serverDir)) {
    const apiFiles = findFiles(serverDir, /\.(ts|js)$/);
    for (const fullPath of apiFiles) {
      const rel = path.relative(serverDir, fullPath);
      const routePath = "/api/" + rel.replace(/\\/g, "/").replace(/\.(ts|js)$/, "");
      routes.push({ routePath, type: "api", pageFile: path.relative(projectRoot, fullPath) });
    }
  }

  return routes;
}

// ─── Remix Routes ──────────────────────────────────────────────────────────

function discoverRemixRoutes(projectRoot: string): DiscoveredRoute[] {
  const routesDir = path.join(projectRoot, "app", "routes");
  if (!fs.existsSync(routesDir)) return [];

  const routes: DiscoveredRoute[] = [];
  const routeFiles = findFiles(routesDir, /\.(tsx?|jsx?)$/);

  for (const fullPath of routeFiles) {
    const rel = path.relative(routesDir, fullPath);
    let routePath = "/" + rel
      .replace(/\\/g, "/")
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/^_index$/, "")          // _index.tsx -> /
      .replace(/\./g, "/")              // flat routes: about.tsx -> /about
      .replace(/\$(\w+)/g, ":$1")      // $id -> :id
      .replace(/\/_/g, "/");            // _layout segments
    if (routePath === "/") routePath = "/";
    if (routePath.endsWith("/")) routePath = routePath.slice(0, -1) || "/";
    routes.push({ routePath, type: "page", pageFile: path.relative(projectRoot, fullPath) });
  }

  return routes;
}

// ─── TanStack Router Routes ────────────────────────────────────────────────

function discoverTanStackRouterRoutes(projectRoot: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  // Check for generated route tree
  const routeTreePath = path.join(projectRoot, "src", "routeTree.gen.ts");
  if (fs.existsSync(routeTreePath)) {
    try {
      const content = fs.readFileSync(routeTreePath, "utf-8");
      const pathRegex = /path:\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = pathRegex.exec(content)) !== null) {
        routes.push({
          routePath: match[1].startsWith("/") ? match[1] : "/" + match[1],
          type: "page",
          pageFile: path.relative(projectRoot, routeTreePath),
        });
      }
    } catch { /* skip */ }
  }

  // Check for routes directory (file-based routing)
  const routesDir = path.join(projectRoot, "src", "routes");
  if (fs.existsSync(routesDir)) {
    const routeFiles = findFiles(routesDir, /\.(tsx?|jsx?)$/);
    for (const fullPath of routeFiles) {
      const rel = path.relative(routesDir, fullPath);
      let routePath = "/" + rel.replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
      if (routePath === "/") routePath = "/";
      if (!routes.some(r => r.routePath === routePath)) {
        routes.push({ routePath, type: "page", pageFile: path.relative(projectRoot, fullPath) });
      }
    }
  }

  return routes;
}

// ─── Vue Router Routes ─────────────────────────────────────────────────────

function discoverVueRouterRoutes(projectRoot: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  // Parse router config file
  const routerPaths = [
    path.join(projectRoot, "src", "router", "index.ts"),
    path.join(projectRoot, "src", "router", "index.js"),
    path.join(projectRoot, "src", "router.ts"),
    path.join(projectRoot, "src", "router.js"),
  ];

  for (const routerPath of routerPaths) {
    if (!fs.existsSync(routerPath)) continue;
    try {
      const content = fs.readFileSync(routerPath, "utf-8");
      const pathRegex = /path:\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = pathRegex.exec(content)) !== null) {
        routes.push({
          routePath: match[1].startsWith("/") ? match[1] : "/" + match[1],
          type: "page",
          pageFile: path.relative(projectRoot, routerPath),
        });
      }
    } catch { /* skip */ }
    break; // Use first found router config
  }

  return routes;
}

// ─── Astro Routes ──────────────────────────────────────────────────────────

function discoverAstroRoutes(projectRoot: string): DiscoveredRoute[] {
  const pagesDir = path.join(projectRoot, "src", "pages");
  if (!fs.existsSync(pagesDir)) return [];

  const routes: DiscoveredRoute[] = [];
  const pageFiles = findFiles(pagesDir, /\.(astro|md|mdx)$/);

  for (const fullPath of pageFiles) {
    const rel = path.relative(pagesDir, fullPath);
    let routePath = "/" + rel
      .replace(/\\/g, "/")
      .replace(/\.(astro|md|mdx)$/, "");
    // Strip /index or bare index to get root route
    routePath = routePath.replace(/\/index$/, "").replace(/^\/index$/, "");
    if (!routePath || routePath === "") routePath = "/";
    routes.push({ routePath, type: "page", pageFile: path.relative(projectRoot, fullPath) });
  }

  return routes;
}

// ─── Route Discovery Orchestrator ──────────────────────────────────────────

export function discoverRoutes(
  projectRoot: string,
  detection: FrameworkDetectionResult,
  _viteAliases?: Record<string, string>,
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  switch (detection.framework) {
    case "nextjs-app":
      routes.push(...discoverNextAppRoutes(projectRoot));
      break;
    case "nextjs-pages":
      routes.push(...discoverNextPagesRoutes(projectRoot));
      break;
    case "react-router":
      routes.push(...discoverReactRouterRoutes(projectRoot, detection.routerContent));
      break;
    case "sveltekit":
      routes.push(...discoverSvelteKitRoutes(projectRoot));
      break;
    case "nuxt":
      routes.push(...discoverNuxtRoutes(projectRoot));
      break;
    case "remix":
      routes.push(...discoverRemixRoutes(projectRoot));
      break;
    case "tanstack-router":
      routes.push(...discoverTanStackRouterRoutes(projectRoot));
      break;
    case "vue-router":
      routes.push(...discoverVueRouterRoutes(projectRoot));
      break;
    case "wouter":
      // Wouter uses same <Route path="..."> JSX patterns as React Router
      routes.push(...discoverReactRouterRoutes(projectRoot, detection.routerContent));
      break;
    case "astro":
      routes.push(...discoverAstroRoutes(projectRoot));
      break;
    case "unknown":
      // Try all strategies
      routes.push(...discoverReactRouterRoutes(projectRoot));
      break;
  }

  // Always check for Supabase Edge Functions (framework-independent)
  routes.push(...discoverSupabaseEdgeFunctions(projectRoot));

  return routes;
}

// ─── Page File Resolution ───────────────────────────────────────────────────

/**
 * Find the page file for a given route path by searching the source directory.
 * Case-insensitive exact-stem match — no substring false positives.
 */
export function findPageFileForRoute(
  _routerContent: string,
  routePath: string,
  srcDir: string,
): string | null {
  // Strip leading slash and get the last segment as the filename to match
  const segment = routePath.replace(/^\//, "").split("/").pop() ?? "";
  if (!segment) return null;

  const segmentLower = segment.toLowerCase();

  // Search in pages/ subdirectory first, then src/ root
  const searchDirs = [
    path.join(srcDir, "pages"),
    srcDir,
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const stem = entry.replace(/\.(tsx?|jsx?)$/, "");
        if (stem.toLowerCase() === segmentLower && /\.(tsx?|jsx?)$/.test(entry)) {
          return path.join(dir, entry);
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  return null;
}
