import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import {
  detectAutopilot,
  decidePathManagedDriftRemove,
  decideSourceRemove,
  decideCodeSync,
  fetchSources,
  isInside,
  _resetCapabilityMemo,
} from "../lib/gbrain-guards";
import type { GbrainSourceRow } from "../lib/gbrain-sources";

const HOME = os.homedir();
const clonesPath = (name: string) => join(HOME, ".gbrain", "clones", name);

afterEach(() => _resetCapabilityMemo());

describe("fetchSources management registry", () => {
  test("uses the public sources_list operation with env routing and no Windows-unsafe JSON argv", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "gbrain-managed-list-"));
    const bin = join(tmp, "bin");
    const log = join(tmp, "args.log");
    fs.mkdirSync(bin);
    const payload = JSON.stringify({
      sources: [
        {
          id: "path-managed",
          local_path: "/tmp/repo",
          remote_url: null,
          page_count: 1,
        },
      ],
    });
    const shim = join(bin, "gbrain");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s|%s\\n' "$GBRAIN_SOURCE" "$*" > '${log}'\nprintf '%s' '${payload}'\n`,
    );
    fs.chmodSync(shim, 0o755);

    try {
      const rows = fetchSources({
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
      });
      expect(rows[0]?.remote_url).toBeNull();
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(
        "default|call sources_list",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── #1734 autopilot detection (E1: affirmative multi-signal) ────────────────
describe("detectAutopilot", () => {
  test("refuses on a present lock file (secondary signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain("lock:");
  });

  test("refuses on a live autopilot process (primary signal)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  test("proceeds when no signal fires (never blanket-refuses)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  // Stale-lock self-heal: a crashed daemon's lock (dead holder pid) must NOT
  // wedge syncs forever (observed: dead pid refused --full indefinitely).
  const DEAD_PID = 2999999; // above macOS pid_max; vanishingly unlikely elsewhere

  test("ignores a STALE lock whose holder pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}\n`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  test("treats a FRESH lock (live holder pid) as active", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, String(process.pid)); // the test runner itself is alive
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain(`pid ${process.pid}`);
  });

  test("parses a JSON lock body and ignores it when the pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, started_at: "x" }));
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
  });

  test("a stale lock does not mask a live autopilot process", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  test("a lock with no parseable pid stays conservative (active, no pid in signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "corrupted-no-pid-here");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true); // can't introspect → don't ignore the lock
    expect(r.signal).toContain("lock:");
    expect(r.signal).not.toContain("pid");
  });
});

