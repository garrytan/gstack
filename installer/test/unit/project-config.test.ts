import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, rmTmpDir, readJson, write } from "../helpers.js";
import {
  enableSkill,
  disableSkill,
  listDisabledSkills,
  readSettings,
  writeSettings,
} from "../../src/lib/project-config.js";

describe("disableSkill", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("creates settings file with disabled skill", () => {
    expect(disableSkill(tmp, "qa")).toBe(true);
    const s = readJson<{ disabledSkills: string[] }>(
      path.join(tmp, ".claude", "settings.local.json"),
    );
    expect(s.disabledSkills).toEqual(["qa"]);
  });

  test("returns false when already disabled", () => {
    disableSkill(tmp, "qa");
    expect(disableSkill(tmp, "qa")).toBe(false);
  });

  test("keeps list sorted", () => {
    disableSkill(tmp, "zulu");
    disableSkill(tmp, "alpha");
    disableSkill(tmp, "mike");
    expect(listDisabledSkills(tmp)).toEqual(["alpha", "mike", "zulu"]);
  });

  test("preserves other keys in settings file", () => {
    write(
      tmp,
      ".claude/settings.local.json",
      JSON.stringify({ customKey: "customValue", disabledSkills: ["existing"] }),
    );
    disableSkill(tmp, "new");
    const s = readJson<{ customKey: string; disabledSkills: string[] }>(
      path.join(tmp, ".claude", "settings.local.json"),
    );
    expect(s.customKey).toBe("customValue");
    expect(s.disabledSkills).toEqual(["existing", "new"]);
  });
});

describe("enableSkill", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns false when skill is not disabled", () => {
    expect(enableSkill(tmp, "qa")).toBe(false);
  });

  test("removes disabled skill", () => {
    disableSkill(tmp, "qa");
    disableSkill(tmp, "ship");
    expect(enableSkill(tmp, "qa")).toBe(true);
    expect(listDisabledSkills(tmp)).toEqual(["ship"]);
  });

  test("deletes disabledSkills key when list becomes empty", () => {
    disableSkill(tmp, "qa");
    enableSkill(tmp, "qa");
    const s = readSettings(tmp);
    expect(s.disabledSkills).toBeUndefined();
  });

  test("preserves other keys when clearing disabledSkills", () => {
    writeSettings(tmp, { otherKey: "keep", disabledSkills: ["only"] });
    enableSkill(tmp, "only");
    const raw = fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf-8");
    expect(raw).toContain("otherKey");
    expect(raw).not.toContain("disabledSkills");
  });
});

describe("readSettings", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns empty object when file missing", () => {
    expect(readSettings(tmp)).toEqual({});
  });

  test("returns empty object when file is invalid JSON", () => {
    write(tmp, ".claude/settings.local.json", "{ not json }");
    expect(readSettings(tmp)).toEqual({});
  });
});
