/**
 * dashboard-cli — terminal renderers for the gstack sprint dashboard.
 *
 * Three modes:
 *   renderOneliner(data)  — single line, ~80 chars, for the PreToolUse hook
 *   renderCompact(data)   — ~30 lines, default for /dashboard skill
 *   renderFull(data)      — ~80 lines, all sections
 */

import type { DashboardData, OnelinerData, Stage } from "./dashboard-data";
import { STAGE_ORDER, STAGE_LABELS } from "./dashboard-data";

// ─── Shared helpers ─────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function stageChar(reached: boolean, isCurrent: boolean): string {
  if (!reached) return "○";
  if (isCurrent) return "▶";
  return "✓";
}

function avgQualityScore(quality: DashboardData["quality"]): string {
  if (quality.length === 0) return "—";
  const avg = quality.reduce((s, q) => s + q.score, 0) / quality.length;
  return `${avg.toFixed(1)}/10`;
}

// ─── One-liner ──────────────────────────────────────────────────────────────

export function renderOneliner(data: OnelinerData): string {
  const parts: string[] = [];

  parts.push(`● ${data.branch}`);
  if (data.version) parts.push(`v${data.version}`);
  parts.push(`${data.inFlightCount} in-flight`);

  // Show stages: completed ones + current + first unstarted (pipeline context)
  const latestIdx = data.currentBranchLatestStage
    ? STAGE_ORDER.indexOf(data.currentBranchLatestStage)
    : -1;
  const showUpTo = Math.min(latestIdx + 2, STAGE_ORDER.length - 1);
  const visibleStages = latestIdx >= 0 ? STAGE_ORDER.slice(0, showUpTo + 1) : [];

  if (visibleStages.length > 0) {
    const stageParts = visibleStages.map((s: Stage) => {
      const reached = data.currentBranchStages.has(s);
      const isCurrent = data.currentBranchLatestStage === s;
      return `${STAGE_LABELS[s]}:${stageChar(reached, isCurrent)}`;
    });
    parts.push(stageParts.join(" "));
  }

  if (data.lastShipDate) {
    const diffDays = Math.floor(
      (Date.now() - new Date(data.lastShipDate).getTime()) / 86400000
    );
    parts.push(`shipped ${diffDays === 0 ? "today" : `${diffDays}d ago`}`);
  }
  if (data.p1Count !== null) parts.push(`P1:${data.p1Count}`);

  return parts.join("  ");
}

// ─── Compact (~30 lines) ────────────────────────────────────────────────────

export function renderCompact(data: DashboardData): string {
  const W = 72;
  const heavy = "━".repeat(W);
  const thin = "─".repeat(W);
  const lines: string[] = [];

  // Header
  const vStr = data.version ? `v${data.version}` : "—";
  const avgStr =
    data.velocity.avgDaysBetween !== null
      ? `avg ${data.velocity.avgDaysBetween.toFixed(1)}d`
      : null;
  const headerParts = [
    `gstack  ${data.slug}`,
    vStr,
    `${data.inFlightCount} in-flight`,
    `${data.velocity.releasesThisMonth} ships/mo`,
    ...(avgStr ? [avgStr] : []),
    ...(data.backlog?.P1 != null ? [`P1:${data.backlog.P1}`] : []),
  ];
  lines.push(heavy);
  lines.push(` ${headerParts.join("  ·  ")}`);
  lines.push(heavy);
  lines.push("");

  // Pipeline
  const stageHdr = STAGE_ORDER.map((s: Stage) => STAGE_LABELS[s].padEnd(6)).join(" ");
  lines.push(` PIPELINE             ${stageHdr}`);
  lines.push(` ${thin}`);

  const tracked = data.features.filter((f) => f.latestStage !== null).slice(0, 8);
  const untrackedCount = data.features.filter((f) => f.latestStage === null).length;
  if (tracked.length === 0) {
    lines.push("   no tracked branches yet");
  } else {
    for (const f of tracked) {
      const nameCol = f.branch.slice(0, 20).padEnd(20);
      const stages = STAGE_ORDER.map((s: Stage) =>
        stageChar(f.stagesReached.has(s), f.latestStage === s).padEnd(6)
      ).join(" ");
      const pr = data.prMap.get(f.branch);
      const prTag = pr ? `  #${pr.number}` : "";
      const current = f.branch === data.branch ? " ◀" : "";
      lines.push(` ${nameCol} ${stages}${prTag}${current}`);
    }
  }
  if (untrackedCount > 0) {
    lines.push(`   (+${untrackedCount} untracked — no skill activity)`);
  }
  lines.push("");

  // Activity
  lines.push(" RECENT ACTIVITY");
  lines.push(` ${thin}`);
  const acts = data.activity.slice(0, 5);
  if (acts.length === 0) {
    lines.push("   no activity yet");
  } else {
    for (const a of acts) {
      const time = relativeTime(a.ts).padEnd(9);
      const skill = `/${a.skill}`.padEnd(20);
      const branch = a.branch.slice(0, 22).padEnd(22);
      lines.push(`  ${time} ${skill} ${branch} ${a.event}`);
    }
  }
  lines.push("");

  // Quality + top skills footer
  const qualStr = `QUALITY ${avgQualityScore(data.quality)}`;
  const topStr = data.topSkills
    .slice(0, 4)
    .map((s) => `/${s.skill}:${s.count}`)
    .join("  ");
  lines.push(` ${qualStr}   ·   TOP SKILLS  ${topStr}`);
  lines.push("");

  return lines.join("\n");
}

