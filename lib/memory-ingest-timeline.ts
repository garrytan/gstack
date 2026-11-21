import { existsSync, readFileSync, lstatSync, realpathSync } from "fs";
import { join } from "path";

export const TIMELINE_RENDERER_VERSION = 1;
// Conservative gbrain inline ceiling, including frontmatter. Larger segmented
// configurations exist, but this CLI does not discover their effective limit.
export const MAX_TIMELINE_PAGE_BYTES = 24 * 1024 * 1024;
// JSON may escape each input byte as six characters; leave bounded metadata room.
export const TIMELINE_READBACK_BYTES = MAX_TIMELINE_PAGE_BYTES * 6 + 1024 * 1024;
export function timelinePageFits(rendered: string): boolean {
  return Buffer.byteLength(rendered, "utf8") <= MAX_TIMELINE_PAGE_BYTES;
}

/** Optional narrow repair lane; no change to the default all-project walk. */
export function validateTimelineProject(
  root: string, project: string | undefined, sources: Set<string>, mode: string,
  requestReconcile: boolean, resumeDir?: string,
): void {
  if (project === undefined) return;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(project) || project.includes("..")) {
    throw new Error("--project requires one project slug, not a path");
  }
  if (sources.size !== 1 || !sources.has("timeline") || mode === "reconcile" || requestReconcile || resumeDir) {
    throw new Error("--project requires --sources timeline and cannot reconcile or resume a shared stage");
  }
  const statePath = join(root, ".transcript-ingest-state.json");
  if (existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).schema_version !== 2) {
    throw new Error("--project requires existing schema-2 state; migrate separately before scoped ingestion");
  }
  // Reject aliases before read/staging, including a timeline linked elsewhere.
  const projects = join(root, "projects");
  const dir = join(projects, project);
  const path = join(dir, "timeline.jsonl");
  if (lstatSync(projects).isSymbolicLink() || lstatSync(dir).isSymbolicLink() || lstatSync(path).isSymbolicLink()
      || !lstatSync(dir).isDirectory() || !lstatSync(path).isFile()
      || realpathSync(dir) !== join(realpathSync(projects), project)
      || realpathSync(path) !== join(realpathSync(dir), "timeline.jsonl")) {
    throw new Error("--project requires a regular project timeline with no symlink alias");
  }
}
