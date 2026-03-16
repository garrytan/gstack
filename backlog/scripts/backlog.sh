#!/usr/bin/env bash
# gstack Backlog Management — persistent task tracking across Claude Code sessions
# Data stored in ~/.gstack/backlog.db (SQLite)
#
# Usage: backlog.sh <command> [args]
#   backlog.sh add <title> [--priority critical|important|suggestion] [--source review|qa|manual]
#   backlog.sh list [--status pending|completed|all] [--priority critical|important|suggestion] [--limit N]
#   backlog.sh complete <id>
#   backlog.sh delete <id>
#   backlog.sh search <query>
#   backlog.sh stats
#   backlog.sh next
#   backlog.sh start <id>
#   backlog.sh reset <id>
#   backlog.sh get <id>
#   backlog.sh dedup
#   backlog.sh cleanup

set -e

# Database location
GSTACK_DIR="$HOME/.gstack"
mkdir -p "$GSTACK_DIR"
DB_PATH="$GSTACK_DIR/backlog.db"

# Check if sqlite3 is available
if ! command -v sqlite3 &> /dev/null; then
    echo "Error: sqlite3 is required but not installed." >&2
    echo "Install with: brew install sqlite3 (macOS) or apt install sqlite3 (Linux)" >&2
    exit 1
fi

# Initialize database if needed
init_db() {
    if [ ! -f "$DB_PATH" ]; then
        sqlite3 "$DB_PATH" << 'SQL'
CREATE TABLE IF NOT EXISTS tasks_backlog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'manual',
    priority TEXT NOT NULL DEFAULT 'suggestion',
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT,
    line_number INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_backlog_status ON tasks_backlog(status);
CREATE INDEX IF NOT EXISTS idx_backlog_priority ON tasks_backlog(priority);
SQL
    fi
}

