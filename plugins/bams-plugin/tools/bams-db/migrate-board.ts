/**
 * bams-db/migrate-board.ts
 *
 * board.md 텍스트 파싱 → SQLite DB 이전 스크립트
 *
 * 실행: bun run plugins/bams-plugin/tools/bams-db/migrate-board.ts
 * 또는: bun plugins/bams-plugin/tools/bams-db/migrate-board.ts [board.md 경로] [db 경로]
 */

import { readFileSync, existsSync } from "fs";
import { TaskDB, TASK_STATUS } from "./index.ts";
import type { TaskStatus, TaskPriority, TaskSize } from "./schema.ts";

// ─────────────────────────────────────────────────────────────
// board.md 파싱
// ─────────────────────────────────────────────────────────────

interface ParsedTask {
  id: string;               // 원본 식별자 (e.g. "REF-A1")
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  size: TaskSize | null;
  assignee_agent: string | null;
  phase: number | null;
  step: string | null;
  tags: string[];
  deps: string[];
}

/**
 * board.md 섹션 헤더 → status 매핑
 */
const SECTION_STATUS_MAP: Record<string, TaskStatus> = {
  "In Progress": TASK_STATUS.IN_PROGRESS,
  "Backlog": TASK_STATUS.BACKLOG,
  "Done": TASK_STATUS.DONE,
  "Blocked": TASK_STATUS.BLOCKED,
  "Cancelled": TASK_STATUS.CANCELLED,
};

/**
 * board.md 내용을 파싱하여 태스크 목록을 반환한다.
 *
 * 지원 형식:
 *   ## In Progress
 *   ### REF-A1: 태스크 제목
 *   - **우선순위**: high
 *   - **담당**: backend-engineering
 *   - **크기**: L
 *   - **Phase**: 2
 *   - **태그**: backend, infra
 *   - **의존성**: REF-A2, REF-A3
 *   [설명 텍스트]
 */
function parseBoardMd(content: string, pipelineSlug: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // 섹션별 분리 (## 헤더 기준)
  const sectionRegex = /^## (.+)$/gm;
  const sections: Array<{ name: string; content: string }> = [];

  let lastIndex = 0;
  let lastSection = "";
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(content)) !== null) {
    if (lastSection) {
      sections.push({
        name: lastSection,
        content: content.slice(lastIndex, match.index),
      });
    }
    lastSection = match[1].trim();
    lastIndex = match.index + match[0].length;
  }
  if (lastSection) {
    sections.push({ name: lastSection, content: content.slice(lastIndex) });
  }

  for (const section of sections) {
    const status = SECTION_STATUS_MAP[section.name];
    if (!status) continue;  // Task Board 헤더 등 비태스크 섹션 건너뜀

    // ### 태스크 분리
    const taskRegex = /^### ([\w-]+):\s*(.+)$/gm;
    let taskMatch: RegExpExecArray | null;

    const taskPositions: Array<{ id: string; title: string; start: number }> = [];
    while ((taskMatch = taskRegex.exec(section.content)) !== null) {
      taskPositions.push({
        id: taskMatch[1].trim(),
        title: taskMatch[2].trim(),
        start: taskMatch.index + taskMatch[0].length,
      });
    }

    for (let i = 0; i < taskPositions.length; i++) {
      const pos = taskPositions[i];
      const end = i + 1 < taskPositions.length
        ? taskPositions[i + 1].start - taskPositions[i + 1].id.length - 10
        : section.content.length;

      const body = section.content.slice(pos.start, end).trim();

      // 메타데이터 파싱
      const priorityMatch = body.match(/[-*]\s*\*\*우선순위\*\*:\s*(\w+)/);
      const assigneeMatch = body.match(/[-*]\s*\*\*담당\*\*:\s*([\w-]+)/);
      const sizeMatch = body.match(/[-*]\s*\*\*크기\*\*:\s*(XS|S|M|L|XL)/);
      const phaseMatch = body.match(/[-*]\s*\*\*Phase\*\*:\s*(\d+)/);
      const stepMatch = body.match(/[-*]\s*\*\*Step\*\*:\s*([\w-]+)/);
      const tagsMatch = body.match(/[-*]\s*\*\*태그\*\*:\s*(.+)/);
      const depsMatch = body.match(/[-*]\s*\*\*의존성\*\*:\s*(.+)/);

      // 설명: 메타데이터 행 제거 후 나머지
      const description = body
        .replace(/[-*]\s*\*\*[^*]+\*\*:.+\n?/g, "")
        .trim();

      tasks.push({
        id: pos.id,
        title: `${pos.id}: ${pos.title}`,
        description,
        status,
        priority: (priorityMatch?.[1] as TaskPriority) ?? "medium",
        size: (sizeMatch?.[1] as TaskSize) ?? null,
        assignee_agent: assigneeMatch?.[1] ?? null,
        phase: phaseMatch ? parseInt(phaseMatch[1], 10) : null,
        step: stepMatch?.[1] ?? null,
        tags: tagsMatch?.[1]?.split(",").map((t) => t.trim()) ?? [],
        deps: depsMatch?.[1]?.split(",").map((d) => d.trim()) ?? [],
      });
    }
  }

  return tasks;
}

