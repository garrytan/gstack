/**
 * bams-db/sync-board.ts
 *
 * DB 태스크를 board.md 형식으로 동기화하는 스크립트
 *
 * 기능:
 *   1. DB에서 태스크를 읽어 board.md 형식으로 출력 (dry-run)
 *   2. 파이프라인 완료 시 .crew/board.md를 DB 스냅샷으로 갱신
 *
 * 실행:
 *   bun run plugins/bams-plugin/tools/bams-db/sync-board.ts [pipeline_slug] [--write]
 *   --write 플래그 없으면 stdout만 출력 (dry-run)
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { TaskDB } from "./index.ts";
import type { Task } from "./schema.ts";

const DEFAULT_DB_PATH = join(homedir(), ".claude", "plugins", "marketplaces", "my-claude", "bams.db");
const DEFAULT_BOARD_PATH = ".crew/board.md";

// ─────────────────────────────────────────────────────────────
// 태스크 → board.md 형식 변환
// ─────────────────────────────────────────────────────────────

const STATUS_SECTIONS: Record<string, string> = {
  in_progress: "In Progress",
  backlog: "Backlog",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const STATUS_ORDER = ["in_progress", "backlog", "blocked", "done", "cancelled"];

function taskToMarkdown(task: Task): string {
  // 제목에서 ID 추출 (예: "DBI-001: 제목" → id="DBI-001", title="제목")
  const titleMatch = task.title.match(/^([\w-]+):\s*(.+)$/);
  const id = titleMatch?.[1] ?? task.id.slice(0, 8);
  const displayTitle = titleMatch?.[2] ?? task.title;

  const lines: string[] = [`### ${id}: ${displayTitle}`];

  if (task.priority && task.priority !== "medium") {
    lines.push(`- **우선순위**: ${task.priority}`);
  }
  if (task.assignee_agent) {
    lines.push(`- **담당**: ${task.assignee_agent}`);
  }
  if (task.size) {
    lines.push(`- **크기**: ${task.size}`);
  }
  if (task.phase != null) {
    lines.push(`- **Phase**: ${task.phase}`);
  }
  if (task.step) {
    lines.push(`- **Step**: ${task.step}`);
  }

  // tags: JSON string → 배열
  if (task.tags) {
    try {
      const tags = JSON.parse(task.tags) as string[];
      if (tags.length > 0) {
        lines.push(`- **태그**: ${tags.join(", ")}`);
      }
    } catch {}
  }

  // deps: JSON string → 배열
  if (task.deps) {
    try {
      const deps = JSON.parse(task.deps) as string[];
      if (deps.length > 0) {
        lines.push(`- **의존성**: ${deps.join(", ")}`);
      }
    } catch {}
  }

  if (task.description) {
    lines.push("");
    lines.push(task.description);
  }

  return lines.join("\n");
}

function generateBoardMd(pipelineSlug: string, tasks: Task[]): string {
  const header = `# Task Board\n\n> 슬러그: ${pipelineSlug}\n> 생성: ${new Date().toISOString().slice(0, 10)} (DB 동기화)\n`;

  // 상태별로 그룹화
  const grouped: Record<string, Task[]> = {};
  for (const status of STATUS_ORDER) {
    grouped[status] = [];
  }
  for (const task of tasks) {
    if (grouped[task.status]) {
      grouped[task.status].push(task);
    }
  }

  const sections: string[] = [header];

  for (const status of STATUS_ORDER) {
    const sectionTasks = grouped[status];
    if (sectionTasks.length === 0) continue;

    sections.push(`## ${STATUS_SECTIONS[status]}\n`);
    for (const task of sectionTasks) {
      sections.push(taskToMarkdown(task));
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const pipelineSlug = args.find((a) => !a.startsWith("--")) ?? "";
  const doWrite = args.includes("--write");
  const dbPath = args.find((a) => a.startsWith("--db="))?.replace("--db=", "") ?? DEFAULT_DB_PATH;
  const boardPath = args.find((a) => a.startsWith("--board="))?.replace("--board=", "") ?? DEFAULT_BOARD_PATH;

  if (!pipelineSlug) {
    console.error("사용법: bun sync-board.ts <pipeline_slug> [--write] [--db=경로] [--board=경로]");
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`DB 없음: ${dbPath}`);
    process.exit(1);
  }

  const db = new TaskDB(dbPath);
  const tasks = db.getTasksByPipeline(pipelineSlug);

  if (tasks.length === 0) {
    console.log(`파이프라인 '${pipelineSlug}'에 태스크 없음`);
    db.close();
    return;
  }

  const boardContent = generateBoardMd(pipelineSlug, tasks);

  if (doWrite) {
    const dir = dirname(boardPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(boardPath, boardContent, "utf-8");
    console.log(`board.md 갱신 완료: ${boardPath} (${tasks.length}개 태스크)`);
  } else {
    // dry-run: stdout 출력
    console.log(`=== board.md 미리보기 (pipeline: ${pipelineSlug}, ${tasks.length}개 태스크) ===\n`);
    console.log(boardContent);
  }

  const summary = db.getPipelineSummary(pipelineSlug);
  console.log(`\n--- 요약 ---`);
  console.log(`전체: ${summary.total} | in_progress: ${summary.in_progress} | done: ${summary.done} | backlog: ${summary.backlog} | blocked: ${summary.blocked}`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
