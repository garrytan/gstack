import { errorWithCode } from "./errors.js";

export const EXECUTION_RESULT_SCHEMA_VERSION = 1;
export const EXECUTION_RESULT_STATUSES = Object.freeze([
  "success",
  "degraded",
  "unsupported",
  "failed",
]);

export const EXECUTION_RESULT_ERROR_CODES = Object.freeze({
  EMPTY: "EXECUTION_EMPTY",
  MALFORMED: "EXECUTION_MALFORMED",
  DEGRADED: "EXECUTION_DEGRADED",
  UNSUPPORTED: "EXECUTION_UNSUPPORTED",
  FAILED: "EXECUTION_FAILED",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  CAPABILITY_FAILED: "CAPABILITY_FAILED",
});

export const EXECUTION_RESULT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://gstack.dev/schemas/execution-result-v1.json",
  title: "GStack execution result",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "status", "code", "summary", "evidence", "data"],
  properties: {
    schemaVersion: { const: EXECUTION_RESULT_SCHEMA_VERSION },
    status: { enum: EXECUTION_RESULT_STATUSES },
    code: { type: ["string", "null"], pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
    summary: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    data: {},
  },
  allOf: [
    { if: { properties: { status: { const: "success" } } }, then: { properties: { code: { type: "null" }, evidence: { minItems: 1 } } } },
    { if: { properties: { status: { enum: ["degraded", "unsupported", "failed"] } } }, then: { properties: { code: { type: "string" } } } },
  ],
});

/** Validate the host-neutral result before any caller can render it as success. */
export function validateExecutionResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Execution result must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["code", "data", "evidence", "schemaVersion", "status", "summary"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return invalid("Execution result contains missing or unknown fields");
  if (value.schemaVersion !== EXECUTION_RESULT_SCHEMA_VERSION) return invalid("Execution result schema version is unsupported");
  if (!EXECUTION_RESULT_STATUSES.includes(value.status)) return invalid("Execution result status is unsupported");
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) return invalid("Execution result summary is empty");
  if (!Array.isArray(value.evidence) || value.evidence.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return invalid("Execution result evidence is malformed");
  }
  if (value.status === "success") {
    if (value.code !== null) return invalid("Successful execution must not carry an error code");
    if (value.evidence.length === 0) return invalid("Successful execution requires evidence", EXECUTION_RESULT_ERROR_CODES.EMPTY);
  } else if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)) {
    return invalid("Non-success execution requires a stable error code");
  }
  return Object.freeze({ ...value, evidence: Object.freeze([...value.evidence]) });
}

export function executionResult(input) {
  return validateExecutionResult({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    status: input.status,
    code: input.code ?? null,
    summary: input.summary,
    evidence: input.evidence ?? [],
    data: input.data ?? null,
  });
}

export function renderExecutionResult(result, options = {}) {
  const valid = validateExecutionResult(result);
  if (options.json) return `${JSON.stringify(valid, null, 2)}\n`;
  const label = valid.status.toUpperCase();
  const code = valid.code ? ` [${valid.code}]` : "";
  const evidence = valid.evidence.map((item) => `- ${item}`).join("\n");
  return `${label}${code}: ${valid.summary}${evidence ? `\nEvidence:\n${evidence}` : ""}\n`;
}

export function assertSuccessfulExecution(result) {
  const valid = validateExecutionResult(result);
  if (valid.status === "success") return valid;
  throw errorWithCode(valid.summary, valid.code);
}

function invalid(message, code = EXECUTION_RESULT_ERROR_CODES.MALFORMED) {
  throw errorWithCode(message, code);
}
