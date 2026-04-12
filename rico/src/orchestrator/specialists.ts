import { MemoryStore } from "../memory/store";
import { ROLE_REGISTRY, type RoleName } from "../roles";
import {
  type ImpactLevel,
  type SpecialistResult,
  validateSpecialistResult,
} from "../roles/contracts";

export interface SpecialistImpact {
  role: string;
  level: ImpactLevel;
  message: string;
}

export function preserveSpecialistImpacts(
  impacts: SpecialistImpact[],
): SpecialistImpact[] {
  return impacts.map((impact) => ({ ...impact }));
}

export async function runSpecialist(input: {
  role: RoleName;
  input: Record<string, unknown>;
  memoryStore?: MemoryStore;
}) {
  const profile = ROLE_REGISTRY[input.role];
  if (!profile) {
    throw new Error(`unknown role: ${input.role}`);
  }

  const requestedSummary =
    typeof input.input.summary === "string" && input.input.summary.length > 0
      ? input.input.summary
      : `${profile.invoke} completed`;

  const result: SpecialistResult = {
    role: input.role,
    summary: requestedSummary,
    impact: profile.defaultImpact,
    artifacts: [{ kind: "report", title: `${input.role}-report.md` }],
    rawFindings: [profile.invoke],
  };

  const validated = validateSpecialistResult(result);
  if (!validated.ok) {
    throw new Error("invalid specialist output");
  }

  const projectId =
    typeof input.input.projectId === "string" ? input.input.projectId : null;
  const runId = typeof input.input.runId === "string" ? input.input.runId : null;

  if (input.memoryStore && projectId) {
    input.memoryStore.putProjectFact(
      projectId,
      `specialist.${input.role}.last_summary`,
      result.summary,
    );
    input.memoryStore.putProjectFact(
      projectId,
      `specialist.${input.role}.last_result_json`,
      JSON.stringify(result),
    );
  }
  if (input.memoryStore && runId) {
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.impact`,
      result.impact,
    );
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.summary`,
      result.summary,
    );
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.result_json`,
      JSON.stringify(result),
    );
  }

  return result;
}
