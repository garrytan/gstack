#!/usr/bin/env bun
// watch.ts — live terminal dashboard for the cstack agent fleet
//
// Usage (called by fleet.sh watch):
//   bun watch.ts <fleet-conf> <agents-home-dir>
//
// Reads each agent's ~/agents/<name>/logs/live.json every 2s.
// Renders an in-place refreshing table with ANSI colors.
// Press Ctrl-C to exit.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const [fleetConf, agentsHome] = process.argv.slice(2);
if (!fleetConf || !agentsHome) {
  console.error("Usage: bun watch.ts <fleet-conf> <agents-home>");
  process.exit(1);
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  white:  "\x1b[97m",
  clear:  "\x1b[2J\x1b[H",   // clear screen + cursor home
  hide:   "\x1b[?25l",        // hide cursor
  show:   "\x1b[?25h",        // show cursor
};

function pad(s: string, n: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI for length
  return s + " ".repeat(Math.max(0, n - plain.length));
}

// ── Fleet config parser ───────────────────────────────────────────────────────

interface Agent { name: string; role: string; model: string }

function readFleet(): Agent[] {
  const agents: Agent[] = [];
  try {
    const lines = readFileSync(fleetConf, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      agents.push({ name: parts[0], role: parts[1] ?? "FEATURE_ROLE.md", model: parts[2] ?? "claude-sonnet-4-6" });
    }
  } catch { /* fleet.conf unreadable — show nothing */ }
  return agents;
}

// ── Live state reader ─────────────────────────────────────────────────────────

interface LiveState {
  agent:         string;
  session_start: string;
  task:          string | null;
  last_tool:     string | null;
  last_summary:  string | null;
  last_ts:       string;
  turn:          number;
  ended:         boolean;
}

function readLive(name: string): LiveState | null {
  const path = join(agentsHome, name, "logs", "live.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as LiveState; }
  catch { return null; }
}

function elapsed(isoStart: string): string {
  const ms = Date.now() - new Date(isoStart).getTime();
  if (ms < 0) return "—";
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const h  = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ── Row state helpers ─────────────────────────────────────────────────────────

function presenceFile(name: string): string {
  return join(agentsHome, name, "control", "mailboxes", "presence", `${name}.json`);
}

function readPresence(name: string): Record<string, unknown> | null {
  const p = presenceFile(name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return null; }
}

function agentRows(agents: Agent[]): string {
  const COL = { name: 14, state: 9, task: 11, running: 10, tool: 10, activity: 38 };
  const sep = "  " + "─".repeat(
    COL.name + COL.state + COL.task + COL.running + COL.tool + COL.activity + 5 * 2
  );

  const header =
    "  " +
    pad(`${C.bold}AGENT${C.reset}`,    COL.name    + C.bold.length + C.reset.length) + "  " +
    pad(`${C.bold}STATE${C.reset}`,    COL.state   + C.bold.length + C.reset.length) + "  " +
    pad(`${C.bold}TASK${C.reset}`,     COL.task    + C.bold.length + C.reset.length) + "  " +
    pad(`${C.bold}RUNNING${C.reset}`,  COL.running + C.bold.length + C.reset.length) + "  " +
    pad(`${C.bold}TOOL${C.reset}`,     COL.tool    + C.bold.length + C.reset.length) + "  " +
    `${C.bold}LAST ACTIVITY${C.reset}`;

  const rows = agents.map(({ name }) => {
    const live     = readLive(name);
    const presence = readPresence(name);

    // Determine state
    let rawState = "stopped";
    if (presence) {
      rawState = (presence.state as string) || "unknown";
    } else if (live && !live.ended) {
      rawState = "working";
    }

    // State color
    let stateStr: string;
    switch (rawState) {
      case "working":      stateStr = `${C.green}${C.bold}WORKING${C.reset}`;        break;
      case "checking":     stateStr = `${C.cyan}checking${C.reset}`;                 break;
      case "idle":         stateStr = `${C.yellow}IDLE${C.reset}`;                   break;
      case "rate_limited": stateStr = `${C.yellow}${C.bold}RATE LIM${C.reset}`;      break;
      case "stopped":      stateStr = `${C.dim}stopped${C.reset}`;                   break;
      default:             stateStr = `${C.dim}${rawState}${C.reset}`;
    }

    // Task — only read live.task while the session is active (not ended).
    // A finished session leaves a stale task in live.json which would show
    // the last-ever task even when the agent has nothing claimed.
    const liveTask = (live && !live.ended) ? live.task : null;
    const task = liveTask ?? (presence?.task as string | null) ?? null;
    const taskStr = task
      ? `${C.cyan}${task.slice(0, COL.task - 1)}${C.reset}`
      : rawState === "idle"
        ? `${C.dim}no tasks${C.reset}`
        : `${C.dim}—${C.reset}`;

    // Running duration (only while live and not ended)
    const runningStr = (live && !live.ended)
      ? elapsed(live.session_start)
      : "—";

    // Last tool
    const lastTool = live?.last_tool ?? (presence?.last_tool as string | null) ?? null;
    const toolStr  = lastTool ? lastTool.slice(0, COL.tool - 1) : `${C.dim}—${C.reset}`;

    // Last activity summary
    const summary = live?.last_summary ?? (presence?.last_summary as string | null) ?? null;
    const activityStr = summary
      ? summary.slice(0, COL.activity - 1)
      : `${C.dim}—${C.reset}`;

    return (
      "  " +
      pad(name,        COL.name)    + "  " +
      pad(stateStr,    COL.state    + stateStr.length    - rawState.length) + "  " +
      pad(taskStr,     COL.task     + taskStr.length     - (task?.slice(0, COL.task - 1)?.length ?? 1)) + "  " +
      pad(runningStr,  COL.running) + "  " +
      pad(toolStr,     COL.tool     + (lastTool ? 0 : toolStr.length - 1)) + "  " +
      activityStr
    );
  });

  return [header, sep, ...rows].join("\n");
}

// ── Main render loop ──────────────────────────────────────────────────────────

process.stdout.write(C.hide);

function cleanup() {
  process.stdout.write(C.show + "\n");
  process.exit(0);
}
process.on("SIGINT",  cleanup);
process.on("SIGTERM", cleanup);

function render() {
  const agents = readFleet();
  const ts = new Date().toUTCString().replace(" GMT", " UTC");

  const output = [
    "",
    `  ${C.bold}${C.white}cstack fleet — live${C.reset}   ${C.dim}${ts}${C.reset}   ${C.dim}refresh: 2s${C.reset}`,
    "",
    agentRows(agents),
    "",
    `  ${C.dim}Ctrl-C to exit  ·  fleet.sh stream for event feed${C.reset}`,
    "",
  ].join("\n");

  process.stdout.write(C.clear + output);
}

render();
setInterval(render, 2000);
