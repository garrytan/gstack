/**
 * bams-db/init-db.ts
 *
 * 글로벌 bams.db 초기화 스크립트 (~/.claude/plugins/marketplaces/my-claude/bams.db)
 *
 * 기능:
 *   1. ~/.claude/plugins/marketplaces/my-claude/ 디렉터리 생성
 *   2. bams.db SQLite 파일 생성 + 스키마 실행
 *   3. 기존 board.md가 있으면 마이그레이션 제안
 *
 * 실행:
 *   bun run plugins/bams-plugin/tools/bams-db/init-db.ts [--db=경로] [--migrate]
 *   --migrate 플래그: board.md → DB 자동 마이그레이션 수행
 */

import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { TaskDB } from "./index.ts";

const DEFAULT_DB_PATH = join(homedir(), ".claude", "plugins", "marketplaces", "my-claude", "bams.db");
const DEFAULT_BOARD_PATH = ".crew/board.md";

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => a.startsWith("--db="))?.replace("--db=", "") ?? DEFAULT_DB_PATH;
  const boardPath = args.find((a) => a.startsWith("--board="))?.replace("--board=", "") ?? DEFAULT_BOARD_PATH;
  const doMigrate = args.includes("--migrate");

  console.log("=== bams-db 초기화 ===");
  console.log(`DB 경로: ${dbPath}`);

  // 이미 존재하면 상태만 출력
  if (existsSync(dbPath)) {
    console.log("DB가 이미 존재합니다. 스키마 idempotent 재실행...");
    const db = new TaskDB(dbPath);
    console.log("스키마 확인 완료 (변경 없음).");
    db.close();
  } else {
    // .crew/db/ 디렉터리 생성
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`디렉터리 생성: ${dir}`);
    }

    // DB 생성 + 스키마 실행 (TaskDB 생성자가 initSchema() 호출)
    const db = new TaskDB(dbPath);
    console.log("DB 생성 완료.");
    console.log("스키마 적용 완료 (tasks, task_events, token_usage, budget_policies, run_logs).");
    db.close();
  }

  // board.md 마이그레이션 제안 / 실행
  if (existsSync(boardPath)) {
    if (doMigrate) {
      console.log(`\nboard.md 마이그레이션 시작: ${boardPath}`);
      // migrate-board.ts를 동적 import하여 실행
      try {
        const { execSync } = await import("child_process");
        execSync(
          `bun run "${import.meta.dir}/migrate-board.ts" "${boardPath}" "${dbPath}"`,
          { stdio: "inherit" }
        );
      } catch (err) {
        console.error("마이그레이션 실패:", err);
      }
    } else {
      console.log(`\n기존 board.md 발견: ${boardPath}`);
      console.log("마이그레이션하려면 --migrate 플래그를 추가하세요:");
      console.log(`  bun run plugins/bams-plugin/tools/bams-db/init-db.ts --migrate`);
    }
  } else {
    console.log("\nboard.md 없음 — 마이그레이션 건너뜀.");
  }

  console.log("\n=== 초기화 완료 ===");
  console.log(`사용법:`);
  console.log(`  태스크 등록:   bun -e "import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts'; const db = new TaskDB(); db.createTask({ pipeline_slug: 'my-pipeline', title: 'My Task' }); db.close();"`);
  console.log(`  board.md 동기화: bun run plugins/bams-plugin/tools/bams-db/sync-board.ts <slug> --write`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