// ── #1734 remove safety (E7: fail closed on user-managed without keep-storage) ─
describe("decideSourceRemove", () => {
  const rows = (extra: GbrainSourceRow[] = []): GbrainSourceRow[] => [
    { id: "default", local_path: null, remote_url: null },
    {
      id: "gbrain-managed",
      local_path: clonesPath("repo"),
      remote_url: "https://x/r.git",
    },
    {
      id: "user-managed",
      local_path: "/tmp/user-repo",
      remote_url: "https://x/r.git",
    },
    { id: "path-managed", local_path: "/tmp/path-repo", remote_url: null },
    ...extra,
  ];
  const fetchRows = (extra?: GbrainSourceRow[]) => () => rows(extra);

  test("absent active source → FAIL CLOSED because archived provenance is unknown", () => {
    const d = decideSourceRemove("nope", process.env, {
      keepStorage: false,
      fetchRows: fetchRows(),
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("archived provenance is unproven");
  });

  test("user-managed + no --keep-storage → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("user-managed");
  });

  test("user-managed + --keep-storage supported → allow with flag", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: true, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
    expect(d.extraArgs).toContain("--keep-storage");
  });

  test("gbrain-managed (inside clones) → allow even without keep-storage", () => {
    const d = decideSourceRemove("gbrain-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("path-managed without remote_url → allow (normal --path case)", () => {
    const d = decideSourceRemove("path-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("an empty but non-null remote_url remains URL-managed", () => {
    const d = decideSourceRemove("empty-remote", process.env, {
      keepStorage: false,
      fetchRows: fetchRows([
        {
          id: "empty-remote",
          local_path: "/tmp/user-repo",
          remote_url: "",
        },
      ]),
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("user-managed");
  });

  test("URL-managed rows with null or empty local_path fail closed", () => {
    for (const local_path of [null, ""] as const) {
      const d = decideSourceRemove("unlocatable", process.env, {
        keepStorage: false,
        fetchRows: fetchRows([
          {
            id: "unlocatable",
            local_path,
            remote_url: "https://x/r.git",
          },
        ]),
      });
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("not proven inside gbrain clones");
    }
  });

  test("sources unreadable → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, {
      keepStorage: false,
      fetchRows: () => { throw new Error("boom"); },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("fail closed");
  });
});

describe("decidePathManagedDriftRemove", () => {
  const expectedPath = String.raw`C:\repo`;

  test("allows only an unchanged path-managed source snapshot", () => {
    const decision = decidePathManagedDriftRemove(
      "source-id",
      expectedPath,
      process.env,
      {
        keepStorage: false,
        fetchRows: () => [
          { id: "source-id", local_path: expectedPath, remote_url: null },
        ],
      },
    );
    expect(decision).toEqual({
      allow: true,
      extraArgs: [],
      reason: "validated path-managed source",
    });
  });

  test("refuses when the registered row changes after validation", () => {
    const decision = decidePathManagedDriftRemove(
      "source-id",
      expectedPath,
      process.env,
      {
        keepStorage: false,
        fetchRows: () => [
          {
            id: "source-id",
            local_path: String.raw`C:\replacement`,
            remote_url: null,
          },
        ],
      },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("changed after validation");
  });

  test("refuses URL-managed sources without resolving their untrusted path", () => {
    const unsafe = String.raw`\\attacker.invalid\share`;
    const decision = decidePathManagedDriftRemove(
      "source-id",
      unsafe,
      process.env,
      {
        keepStorage: true,
        fetchRows: () => [
          {
            id: "source-id",
            local_path: unsafe,
            remote_url: "https://example.invalid/repo.git",
          },
        ],
      },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("URL-managed");
  });
});

// ── #1734 reclone guard (E-level: require --allow-reclone for URL-managed) ───
describe("decideCodeSync", () => {
  const rows: GbrainSourceRow[] = [
    { id: "url-managed", local_path: "/tmp/u", remote_url: "https://x/r.git" },
    { id: "plain", local_path: "/tmp/p", remote_url: null },
  ];
  const fetch = () => rows;

  test("URL-managed + no --allow-reclone → refuse", () => {
    const d = decideCodeSync("url-managed", process.env, false, fetch);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("auto-reclone");
  });

  test("URL-managed + --allow-reclone → allow", () => {
    const d = decideCodeSync("url-managed", process.env, true, fetch);
    expect(d.allow).toBe(true);
    expect(d.mayReclone).toBe(true);
  });

  test("no remote_url → allow", () => {
    const d = decideCodeSync("plain", process.env, false, fetch);
    expect(d.allow).toBe(true);
    expect(d.mayReclone).toBe(false);
    expect(d.registeredPath).toBe("/tmp/p");
  });

  test("missing source row → FAIL CLOSED", () => {
    const d = decideCodeSync("missing", process.env, false, fetch);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("absent or has no readable local_path");
  });

  test("sources unreadable → FAIL CLOSED (reclone applicability is unprovable)", () => {
    const d = decideCodeSync("url-managed", process.env, false, () => {
      throw new Error("boom");
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("applicability is unprovable");
  });

  test("ordinary list shape without top-level remote_url cannot authorize sync", () => {
    const d = decideCodeSync("legacy-looking", process.env, false, () => [
      {
        id: "legacy-looking",
        local_path: "/tmp/p",
        config: { remote_url: null },
      },
    ]);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("applicability is unprovable");
  });
});

// ── path containment uses realpath (symlink can't smuggle a delete out) ──────
describe("isInside", () => {
  test("plain path inside dir", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/x", "/a/b")).toBe(false);
  });

  test("sibling-prefix is not 'inside' (clonesX vs clones)", () => {
    expect(isInside("/a/clones-evil/x", "/a/clones")).toBe(false);
  });

  test("symlink pointing outside resolves outside", () => {
    const base = fs.mkdtempSync(join(os.tmpdir(), "clones-"));
    const outside = fs.mkdtempSync(join(os.tmpdir(), "outside-"));
    const link = join(base, "sneaky");
    fs.symlinkSync(outside, link);
    // link lives under base, but realpath resolves to `outside` → not inside base.
    expect(isInside(link, base)).toBe(false);
  });

  test("direct UNC/device-like paths fail closed before containment resolution", () => {
    expect(
      isInside(String.raw`\\attacker.invalid\share`, clonesPath("repo")),
    ).toBe(false);
    expect(isInside("//attacker.invalid/share", clonesPath("repo"))).toBe(
      false,
    );
  });
});