add_task() {
    local title="$1"
    local priority="${2:-suggestion}"
    local source="${3:-manual}"
    local description="${4:-}"
    local file_path="${5:-}"
    local line_number="${6:-}"

    if [ -z "$title" ]; then
        echo "Error: title is required" >&2
        echo "Usage: backlog.sh add <title> [--priority critical|important|suggestion] [--source review|qa|manual]" >&2
        exit 1
    fi

    init_db

    # Dedup: skip if an identical pending task already exists
    local escaped_title
    escaped_title=$(echo "$title" | sed "s/'/''/g")
    local existing
    existing=$(sqlite3 "$DB_PATH" "SELECT id FROM tasks_backlog WHERE title = '$escaped_title' AND status = 'pending' LIMIT 1;")
    if [ -n "$existing" ]; then
        echo "Skipped (duplicate of #$existing): $title"
        return 0
    fi

    local created_at
    created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local id
    id=$(sqlite3 "$DB_PATH" << SQL
INSERT INTO tasks_backlog (source, priority, title, description, file_path, line_number, status, created_at)
VALUES ('$source', '$priority', '$escaped_title',
        $([ -n "$description" ] && echo "'$(echo "$description" | sed "s/'/''/g")'" || echo "NULL"),
        $([ -n "$file_path" ] && echo "'$file_path'" || echo "NULL"),
        $([ -n "$line_number" ] && echo "$line_number" || echo "NULL"),
        'pending', '$created_at');
SELECT last_insert_rowid();
SQL
)

    echo "Added task #$id: $title (priority: $priority, source: $source)"
}

list_tasks() {
    local status_filter="${1:-pending}"
    local priority_filter="${2:-}"
    local limit="${3:-50}"

    init_db

    local where_clause="WHERE status != 'deleted'"

    if [ "$status_filter" != "all" ]; then
        where_clause="$where_clause AND status = '$status_filter'"
    fi

    if [ -n "$priority_filter" ]; then
        where_clause="$where_clause AND priority = '$priority_filter'"
    fi

    echo "=== Tasks Backlog ==="
    echo ""

    sqlite3 -header -column "$DB_PATH" << SQL
SELECT
    id,
    priority,
    substr(title, 1, 60) as title,
    source,
    status,
    date(created_at) as created
FROM tasks_backlog
$where_clause
ORDER BY
    CASE priority WHEN 'critical' THEN 1 WHEN 'important' THEN 2 WHEN 'suggestion' THEN 3 END,
    created_at DESC
LIMIT $limit;
SQL

    echo ""

    # Show summary counts
    local pending
    pending=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks_backlog WHERE status = 'pending'")
    local in_progress
    in_progress=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks_backlog WHERE status = 'in_progress'")
    local completed
    completed=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks_backlog WHERE status = 'completed'")

    echo "Summary: $pending pending, $in_progress in progress, $completed completed"
}

complete_task() {
    local id="$1"

    if [ -z "$id" ]; then
        echo "Error: task ID is required" >&2
        echo "Usage: backlog.sh complete <id>" >&2
        exit 1
    fi

    init_db

    local completed_at
    completed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local changes
    changes=$(sqlite3 "$DB_PATH" << SQL
UPDATE tasks_backlog SET status = 'completed', completed_at = '$completed_at' WHERE id = $id;
SELECT changes();
SQL
)

    if [ "$changes" -gt 0 ]; then
        echo "Completed task #$id"
    else
        echo "Task #$id not found" >&2
        exit 1
    fi
}

delete_task() {
    local id="$1"

    if [ -z "$id" ]; then
        echo "Error: task ID is required" >&2
        echo "Usage: backlog.sh delete <id>" >&2
        exit 1
    fi

    init_db

    local changes
    changes=$(sqlite3 "$DB_PATH" << SQL
UPDATE tasks_backlog SET status = 'deleted' WHERE id = $id;
SELECT changes();
SQL
)

    if [ "$changes" -gt 0 ]; then
        echo "Deleted task #$id"
    else
        echo "Task #$id not found" >&2
        exit 1
    fi
}

search_tasks() {
    local query="$1"

    if [ -z "$query" ]; then
        echo "Error: search query is required" >&2
        echo "Usage: backlog.sh search <query>" >&2
        exit 1
    fi

    init_db

    echo "=== Search Results for: $query ==="
    echo ""

    sqlite3 -header -column "$DB_PATH" << SQL
SELECT
    id,
    priority,
    substr(title, 1, 60) as title,
    source,
    status
FROM tasks_backlog
WHERE status != 'deleted'
  AND (title LIKE '%$query%' OR description LIKE '%$query%')
ORDER BY
    CASE priority WHEN 'critical' THEN 1 WHEN 'important' THEN 2 WHEN 'suggestion' THEN 3 END,
    created_at DESC
LIMIT 50;
SQL
}

show_stats() {
    init_db

    echo "=== Backlog Statistics ==="
    echo ""

    echo "By Status:"
    sqlite3 "$DB_PATH" "SELECT status, COUNT(*) as count FROM tasks_backlog GROUP BY status ORDER BY count DESC;"
    echo ""

    echo "By Priority (excluding deleted):"
    sqlite3 "$DB_PATH" "SELECT priority, COUNT(*) as count FROM tasks_backlog WHERE status != 'deleted' GROUP BY priority ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'important' THEN 2 WHEN 'suggestion' THEN 3 END;"
    echo ""

    echo "By Source (excluding deleted):"
    sqlite3 "$DB_PATH" "SELECT source, COUNT(*) as count FROM tasks_backlog WHERE status != 'deleted' GROUP BY source ORDER BY count DESC;"
}

get_task() {
    local id="$1"

    if [ -z "$id" ]; then
        echo "Error: task ID is required" >&2
        echo "Usage: backlog.sh get <id>" >&2
        exit 1
    fi

    init_db

    sqlite3 -header -column "$DB_PATH" << SQL
SELECT * FROM tasks_backlog WHERE id = $id;
SQL
}

next_task() {
    init_db

    local result
    result=$(sqlite3 -json "$DB_PATH" << 'SQL'
SELECT id, source, priority, title, description, file_path, line_number, status, created_at, metadata
FROM tasks_backlog
WHERE status = 'pending'
ORDER BY
    CASE priority
        WHEN 'critical' THEN 1
        WHEN 'important' THEN 2
        WHEN 'suggestion' THEN 3
    END,
    created_at ASC
LIMIT 1;
SQL
)

    if [ -z "$result" ] || [ "$result" = "[]" ]; then
        echo "{}"
        return 1
    fi

    # sqlite3 -json returns an array; extract the first element
    if command -v jq &> /dev/null; then
        echo "$result" | jq -c '.[0]'
    else
        # Fallback: return the raw array if jq is not available
        echo "$result"
    fi
}

start_task() {
    local id="$1"

    if [ -z "$id" ]; then
        echo "Error: task ID is required" >&2
        echo "Usage: backlog.sh start <id>" >&2
        exit 1
    fi

    init_db

    local changes
    changes=$(sqlite3 "$DB_PATH" << SQL
UPDATE tasks_backlog SET status = 'in_progress' WHERE id = $id AND status = 'pending';
SELECT changes();
SQL
)

    if [ "$changes" -gt 0 ]; then
        echo "Started task #$id"
    else
        echo "Task #$id not found or not in pending status" >&2
        exit 1
    fi
}

reset_task() {
    local id="$1"

    if [ -z "$id" ]; then
        echo "Error: task ID is required" >&2
        echo "Usage: backlog.sh reset <id>" >&2
        exit 1
    fi

    init_db

    local changes
    changes=$(sqlite3 "$DB_PATH" << SQL
UPDATE tasks_backlog SET status = 'pending' WHERE id = $id AND status = 'in_progress';
SELECT changes();
SQL
)

    if [ "$changes" -gt 0 ]; then
        echo "Reset task #$id to pending"
    else
        echo "Task #$id not found or not in_progress" >&2
        exit 1
    fi
}

dedup_tasks() {
    init_db

    # Find and remove duplicate pending tasks (keep lowest ID)
    local removed
    removed=$(sqlite3 "$DB_PATH" << 'SQL'
DELETE FROM tasks_backlog
WHERE id NOT IN (
    SELECT MIN(id) FROM tasks_backlog
    WHERE status = 'pending'
    GROUP BY title
)
AND status = 'pending'
AND id NOT IN (
    SELECT MIN(id) FROM tasks_backlog
    WHERE status = 'pending'
    GROUP BY title
);
SELECT changes();
SQL
)

    echo "Removed $removed duplicate pending tasks"
}

cleanup_garbage() {
    init_db

    # Remove entries that are clearly code fragments, not real tasks
    local removed
    removed=$(sqlite3 "$DB_PATH" << 'SQL'
UPDATE tasks_backlog SET status = 'deleted'
WHERE status = 'pending'
AND (
    length(title) < 10
    OR title LIKE '%${%'
    OR title LIKE '%$(%'
    OR title LIKE '%\${NC}%'
    OR title LIKE '%2>/dev/null%'
    OR title LIKE '%]; then%'
    OR title LIKE '%_FILES%'
    OR title LIKE '%...${%'
    OR title LIKE '%CHANGEME%'
    OR title GLOB '*[|]*[|]*'
);
SELECT changes();
SQL
)

    echo "Cleaned up $removed garbage entries"
}

show_help() {
    echo "gstack Backlog — Persistent Task Tracking"
    echo ""
    echo "Usage: backlog.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  add <title> [options]     - Add a new task (skips duplicates)"
    echo "    --priority <level>      - critical, important, or suggestion (default: suggestion)"
    echo "    --source <source>       - review, qa, or manual (default: manual)"
    echo "    --description <text>    - Optional description"
    echo "    --file <path>           - Optional file path reference"
    echo "    --line <number>         - Optional line number reference"
    echo ""
    echo "  list [options]            - List tasks"
    echo "    --status <status>       - pending, completed, or all (default: pending)"
    echo "    --priority <level>      - Filter by priority"
    echo "    --limit <n>             - Limit results (default: 50)"
    echo ""
    echo "  get <id>                  - Get full details of a task"
    echo "  complete <id>             - Mark task as completed"
    echo "  delete <id>               - Delete a task (soft delete)"
    echo "  search <query>            - Search tasks by title or description"
    echo "  stats                     - Show backlog statistics"
    echo "  next                      - Get highest-priority pending task (JSON)"
    echo "  start <id>                - Mark task as in_progress"
    echo "  reset <id>                - Reset in_progress task back to pending"
    echo "  dedup                     - Remove duplicate pending tasks"
    echo "  cleanup                   - Remove garbage entries (code fragments)"
    echo ""
    echo "Examples:"
    echo "  backlog.sh add 'Add input validation to API' --priority important --source review"
    echo "  backlog.sh list --status pending --priority critical"
    echo "  backlog.sh complete 42"
    echo "  backlog.sh search 'validation'"
    echo "  backlog.sh dedup"
    echo ""
    echo "Database: $DB_PATH"
}

# Parse command and arguments
command="${1:-}"
shift || true

case "$command" in
    add)
        # Parse options
        title=""
        priority="suggestion"
        source="manual"
        description=""
        file_path=""
        line_number=""

        while [[ $# -gt 0 ]]; do
            case "$1" in
                --priority) priority="$2"; shift 2 ;;
                --source) source="$2"; shift 2 ;;
                --description) description="$2"; shift 2 ;;
                --file) file_path="$2"; shift 2 ;;
                --line) line_number="$2"; shift 2 ;;
                *)
                    if [ -z "$title" ]; then
                        title="$1"
                    else
                        title="$title $1"
                    fi
                    shift
                    ;;
            esac
        done

        add_task "$title" "$priority" "$source" "$description" "$file_path" "$line_number"
        ;;
    list)
        status="pending"
        priority=""
        limit="50"

        while [[ $# -gt 0 ]]; do
            case "$1" in
                --status) status="$2"; shift 2 ;;
                --priority) priority="$2"; shift 2 ;;
                --limit) limit="$2"; shift 2 ;;
                *) shift ;;
            esac
        done

        list_tasks "$status" "$priority" "$limit"
        ;;
    get) get_task "$1" ;;
    complete) complete_task "$1" ;;
    delete) delete_task "$1" ;;
    search) search_tasks "$*" ;;
    stats) show_stats ;;
    next) next_task ;;
    start) start_task "$1" ;;
    reset) reset_task "$1" ;;
    dedup) dedup_tasks ;;
    cleanup) cleanup_garbage ;;
    -h|--help|help|"") show_help ;;
    *) echo "Unknown command: $command"; show_help; exit 1 ;;
esac
