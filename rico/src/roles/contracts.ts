export type ImpactLevel = "info" | "approval_needed" | "blocking";
export type SpecialistExecutionMode = "analyze" | "write";

export interface SpecialistArtifact {
  kind: string;
  title: string;
}

export interface SpecialistResult {
  role: string;
  summary: string;
  impact: ImpactLevel;
  artifacts: SpecialistArtifact[];
  rawFindings?: string[];
  executionMode?: SpecialistExecutionMode;
  changedFiles?: string[];
  verificationNotes?: string[];
}

export function validateSpecialistResult(input: SpecialistResult) {
  if (!input.role || !input.summary || !input.impact) {
    return { ok: false as const };
  }
  if (
    !Array.isArray(input.artifacts) ||
    input.artifacts.some((artifact) => !artifact.kind || !artifact.title)
  ) {
    return { ok: false as const };
  }
  if (
    input.executionMode != null
    && input.executionMode !== "analyze"
    && input.executionMode !== "write"
  ) {
    return { ok: false as const };
  }
  if (
    input.changedFiles != null
    && (!Array.isArray(input.changedFiles) || input.changedFiles.some((path) => !path))
  ) {
    return { ok: false as const };
  }
  if (
    input.verificationNotes != null
    && (
      !Array.isArray(input.verificationNotes)
      || input.verificationNotes.some((note) => !note)
    )
  ) {
    return { ok: false as const };
  }

  return { ok: true as const };
}