// ─────────────────────────────────────────────────────────────
// 마이그레이션 실행
// ─────────────────────────────────────────────────────────────

async function migrate(boardPath: string, dbPath: string) {
  console.log(`=== board.md → SQLite 마이그레이션 ===`);
  console.log(`입력: ${boardPath}`);
  console.log(`출력: ${dbPath}`);
  console.log("");

  if (!existsSync(boardPath)) {
    console.error(`오류: board.md 파일 없음: ${boardPath}`);
    process.exit(1);
  }

  const content = readFileSync(boardPath, "utf-8");

  // 파이프라인 슬러그 추출 (board.md 헤더에서)
  const slugMatch = content.match(/>\s*슬러그:\s*([\w-]+)/);
  const projectMatch = content.match(/>\s*프로젝트:\s*(.+)/);
  const pipelineSlug = slugMatch?.[1] ?? projectMatch?.[1]?.trim() ?? "default";
  console.log(`파이프라인 슬러그: ${pipelineSlug}`);

  const tasks = parseBoardMd(content, pipelineSlug);
  console.log(`파싱된 태스크: ${tasks.length}개`);
  console.log("");

  const db = new TaskDB(dbPath);

  let created = 0;
  let skipped = 0;

  for (const task of tasks) {
    try {
      db.createTask({
        pipeline_slug: pipelineSlug,
        title: task.title,
        description: task.description || undefined,
        phase: task.phase ?? undefined,
        step: task.step ?? undefined,
        priority: task.priority,
        size: task.size ?? undefined,
        assignee_agent: task.assignee_agent ?? undefined,
        deps: task.deps.length > 0 ? task.deps : undefined,
        tags: task.tags.length > 0 ? task.tags : undefined,
      });
      console.log(`  ✓ ${task.id}: ${task.status}`);
      created++;
    } catch (err) {
      console.warn(`  ⚠ ${task.id} 건너뜀: ${err}`);
      skipped++;
    }
  }

  console.log("");
  console.log(`=== 완료 ===`);
  console.log(`생성: ${created}개`);
  console.log(`건너뜀: ${skipped}개`);

  const summary = db.getPipelineSummary(pipelineSlug);
  console.log("");
  console.log("DB 요약:");
  console.log(`  전체: ${summary.total}`);
  console.log(`  backlog: ${summary.backlog}`);
  console.log(`  in_progress: ${summary.in_progress}`);
  console.log(`  done: ${summary.done}`);
  console.log(`  blocked: ${summary.blocked}`);

  db.close();
}

// CLI 실행
const boardPath = process.argv[2] ?? ".crew/board.md";
const dbPath = process.argv[3] ?? (require("path").join(require("os").homedir(), ".claude", "plugins", "marketplaces", "my-claude", "bams.db"));
migrate(boardPath, dbPath).catch(console.error);
