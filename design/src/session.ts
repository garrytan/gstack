/**
 * Session state management for multi-turn design iteration.
 * Session files are JSON in /tmp, keyed by PID + timestamp.
 */

import fs from "fs";
import path from "path";

export interface DesignSession {
  id: string;
  lastResponseId: string;
  originalBrief: string;
  feedbackHistory: string[];
  outputPaths: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Generate a unique session ID from PID + timestamp.
 */
export function createSessionId(): string {
  return `${process.pid}-${Date.now()}`;
}

/**
 * Get the file path for a session.
 */
export function sessionPath(sessionId: string): string {
  return path.join("/tmp", `design-session-${sessionId}.json`);
}

/**
 * Create a new session after initial generation.
 */
export function createSession(
  responseId: string,
  brief: string,
  outputPath: string,
): DesignSession {
  const id = createSessionId();
  const session: DesignSession = {
    id,
    lastResponseId: responseId,
    originalBrief: brief,
    feedbackHistory: [],
    outputPaths: [outputPath],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(sessionPath(id), JSON.stringify(session, null, 2), { mode: 0o600 });
  return session;
}

/**
 * Read an existing session from disk.
 */
export function readSession(sessionFilePath: string): DesignSession {
  const content = fs.readFileSync(sessionFilePath, "utf-8");
  return JSON.parse(content);
}

/**
 * Update a session with new iteration data.
 */
export function updateSession(
  session: DesignSession,
  responseId: string,
  feedback: string,
  outputPath: string,
): void {
  session.lastResponseId = responseId;
  session.feedbackHistory.push(feedback);
  session.outputPaths.push(outputPath);
  session.updatedAt = new Date().toISOString();

  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}
