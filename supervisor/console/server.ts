// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (AC3).

import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PORT = 7842;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse fleet.conf: skip blank lines and # comments, return all agent names.
function parseFleetConf(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

async function resolveControlDir(): Promise<string> {
  // AC5: explicit override via env var — skip all detection.
  if (process.env.CONTROL_DIR) {
    return process.env.CONTROL_DIR;
  }

  // AC4: derive the control repo URL from the first agent listed in fleet.conf.
  const fleetConfPath = join(__dirname, "..", "fleet.conf");
  let fleetContent: string;
  try {
    fleetContent = await Bun.file(fleetConfPath).text();
  } catch {
    throw new Error(`Cannot read fleet.conf at ${fleetConfPath}`);
  }

  const agents = parseFleetConf(fleetContent);
  if (!agents.length) {
    throw new Error("fleet.conf has no agent entries");
  }
  const firstAgent = agents[0];

  // AC4: read URL via git, not from a separate config file.
  const agentControlPath = join(homedir(), "agents", firstAgent, "control");
  const gitProc = Bun.spawn(
    ["git", "-C", agentControlPath, "remote", "get-url", "origin"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const gitExit = await gitProc.exited;
  const remoteUrl = (await new Response(gitProc.stdout).text()).trim();

  if (gitExit !== 0 || !remoteUrl) {
    throw new Error(
      `Could not read control repo remote URL from ${agentControlPath}`
    );
  }

  const clonePath = join(homedir(), "agents", "console", "control");

  // AC2: already cloned — start immediately.
  if (existsSync(clonePath)) {
    return clonePath;
  }

  // AC1: clone is blocking; server.listen() is not called until it finishes.
  console.log(`Cloning control repo from ${remoteUrl}...`);
  const cloneProc = Bun.spawn(["git", "clone", remoteUrl, clonePath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const cloneExit = await cloneProc.exited;

  // AC6: non-zero exit on failure; no server is started.
  if (cloneExit !== 0) {
    console.error(`ERROR: failed to clone control repo from ${remoteUrl}`);
    process.exit(1);
  }

  return clonePath;
}

// Resolve control dir (blocking — see AC3: server only binds after this).
const controlDir = await resolveControlDir();
console.log(`Control dir: ${controlDir}`);

// AC3: app.listen() is called only after the clone succeeds.
Bun.serve({
  port: PORT,
  fetch(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", controlDir }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Console server listening on http://127.0.0.1:${PORT}`);
