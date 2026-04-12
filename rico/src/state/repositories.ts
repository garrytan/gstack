import type { Database } from "bun:sqlite";

export interface ProjectRecord {
  id: string;
  slackChannelId: string;
  priority: number;
  paused: boolean;
}

export interface InitiativeRecord {
  id: string;
  projectId: string;
  title: string;
  status: string;
}

export interface GoalRecord {
  id: string;
  initiativeId: string | null;
  projectId: string;
  title: string;
  state: string;
}

export interface RunRecord {
  id: string;
  goalId: string;
  status: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskRecord {
  id: string;
  goalId: string;
  runId: string;
  role: string;
  state: string;
  payloadJson: string;
}

export interface ApprovalRecord {
  id: string;
  goalId: string;
  type: string;
  status: string;
  rationale: string | null;
}

export interface ArtifactRecord {
  id: string;
  goalId: string;
  kind: string;
  localPath: string;
  slackFileId: string | null;
}

export interface StateTransitionRecord {
  id: string;
  goalId: string;
  fromState: string | null;
  toState: string;
  createdAt: string;
  actor: string;
}

export interface ExecutionSnapshot {
  goal: GoalRecord | null;
  run: RunRecord | null;
  tasks: TaskRecord[];
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

function one<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

export function createRepositories(db: Database) {
  const appendStateTransition = db.transaction((input: StateTransitionRecord) => {
    db.query(
      `insert into state_transitions (id, goal_id, from_state, to_state, created_at, actor)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.goalId, input.fromState, input.toState, input.createdAt, input.actor);

    const updateResult = db
      .query("update goals set state = ? where id = ?")
      .run(input.toState, input.goalId) as { changes?: number } | undefined;

    if (!updateResult || updateResult.changes !== 1) {
      throw new Error(`Cannot append state transition for missing goal: ${input.goalId}`);
    }
  });

  const projects = {
    create(input: { id: string; slackChannelId: string; priority?: number; paused?: boolean }) {
      db.query(
        `insert into projects (id, slack_channel_id, priority, paused)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           slack_channel_id = excluded.slack_channel_id,
           priority = excluded.priority,
           paused = excluded.paused`,
      ).run(input.id, input.slackChannelId, input.priority ?? 0, input.paused ? 1 : 0);
    },
    get(id: string): ProjectRecord | null {
      return one(
        db.query("select * from projects where id = ?").all(id).map((row: any) => ({
          id: row.id,
          slackChannelId: row.slack_channel_id,
          priority: row.priority,
          paused: toBoolean(row.paused),
        })),
      );
    },
    getBySlackChannelId(channelId: string): ProjectRecord | null {
      return one(
        db.query("select * from projects where slack_channel_id = ?").all(channelId).map((row: any) => ({
          id: row.id,
          slackChannelId: row.slack_channel_id,
          priority: row.priority,
          paused: toBoolean(row.paused),
        })),
      );
    },
    list(): ProjectRecord[] {
      return db.query("select * from projects order by id asc").all().map((row: any) => ({
        id: row.id,
        slackChannelId: row.slack_channel_id,
        priority: row.priority,
        paused: toBoolean(row.paused),
      }));
    },
  };

  const initiatives = {
    create(input: { id: string; projectId: string; title: string; status: string }) {
      db.query(
        `insert into initiatives (id, project_id, title, status)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           project_id = excluded.project_id,
           title = excluded.title,
           status = excluded.status`,
      ).run(input.id, input.projectId, input.title, input.status);
    },
    get(id: string): InitiativeRecord | null {
      return one(
        db.query("select * from initiatives where id = ?").all(id).map((row: any) => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          status: row.status,
        })),
      );
    },
    listByProject(projectId: string): InitiativeRecord[] {
      return db
        .query("select * from initiatives where project_id = ? order by id asc")
        .all(projectId)
        .map((row: any) => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          status: row.status,
        }));
    },
  };

  const goals = {
    create(input: {
      id: string;
      initiativeId: string | null;
      projectId: string;
      title: string;
      state: string;
    }) {
      db.query(
        `insert into goals (id, initiative_id, project_id, title, state)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           initiative_id = excluded.initiative_id,
           project_id = excluded.project_id,
           title = excluded.title,
           state = excluded.state`,
      ).run(input.id, input.initiativeId, input.projectId, input.title, input.state);
    },
    get(id: string): GoalRecord | null {
      return one(
        db.query("select * from goals where id = ?").all(id).map((row: any) => ({
          id: row.id,
          initiativeId: row.initiative_id,
          projectId: row.project_id,
          title: row.title,
          state: row.state,
        })),
      );
    },
    listByProject(projectId: string): GoalRecord[] {
      return db
        .query("select * from goals where project_id = ? order by id asc")
        .all(projectId)
        .map((row: any) => ({
          id: row.id,
          initiativeId: row.initiative_id,
          projectId: row.project_id,
          title: row.title,
          state: row.state,
        }));
    },
    updateState(goalId: string, state: string) {
      db.query("update goals set state = ? where id = ?").run(state, goalId);
    },
    getCurrentExecutionSnapshot(goalId: string): ExecutionSnapshot {
      const goal = goals.get(goalId);
      const run = one(
        db.query(
          `select * from runs
           where goal_id = ?
           order by
             case status when 'running' then 0 when 'in_progress' then 0 when 'queued' then 1 else 2 end asc,
             coalesce(started_at, queued_at, finished_at) desc,
             id desc
           limit 1`,
        ).all(goalId).map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          status: row.status,
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
      );
      const taskRows = run
        ? tasks.listByRun(run.id)
        : [];
      return { goal, run, tasks: taskRows };
    },
  };

  const runs = {
    create(input: {
      id: string;
      goalId: string;
      status: string;
      queuedAt: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }) {
      db.query(
        `insert into runs (id, goal_id, status, queued_at, started_at, finished_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           goal_id = excluded.goal_id,
           status = excluded.status,
           queued_at = excluded.queued_at,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
      ).run(
        input.id,
        input.goalId,
        input.status,
        input.queuedAt,
        input.startedAt,
        input.finishedAt,
      );
    },
    get(id: string): RunRecord | null {
      return one(
        db.query("select * from runs where id = ?").all(id).map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          status: row.status,
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
      );
    },
    listByGoal(goalId: string): RunRecord[] {
      return db
        .query("select * from runs where goal_id = ? order by coalesce(started_at, queued_at, finished_at) asc, id asc")
        .all(goalId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          status: row.status,
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        }));
    },
  };

