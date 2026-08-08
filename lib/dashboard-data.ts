/**
 * dashboard-data — shared data layer for gstack sprint dashboard.
 *
 * Exports typed loaders and two assemblers:
 *   buildDashboard(opts)     — full data (may call gh/gstack-decision-search)
 *   buildOnelinerData(opts)  — fast subset (disk only, no network)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { readJsonl } from "./jsonl-store";
import { resolveSlug as resolveSlugBin, gitBranch } from "./bin-context";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Stage =
  | "office-hours"
  | "spec"
  | "plan-review"
  | "implement"
  | "review"
  | "ship"
  | "canary";

export interface TimelineEvent {
  ts: string;
  skill: string;
  branch: string;
  event: string;
}

export interface FeatureRow {
  branch: string;
  stagesReached: Set<Stage>;
  latestStage: Stage | null;
  latestTs: string | null;
  latestSkill: string | null;
}

export interface ActivityFeedItem {
  ts: string;
  skill: string;
  branch: string;
  event: string;
}

export interface VelocityData {
  releasesThisMonth: number;
  avgDaysBetween: number | null;
  recentVersions: Array<{ version: string; date: string; commitCount: number }>;
}

export interface SkillUsageStat {
  skill: string;
  count: number;
}

export interface QualityEntry {
  ts: string;
  skill: string;
  score: number;
  iterations: number;
}

export interface DesignDoc {
  name: string;
  fullPath: string;
  mtime: number;
}

export interface BacklogStats {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  unparsed: number;
}

export interface DashboardData {
  slug: string;
  branch: string;
  version: string | null;
  generatedAt: Date;
  inFlightCount: number;
  features: FeatureRow[];
  activity: ActivityFeedItem[];
  velocity: VelocityData;
  topSkills: SkillUsageStat[];
  quality: QualityEntry[];
  designDocs: DesignDoc[];
  backlog: BacklogStats | null;
  openDecisions: number | null;
  ghAvailable: boolean;
  prMap: Map<string, { number: number; state: string }>;
  defaultBranch: string | null;
}

export interface OnelinerData {
  slug: string;
  branch: string;
  version: string | null;
  inFlightCount: number;
  currentBranchStages: Set<Stage>;
  currentBranchLatestStage: Stage | null;
  p1Count: number | null;
  lastShipDate: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const STAGE_ORDER: Stage[] = [
  "office-hours",
  "spec",
  "plan-review",
  "implement",
  "review",
  "ship",
  "canary",
];

export const STAGE_LABELS: Record<Stage, string> = {
  "office-hours": "OH",
  spec: "Spec",
  "plan-review": "Plan",
  implement: "Impl",
  review: "Rev",
  ship: "Ship",
  canary: "Canary",
};

export const SKILL_TO_STAGE: Record<string, Stage> = {
  "office-hours": "office-hours",
  spec: "spec",
  "plan-ceo-review": "plan-review",
  "plan-eng-review": "plan-review",
  "plan-design-review": "plan-review",
  "plan-devex-review": "plan-review",
  autoplan: "plan-review",
  review: "review",
  codex: "review",
  "design-review": "review",
  "devex-review": "review",
  qa: "implement",
  "qa-only": "implement",
  investigate: "implement",
  ship: "ship",
  "land-and-deploy": "ship",
  canary: "canary",
};

const HISTORY_WINDOW_DAYS = 30;
const IN_FLIGHT_WINDOW_DAYS = 90;

// ─── Private helpers ────────────────────────────────────────────────────────

function stageForSkill(skill: string): Stage {
  return SKILL_TO_STAGE[skill] ?? "implement";
}

function withinWindow(ts: string | undefined, days: number): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 24 * 60 * 60 * 1000;
}

function binDir(): string {
  // import.meta.dir is this file's directory (lib/); go up to repo root then into bin/
  return join(import.meta.dir, "..", "bin");
}

// ─── Path resolvers ─────────────────────────────────────────────────────────

export function resolveGstackHome(home?: string): string {
  return home ?? process.env.GSTACK_HOME ?? join(homedir(), ".gstack");
}

export function resolveProjectSlug(slug?: string): string {
  if (slug) return slug;
  const slugBin = join(binDir(), "gstack-slug");
  return resolveSlugBin(slugBin);
}

// ─── Individual loaders ─────────────────────────────────────────────────────

export function loadVersion(cwd = process.cwd()): string | null {
  const p = join(cwd, "VERSION");
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf-8").trim();
  return v || null;
}

export function loadTimeline(projectDir: string): TimelineEvent[] {
  return readJsonl<TimelineEvent>(join(projectDir, "timeline.jsonl"));
}

export function loadInFlightFeatures(timeline: TimelineEvent[]): FeatureRow[] {
  let branches: string[] = [];
  try {
    const out = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    branches = out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {}

  const completedEvents = timeline.filter(
    (e) => e.event === "completed" && e.branch && e.ts && e.skill
  );

  const entriesByBranch = new Map<string, TimelineEvent[]>();
  for (const e of completedEvents) {
    const list = entriesByBranch.get(e.branch) ?? [];
    list.push(e);
    entriesByBranch.set(e.branch, list);
  }

  return branches.map((branch) => {
    const entries = entriesByBranch.get(branch) ?? [];
    const recent = entries.filter((e) => withinWindow(e.ts, IN_FLIGHT_WINDOW_DAYS));
    const stagesReached = new Set<Stage>(recent.map((e) => stageForSkill(e.skill)));
    let latestEntry: TimelineEvent | null = null;
    for (const e of entries) {
      if (!latestEntry || new Date(e.ts) > new Date(latestEntry.ts)) latestEntry = e;
    }
    return {
      branch,
      stagesReached,
      latestStage: latestEntry ? stageForSkill(latestEntry.skill) : null,
      latestTs: latestEntry?.ts ?? null,
      latestSkill: latestEntry?.skill ?? null,
    };
  });
}

export function loadActivityFeed(timeline: TimelineEvent[], limit = 12): ActivityFeedItem[] {
  return timeline
    .filter((e) => e.ts && e.skill)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, limit)
    .map((e) => ({ ts: e.ts, skill: e.skill, branch: e.branch ?? "unknown", event: e.event ?? "" }));
}

export function loadVelocity(cwd = process.cwd()): VelocityData {
  const changelogPath = join(cwd, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return { releasesThisMonth: 0, avgDaysBetween: null, recentVersions: [] };
  }
  const changelog = readFileSync(changelogPath, "utf-8");
  const re = /^## \[(\d+\.\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/gm;
  const all: Array<{ version: string; date: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(changelog)) !== null) all.push({ version: m[1], date: m[2] });

  const now = new Date();
  const releasesThisMonth = all.filter((v) => {
    const d = new Date(v.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;

  const recent = all
    .filter((v) => withinWindow(v.date, HISTORY_WINDOW_DAYS))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let avgDaysBetween: number | null = null;
  if (recent.length >= 2) {
    const span =
      new Date(recent[recent.length - 1].date).getTime() - new Date(recent[0].date).getTime();
    avgDaysBetween = span / (24 * 60 * 60 * 1000) / (recent.length - 1);
  }

  let subjects: string[] = [];
  try {
    const out = execFileSync(
      "git",
      ["log", `--since=${HISTORY_WINDOW_DAYS} days ago`, "--pretty=format:%s"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    subjects = out.split("\n").filter(Boolean);
  } catch {}

  const commitCounts = new Map<string, number>();
  for (const s of subjects) {
    const vm = s.match(/^v(\d+\.\d+\.\d+\.\d+)\s/);
    if (vm) commitCounts.set(vm[1], (commitCounts.get(vm[1]) ?? 0) + 1);
  }

  return {
    releasesThisMonth,
    avgDaysBetween,
    recentVersions: recent.map((v) => ({ ...v, commitCount: commitCounts.get(v.version) ?? 0 })),
  };
}

export function loadOpenDecisions(projectDir: string): number | null {
  const activePath = join(projectDir, "decisions.active.json");
  if (existsSync(activePath)) {
    try {
      const arr = JSON.parse(readFileSync(activePath, "utf-8"));
      return Array.isArray(arr) ? arr.length : null;
    } catch {}
  }
  try {
    const out = execFileSync(join(binDir(), "gstack-decision-search"), ["--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = JSON.parse(out || "[]");
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

export function loadPrData(
  features: FeatureRow[],
  defaultBranch: string | null
): { ghAvailable: boolean; prMap: Map<string, { number: number; state: string }> } {
  const prMap = new Map<string, { number: number; state: string }>();
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--json", "number,state,headRefName", "--limit", "100"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const prs = JSON.parse(out) as { number: number; state: string; headRefName: string }[];
    const branchSet = new Set(
      features.filter((f) => f.branch !== defaultBranch).map((f) => f.branch)
    );
    for (const pr of prs) {
      if (branchSet.has(pr.headRefName)) {
        prMap.set(pr.headRefName, { number: pr.number, state: pr.state });
      }
    }
    return { ghAvailable: true, prMap };
  } catch {
    return { ghAvailable: false, prMap };
  }
}

function resolveDefaultBranch(): string | null {
  try {
    return execFileSync(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    try {
      const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return ref.replace(/^refs\/remotes\/origin\//, "");
    } catch {
      return null;
    }
  }
}

export function loadTopSkills(analyticsDir: string, limit = 6): SkillUsageStat[] {
  const entries = readJsonl<{ skill?: string; ts?: string }>(
    join(analyticsDir, "skill-usage.jsonl")
  ).filter((e) => e.skill && withinWindow(e.ts, HISTORY_WINDOW_DAYS));

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.skill!, (counts.get(e.skill!) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([skill, count]) => ({ skill, count }));
}

export function loadQualityHistory(analyticsDir: string, limit = 8): QualityEntry[] {
  return readJsonl<{ ts?: string; skill?: string; quality_score?: number; iterations?: number }>(
    join(analyticsDir, "spec-review.jsonl")
  )
    .filter((e) => e.ts && withinWindow(e.ts, HISTORY_WINDOW_DAYS) && e.quality_score !== undefined)
    .sort((a, b) => new Date(b.ts!).getTime() - new Date(a.ts!).getTime())
    .slice(0, limit)
    .map((e) => ({
      ts: e.ts!,
      skill: e.skill ?? "—",
      score: e.quality_score!,
      iterations: e.iterations ?? 0,
    }));
}

export function loadDesignDocs(projectDir: string, limit = 10): DesignDoc[] {
  if (!existsSync(projectDir)) return [];
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => /-design-.*\.md$/.test(f));
  } catch {
    return [];
  }
  return files
    .map((name) => {
      const fullPath = join(projectDir, name);
      let mtime = 0;
      try {
        mtime = statSync(fullPath).mtimeMs;
      } catch {}
      return { name, fullPath, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

export function loadBacklog(cwd = process.cwd()): BacklogStats | null {
  const todosPath = join(cwd, "TODOS.md");
  if (!existsSync(todosPath)) return null;
  const todos = readFileSync(todosPath, "utf-8");
  const counts: BacklogStats = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0, unparsed: 0 };
  const re = /^### (P[0-4]):/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(todos)) !== null) {
    counts[m[1] as keyof BacklogStats]++;
  }
  return counts;
}

// ─── Assemblers ─────────────────────────────────────────────────────────────

export interface BuildOptions {
  slug?: string;
  home?: string;
  loadPr?: boolean;
  loadDecisions?: boolean;
}

export function buildDashboard(opts: BuildOptions = {}): DashboardData {
  const { loadPr = true, loadDecisions = true } = opts;
  const slug = resolveProjectSlug(opts.slug);
  const home = resolveGstackHome(opts.home);
  const projectDir = join(home, "projects", slug);
  const analyticsDir = join(home, "analytics");
  const branch = gitBranch() ?? "unknown";

  const timeline = loadTimeline(projectDir);
  const features = loadInFlightFeatures(timeline);
  const inFlightCount = features.filter(
    (f) => f.stagesReached.size > 0 && !f.stagesReached.has("ship") && !f.stagesReached.has("canary")
  ).length;

  const defaultBranch = loadPr ? resolveDefaultBranch() : null;
  const { ghAvailable, prMap } = loadPr
    ? loadPrData(features, defaultBranch)
    : { ghAvailable: false, prMap: new Map() };

  return {
    slug,
    branch,
    version: loadVersion(),
    generatedAt: new Date(),
    inFlightCount,
    features,
    activity: loadActivityFeed(timeline),
    velocity: loadVelocity(),
    topSkills: loadTopSkills(analyticsDir),
    quality: loadQualityHistory(analyticsDir),
    designDocs: loadDesignDocs(projectDir),
    backlog: loadBacklog(),
    openDecisions: loadDecisions ? loadOpenDecisions(projectDir) : null,
    ghAvailable,
    prMap,
    defaultBranch,
  };
}

export function buildOnelinerData(opts: { slug?: string; home?: string } = {}): OnelinerData {
  const slug = resolveProjectSlug(opts.slug);
  const home = resolveGstackHome(opts.home);
  const projectDir = join(home, "projects", slug);
  const branch = gitBranch() ?? "unknown";

  const timeline = loadTimeline(projectDir);
  const features = loadInFlightFeatures(timeline);
  const inFlightCount = features.filter(
    (f) => f.stagesReached.size > 0 && !f.stagesReached.has("ship") && !f.stagesReached.has("canary")
  ).length;

  const currentFeature = features.find((f) => f.branch === branch);
  const velocity = loadVelocity();
  const lastShipDate =
    velocity.recentVersions.length > 0
      ? velocity.recentVersions[velocity.recentVersions.length - 1].date
      : null;

  const backlog = loadBacklog();

  return {
    slug,
    branch,
    version: loadVersion(),
    inFlightCount,
    currentBranchStages: currentFeature?.stagesReached ?? new Set(),
    currentBranchLatestStage: currentFeature?.latestStage ?? null,
    p1Count: backlog?.P1 ?? null,
    lastShipDate,
  };
}
