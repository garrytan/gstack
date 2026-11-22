/**
 * Request checks for the design daemon: every route except /health needs
 * the per-daemon secret from the private state file, and only loopback
 * Host and Origin values are served. Spawns a real daemon so Host comes
 * from the wire, the way Bun.serve sees it in production.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

import { publishBoard } from "../src/daemon-client";
import { makeBoardHtml, makeTmpDir, spawnDaemonForTest, type SpawnedDaemon } from "./daemon-tests-fixtures";

let workDir: string;
let daemon: SpawnedDaemon;

beforeEach(async () => {
  workDir = makeTmpDir("daemon-access");
  daemon = await spawnDaemonForTest({ stateFile: path.join(workDir, "design.json") });
});

afterEach(async () => {
  await daemon.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${daemon.port}`;

function boardDir(name: string): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir);
  return dir;
}

test("the state file carries a private per-daemon secret", () => {
  expect(daemon.token).toMatch(/^[0-9a-f]{64}$/);
  if (process.platform !== "win32") expect(fs.statSync(daemon.stateFile).mode & 0o077).toBe(0);
});

test("routes other than /health refuse requests without the daemon secret", async () => {
  const published = await publishBoard({ port: daemon.port, token: daemon.token, html: makeBoardHtml(boardDir("a")) });
  const other = makeBoardHtml(boardDir("b"));
  const attempts: Array<[string, string, unknown?]> = [
    ["GET", "/"],
    ["POST", "/api/boards", { html: other }],
    ["POST", "/shutdown"],
    ["GET", `/boards/${published.id}/`],
    ["GET", `/boards/${published.id}/api/progress`],
    ["POST", `/boards/${published.id}/api/feedback`, { regenerated: true }],
    ["POST", `/boards/${published.id}/api/reload`, { html: other }],
    ["GET", `/${"0".repeat(64)}/`],
  ];
  for (const [method, route, body] of attempts) {
    const res = await fetch(base() + route, {
      method,
      headers: { "Content-Type": "text/plain" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect({ route, status: res.status }).toEqual({ route, status: 401 });
  }
  expect(fs.existsSync(path.join(published.sourceDir, "feedback-pending.json"))).toBe(false);
  expect((await (await fetch(base() + "/health")).json()) as object).toMatchObject({ ok: true, boards: 1 });
});

test("a non-loopback Host is refused, /health included", async () => {
  for (const route of ["/health", `/${daemon.token}/`, `/${daemon.token}/api/boards`]) {
    const res = await fetch(base() + route, {
      method: route.endsWith("/api/boards") ? "POST" : "GET",
      headers: { Host: `board.example:${daemon.port}`, "Content-Type": "text/plain" },
      body: route.endsWith("/api/boards") ? JSON.stringify({ html: makeBoardHtml(boardDir("host")) }) : undefined,
    });
    expect({ route, status: res.status }).toEqual({ route, status: 403 });
  }
  const health = (await (await fetch(base() + "/health")).json()) as { boards: number };
  expect(health.boards).toBe(0);
});

test("a cross-origin Origin is refused even with the daemon secret", async () => {
  const published = await publishBoard({ port: daemon.port, token: daemon.token, html: makeBoardHtml(boardDir("origin")) });
  for (const origin of ["http://board.example", "null", `http://127.0.0.1:${daemon.port + 1}`]) {
    const res = await fetch(`${published.url}api/feedback`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: JSON.stringify({ regenerated: false }),
    });
    expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
  }
  expect(fs.existsSync(path.join(published.sourceDir, "feedback.json"))).toBe(false);
});

test("the published board URL carries the secret and its same-origin page requests work", async () => {
  const published = await publishBoard({ port: daemon.port, token: daemon.token, html: makeBoardHtml(boardDir("ok"), "<p>local board</p>") });
  expect(published.url).toBe(`${base()}/${daemon.token}/boards/${published.id}/`);
  expect(await (await fetch(published.url)).text()).toContain("local board");
  const submit = await fetch(`${published.url}api/feedback`, {
    method: "POST",
    headers: { Origin: base(), "Content-Type": "application/json" },
    body: JSON.stringify({ preferred: "A", regenerated: false }),
  });
  expect(submit.status).toBe(200);
  expect(JSON.parse(fs.readFileSync(path.join(published.sourceDir, "feedback.json"), "utf-8")).boardId).toBe(published.id);
  const index = await fetch(`${base()}/${daemon.token}/`, { headers: { Host: `localhost:${daemon.port}` } });
  expect(index.status).toBe(200);
  expect(await index.text()).toContain(`/${daemon.token}/boards/${published.id}/`);
});

test("a request without a Host header is refused, not answered with a server error", async () => {
  const { connect } = await import("net");
  const statusLine = await new Promise<string>((resolve, reject) => {
    const socket = connect(daemon.port, "127.0.0.1", () => socket.write(`GET /${daemon.token}/ HTTP/1.0\r\n\r\n`));
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
  expect(statusLine).toContain(" 403");
});

test("a board page requested with a stale secret shows the expired page without the current secret", async () => {
  const published = await publishBoard({ port: daemon.port, token: daemon.token, html: makeBoardHtml(boardDir("stale")) });
  const res = await fetch(`${base()}/${"0".repeat(64)}/boards/${published.id}/`);
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(body).toContain("Board expired");
  expect(body).not.toContain(daemon.token);
  const progress = await fetch(`${base()}/${"0".repeat(64)}/boards/${published.id}/api/progress`);
  expect(progress.status).toBe(401);
});