  const tasks = {
    create(input: {
      id: string;
      goalId: string;
      runId: string;
      role: string;
      state: string;
      payloadJson: string;
    }) {
      db.query(
        `insert into tasks (id, goal_id, run_id, role, state, payload_json)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           goal_id = excluded.goal_id,
           run_id = excluded.run_id,
           role = excluded.role,
           state = excluded.state,
           payload_json = excluded.payload_json`,
      ).run(input.id, input.goalId, input.runId, input.role, input.state, input.payloadJson);
    },
    get(id: string): TaskRecord | null {
      return one(
        db.query("select * from tasks where id = ?").all(id).map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          runId: row.run_id,
          role: row.role,
          state: row.state,
          payloadJson: row.payload_json,
        })),
      );
    },
    listByGoal(goalId: string): TaskRecord[] {
      return db
        .query("select * from tasks where goal_id = ? order by run_id asc, id asc")
        .all(goalId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          runId: row.run_id,
          role: row.role,
          state: row.state,
          payloadJson: row.payload_json,
        }));
    },
    listByRun(runId: string): TaskRecord[] {
      return db
        .query("select * from tasks where run_id = ? order by id asc")
        .all(runId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          runId: row.run_id,
          role: row.role,
          state: row.state,
          payloadJson: row.payload_json,
        }));
    },
  };

  const approvals = {
    create(input: {
      id: string;
      goalId: string;
      type: string;
      status: string;
      rationale: string | null;
    }) {
      db.query(
        `insert into approvals (id, goal_id, type, status, rationale)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           goal_id = excluded.goal_id,
           type = excluded.type,
           status = excluded.status,
           rationale = excluded.rationale`,
      ).run(input.id, input.goalId, input.type, input.status, input.rationale);
    },
    listByGoal(goalId: string): ApprovalRecord[] {
      return db
        .query("select * from approvals where goal_id = ? order by id asc")
        .all(goalId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          type: row.type,
          status: row.status,
          rationale: row.rationale,
        }));
    },
  };

  const artifacts = {
    create(input: {
      id: string;
      goalId: string;
      kind: string;
      localPath: string;
      slackFileId: string | null;
    }) {
      db.query(
        `insert into artifacts (id, goal_id, kind, local_path, slack_file_id)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           goal_id = excluded.goal_id,
           kind = excluded.kind,
           local_path = excluded.local_path,
           slack_file_id = excluded.slack_file_id`,
      ).run(input.id, input.goalId, input.kind, input.localPath, input.slackFileId);
    },
    listByGoal(goalId: string): ArtifactRecord[] {
      return db
        .query("select * from artifacts where goal_id = ? order by id asc")
        .all(goalId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          kind: row.kind,
          localPath: row.local_path,
          slackFileId: row.slack_file_id,
        }));
    },
  };

  const stateTransitions = {
    append(input: StateTransitionRecord) {
      appendStateTransition(input);
    },
    listByGoal(goalId: string): StateTransitionRecord[] {
      return db
        .query(
          "select * from state_transitions where goal_id = ? order by created_at asc, id asc",
        )
        .all(goalId)
        .map((row: any) => ({
          id: row.id,
          goalId: row.goal_id,
          fromState: row.from_state,
          toState: row.to_state,
          createdAt: row.created_at,
          actor: row.actor,
        }));
    },
  };

  return {
    projects,
    initiatives,
    goals,
    runs,
    tasks,
    approvals,
    artifacts,
    stateTransitions,
  };
}
