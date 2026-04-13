import { randomUUID } from "node:crypto";
import { MemoryStore } from "../memory/store";
import {
  readProjectCustomerVoiceProfile,
  writeProjectCustomerVoiceProfile,
  type CustomerVoiceMode,
  type CustomerVoicePersona,
  type CustomerVoiceProjectProfile,
} from "../orchestrator/customer-voice-director";

export type CustomerVoiceCommand =
  | { type: "status" }
  | { type: "set-mode"; mode: CustomerVoiceMode }
  | { type: "set-base-url"; baseUrl: string }
  | { type: "set-journeys"; journeys: string[] }
  | { type: "set-credentials"; credentialRefs: string[] }
  | { type: "set-simulation"; enabled: boolean }
  | { type: "set-notes"; notes: string | null }
  | {
      type: "add-persona";
      persona: Omit<CustomerVoicePersona, "id">;
    };

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function splitList(value: string) {
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function stripSlackLinkWrapping(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^<([^|>]+)(?:\|[^>]+)?>$/);
  return match?.[1]?.trim() ?? trimmed;
}

function toBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  return ["on", "true", "enabled", "enable", "켜기", "활성", "활성화"].includes(normalized);
}

export function parseCustomerVoiceCommand(text: string): CustomerVoiceCommand | null {
  const normalized = normalizeText(text);

  if (/^고객\s*관점\s+상태$/i.test(normalized)) {
    return { type: "status" };
  }

  const modeMatch = normalized.match(/^고객\s*관점\s+모드\s*:\s*(generic|persona-driven)$/i);
  if (modeMatch?.[1]) {
    return {
      type: "set-mode",
      mode: modeMatch[1].toLowerCase() === "persona-driven" ? "persona-driven" : "generic",
    };
  }

  const baseUrlMatch = normalized.match(/^고객\s*관점\s+(?:base-url|베이스\s*url|base\s*url)\s*:\s*(\S+)$/i);
  if (baseUrlMatch?.[1]) {
    return {
      type: "set-base-url",
      baseUrl: stripSlackLinkWrapping(baseUrlMatch[1]),
    };
  }

  const journeysMatch = normalized.match(/^고객\s*관점\s+(?:여정|journeys?)\s*:\s*(.+)$/i);
  if (journeysMatch?.[1]) {
    return {
      type: "set-journeys",
      journeys: splitList(journeysMatch[1]),
    };
  }

  const credentialsMatch = normalized.match(/^고객\s*관점\s+(?:계정|credentials?)\s*:\s*(.+)$/i);
  if (credentialsMatch?.[1]) {
    return {
      type: "set-credentials",
      credentialRefs: splitList(credentialsMatch[1]),
    };
  }

  const simulationMatch = normalized.match(/^고객\s*관점\s+시뮬레이션\s*:\s*(.+)$/i);
  if (simulationMatch?.[1]) {
    return {
      type: "set-simulation",
      enabled: toBoolean(simulationMatch[1]),
    };
  }

  const notesMatch = normalized.match(/^고객\s*관점\s+메모\s*:\s*(.+)$/i);
  if (notesMatch?.[1]) {
    return {
      type: "set-notes",
      notes: notesMatch[1].trim(),
    };
  }

  const personaMatch = normalized.match(/^고객\s*관점\s+페르소나\s+추가\s*:\s*(.+)$/i);
  if (personaMatch?.[1]) {
    const parts = personaMatch[1].split("|").map((part) => part.trim());
    if (parts.length < 5) return null;
    return {
      type: "add-persona",
      persona: {
        label: parts[0]!,
        jobToBeDone: parts[1]!,
        pains: splitList(parts[2]!),
        triggers: splitList(parts[3]!),
        desiredOutcome: parts.slice(4).join(" | ").trim(),
      },
    };
  }

  return null;
}

function buildPersonaId(label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9가-힣-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `persona-${randomUUID()}`;
}

export function applyCustomerVoiceCommand(input: {
  memoryStore: MemoryStore;
  projectId: string;
  command: Exclude<CustomerVoiceCommand, { type: "status" }>;
}) {
  const profile = readProjectCustomerVoiceProfile({
    memoryStore: input.memoryStore,
    projectId: input.projectId,
  });

  const nextProfile: CustomerVoiceProjectProfile = {
    ...profile,
    personas: [...profile.personas],
    simulation: {
      ...profile.simulation,
    },
  };

  switch (input.command.type) {
    case "set-mode":
      nextProfile.mode = input.command.mode;
      nextProfile.needsSetup = false;
      break;
    case "set-base-url":
      nextProfile.simulation.baseUrl = stripSlackLinkWrapping(input.command.baseUrl);
      break;
    case "set-journeys":
      nextProfile.simulation.allowedJourneys = [...new Set(input.command.journeys)];
      break;
    case "set-credentials":
      nextProfile.simulation.credentialRefs = [...new Set(input.command.credentialRefs)];
      nextProfile.simulation.requiresCredentials = nextProfile.simulation.credentialRefs.length > 0;
      break;
    case "set-simulation":
      nextProfile.simulation.enabled = input.command.enabled;
      break;
    case "set-notes":
      nextProfile.notes = input.command.notes;
      break;
    case "add-persona":
      nextProfile.mode = "persona-driven";
      nextProfile.needsSetup = false;
      nextProfile.personas = nextProfile.personas.concat({
        id: buildPersonaId(input.command.persona.label),
        ...input.command.persona,
      });
      break;
  }

  writeProjectCustomerVoiceProfile({
    memoryStore: input.memoryStore,
    projectId: input.projectId,
    profile: nextProfile,
  });

  return nextProfile;
}

export function buildCustomerVoiceStatusText(input: {
  projectId: string;
  profile: CustomerVoiceProjectProfile;
}) {
  const simulationBits = [
    input.profile.simulation.enabled ? "켜짐" : "꺼짐",
    input.profile.simulation.baseUrl ? input.profile.simulation.baseUrl : "base URL 미설정",
  ];
  if (input.profile.simulation.allowedJourneys.length > 0) {
    simulationBits.push(`여정 ${input.profile.simulation.allowedJourneys.join(", ")}`);
  }
  if (input.profile.simulation.credentialRefs.length > 0) {
    simulationBits.push(`계정 ${input.profile.simulation.credentialRefs.join(", ")}`);
  }

  const personaLines = input.profile.personas.length > 0
    ? input.profile.personas.map((persona) => `  • ${persona.label}: ${persona.jobToBeDone}`)
    : ["  • 아직 등록된 페르소나가 없어요."];

  const lines = [
    "🗣️ 고객관점 설정",
    `- 프로젝트: #${input.projectId}`,
    `- 모드: ${input.profile.mode}`,
    `- 추가 설정 필요: ${input.profile.needsSetup ? "예" : "아니오"}`,
    `- 시뮬레이션: ${simulationBits.join(" / ")}`,
    "- 페르소나:",
    ...personaLines,
  ];

  if (input.profile.notes) {
    lines.push(`- 메모: ${input.profile.notes}`);
  }

  return lines.join("\n");
}