// ─── Full (~80 lines) ───────────────────────────────────────────────────────

export function renderFull(data: DashboardData): string {
  const W = 80;
  const heavy = "━".repeat(W);
  const thin = "─".repeat(W);
  const lines: string[] = [];

  // Header
  lines.push(heavy);
  lines.push(` gstack sprint dashboard — ${data.slug}`);
  const vStr = data.version ? `v${data.version}` : "—";
  const avgStr =
    data.velocity.avgDaysBetween !== null
      ? `${data.velocity.avgDaysBetween.toFixed(1)}d`
      : "—";
  lines.push(
    ` ${vStr}  |  ${data.inFlightCount} in-flight  |  ${data.velocity.releasesThisMonth} ships/mo` +
      `  |  avg ${avgStr}/release  |  P1:${data.backlog?.P1 ?? "—"}  |  decisions:${data.openDecisions ?? "—"}`
  );
  lines.push(` generated ${data.generatedAt.toLocaleString()}`);
  lines.push(heavy);
  lines.push("");

  // Pipeline
  const stageHdr = STAGE_ORDER.map((s: Stage) => STAGE_LABELS[s].padEnd(7)).join(" ");
  lines.push(` PIPELINE               ${stageHdr}  Last Activity`);
  lines.push(` ${thin}`);

  if (data.features.length === 0) {
    lines.push("   no local branches found");
  } else {
    for (const f of data.features) {
      const nameCol = f.branch.slice(0, 22).padEnd(22);
      const stages = STAGE_ORDER.map((s: Stage) =>
        stageChar(f.stagesReached.has(s), f.latestStage === s).padEnd(7)
      ).join(" ");
      const lastAct = f.latestTs
        ? `${relativeTime(f.latestTs)} /${f.latestSkill ?? ""}`.slice(0, 22).padEnd(22)
        : "—".padEnd(22);
      const pr = data.prMap.get(f.branch);
      const prTag = pr ? `  #${pr.number} ${pr.state}` : "";
      const current = f.branch === data.branch ? " ◀" : "";
      lines.push(` ${nameCol} ${stages} ${lastAct}${prTag}${current}`);
    }
  }
  lines.push("");

  // Activity feed
  lines.push(" ACTIVITY FEED");
  lines.push(` ${thin}`);
  if (data.activity.length === 0) {
    lines.push("   no activity yet");
  } else {
    for (const a of data.activity) {
      const time = relativeTime(a.ts).padEnd(10);
      const skill = `/${a.skill}`.padEnd(22);
      const branch = a.branch.slice(0, 24).padEnd(24);
      lines.push(`  ${time} ${skill} ${branch} ${a.event}`);
    }
  }
  lines.push("");

  // Top skills
  lines.push(" TOP SKILLS  (last 30d)");
  lines.push(` ${thin}`);
  if (data.topSkills.length === 0) {
    lines.push("   no data yet");
  } else {
    const max = data.topSkills[0].count;
    for (const s of data.topSkills) {
      const barLen = Math.round((s.count / max) * 28);
      const bar = "█".repeat(barLen) + "░".repeat(28 - barLen);
      lines.push(`  /${s.skill.padEnd(18)} ${bar}  ${s.count}`);
    }
  }
  lines.push("");

  // Quality scores
  lines.push(" QUALITY SCORES  (last 30d)");
  lines.push(` ${thin}`);
  if (data.quality.length === 0) {
    lines.push("   no data yet");
  } else {
    for (const q of data.quality) {
      const date = new Date(q.ts).toLocaleDateString().padEnd(12);
      const skill = `/${q.skill}`.padEnd(20);
      const score = `${q.score}/10`.padStart(5);
      lines.push(`  ${date} ${skill} ${score}  (${q.iterations} iter)`);
    }
  }
  lines.push("");

  // Release velocity
  lines.push(" RELEASE VELOCITY  (last 30d)");
  lines.push(` ${thin}`);
  if (data.velocity.recentVersions.length === 0) {
    lines.push("   no releases in the last 30 days");
  } else {
    const blocks = " ▁▂▃▄▅▆▇█";
    const max = Math.max(1, ...data.velocity.recentVersions.map((v) => v.commitCount));
    const sparkline = data.velocity.recentVersions
      .map((v) => blocks[Math.min(8, Math.round((v.commitCount / max) * 8))])
      .join("");
    lines.push(`  ${sparkline}`);
    for (const v of data.velocity.recentVersions) {
      lines.push(`  v${v.version.padEnd(16)} ${v.date}  ${v.commitCount} commit(s)`);
    }
  }
  lines.push("");

  // Design docs
  if (data.designDocs.length > 0) {
    lines.push(" ACTIVE DESIGN DOCS");
    lines.push(` ${thin}`);
    for (const d of data.designDocs) {
      const date = d.mtime ? new Date(d.mtime).toLocaleDateString().padEnd(12) : "—".padEnd(12);
      lines.push(`  ${d.name.slice(0, 52).padEnd(52)} ${date}`);
    }
    lines.push("");
  }

  // Backlog
  lines.push(" TODOS BACKLOG");
  lines.push(` ${thin}`);
  if (!data.backlog) {
    lines.push("   no TODOS.md found");
  } else {
    const priorities = (["P0", "P1", "P2", "P3", "P4"] as const).filter(
      (p) => data.backlog![p] > 0
    );
    if (priorities.length === 0) {
      lines.push("   backlog is empty");
    } else {
      for (const p of priorities) {
        lines.push(`  ${p}: ${data.backlog![p]}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}
