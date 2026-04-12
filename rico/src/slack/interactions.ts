import type { Database } from "bun:sqlite";

export interface HandleApprovalInteractionInput {
  db: Database;
  action: "approve" | "reject";
  approvalId: string;
  actor: string;
  now?: () => string;
}

export interface HandleApprovalInteractionResult {
  nextState: "approved" | "rejected";
  threadMessage: string;
}

interface ApprovalLookup {
  goalId: string;
  type: string;
  rationale: string | null;
  status: string;
  goalState: string;
}

function findApproval(db: Database, approvalId: string): ApprovalLookup | null {
  const row = db
    .query(
      `select
         approvals.goal_id as goal_id,
         approvals.type as type,
         approvals.rationale as rationale,
         approvals.status as status,
         goals.state as goal_state
       from approvals
       inner join goals on goals.id = approvals.goal_id
       where approvals.id = ?`,
    )
    .get(approvalId) as
    | {
        goal_id: string;
        type: string;
        rationale: string | null;
        status: string;
        goal_state: string;
      }
    | null;

  if (!row) {
    return null;
  }

  return {
    goalId: row.goal_id,
    type: row.type,
    rationale: row.rationale,
    status: row.status,
    goalState: row.goal_state,
  };
}

export async function handleApprovalInteraction(
  input: HandleApprovalInteractionInput,
): Promise<HandleApprovalInteractionResult> {
  const nextState = input.action === "approve" ? "approved" : "rejected";
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const approval = input.db.transaction(() => {
    const currentApproval = findApproval(input.db, input.approvalId);
    if (!currentApproval) {
      throw new Error(`Approval not found: ${input.approvalId}`);
    }
    if (currentApproval.status !== "pending") {
      throw new Error("approval is already resolved");
    }

    input.db
      .query("update approvals set status = ? where id = ?")
      .run(nextState, input.approvalId);
    input.db
      .query(
        `insert into state_transitions (id, goal_id, from_state, to_state, created_at, actor)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${input.approvalId}:${input.action}:${createdAt}`,
        currentApproval.goalId,
        currentApproval.goalState,
        nextState,
        createdAt,
        input.actor,
      );
    const updateResult = input.db
      .query("update goals set state = ? where id = ?")
      .run(nextState, currentApproval.goalId) as { changes?: number } | undefined;
    if (!updateResult || updateResult.changes !== 1) {
      throw new Error(`Goal not found for approval: ${input.approvalId}`);
    }

    return currentApproval;
  })();

  return {
    nextState,
    threadMessage: `[Governor] Approval ${input.approvalId} ${nextState} for ${approval.type} by ${input.actor} at ${createdAt}.`,
  };
}
