/**
 * GST-4104: four edge cases left open on #4869's secrets-scan redesign.
 *
 *   - An `AIza…` key holding `_` or `-` cannot be part of a standard
 *     base64 run, so it is never dismissed as a chance match inside one.
 *   - env.kv.js reads the declarator its `=` belongs to: a typed earlier
 *     declarator no longer lends its name to a later one, and a secret-named
 *     later declarator now reports.
 *   - A provider key bound by a JS/TS or Go declaration reports as its
 *     provider rule alone, so allowlisting that rule clears it.
 *   - A known secret's base64 form is matched with its boundary characters'
 *     bits, so a value that differs only in those bits is not reported.
 */
// Value: protects=AIza keys with url-safe characters in base64 runs, later declarators, provider-rule allowlists and exact base64 matching of env values; fails_when=an AIza key with _ or - is dismissed as chance, a typed earlier declarator's name flags a later value, a provider key also reports env.kv.js or env.kv.go, or a value one bit away matches a secret's base64 form; why_new=GST-4104 had no cases; seam=none; no_claim=scanner-level only
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const ids = (text: string, sourcePath?: string, processEnv: Record<string, string> = {}) =>
  scan(text, { repoVisibility: "private", processEnv, ...(sourcePath ? { sourcePath } : {}) }).findings.map((f) => f.id);
const j = (...parts: string[]) => parts.join("");
const S = j("Qx9vL2mZ", "p8Rt4Kw7", "Yn3Bh2Jd");
const HEX = j("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0");
const GHP = j("ghp_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8");
const AIZA = j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q");
const filler = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + seed * 11 + 5) % 256));

describe("google.api_key: a key with url-safe characters is never chance inside standard base64", () => {
  const BLOB = filler(240, 3).toString("base64");
  const inside = (key: string, at: number) => "data:image/png;base64," + BLOB.slice(0, at) + "/" + key + "/" + BLOB.slice(at);

  test("an AIza key holding _ or - after 64+ mixed-case standard base64 characters reports", () => {
    for (const key of [j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5_6Q"), j("AIza", "SyA1b2C3d4-5f6G7h8I9j0K1l2M3n4O5p6Q"), j("AIza", "Sy_1b2C3d4E5f6G7h8I9j0K1l2M3n4O-p6Q")])
      for (const at of [64, 100, 160]) expect({ key, at, hit: ids(inside(key, at)).includes("google.api_key") }).toEqual({ key, at, hit: true });
  });

  test("an AIza match made only of standard base64 characters deep in the run stays chance", () => {
    for (const at of [64, 100, 160]) expect({ at, hit: ids(inside(AIZA, at)).includes("google.api_key") }).toEqual({ at, hit: false });
  });
});

describe("env.kv.js: the name is the declarator the = belongs to", () => {
  test("a typed earlier declarator does not name a later value", () => {
    for (const code of ['let token: string, buildHash = "' + HEX + '";', 'let apiKey: string | undefined, cacheId = "' + S + '";', 'var secret: Map<string, number>, build = "' + HEX + '";'])
      expect({ code, hit: ids(code, "src/build.ts").includes("env.kv.js") }).toEqual({ code, hit: false });
  });

  test("a secret-named later declarator reports, and a type with a comma inside brackets still reports", () => {
    for (const code of ['let a: string, token = "' + S + '";', 'let a, b: number, apiKey = "' + HEX + '";', 'const apiToken: Brand<string, "token"> = "' + S + '";', 'let token: string = "' + S + '", other = 1;'])
      expect({ code, hit: ids(code, "src/client.ts").includes("env.kv.js") }).toEqual({ code, hit: true });
  });
});

describe("declaration rules leave a provider key to its provider rule", () => {
  test("a provider key in a JS/TS or Go declaration reports only the provider rule, so allowlisting it clears the line", () => {
    for (const [code, file, id] of [
      ['const apiKey = "' + AIZA + '";', "src/firebase.ts", "google.api_key"],
      ["export const firebaseApiKey: string = '" + AIZA + "';", "src/firebase.mts", "google.api_key"],
      ['const token = "' + GHP + '";', "src/client.js", "github.pat"],
      ['apiKey := "' + AIZA + '"', "cmd/firebase.go", "google.api_key"],
    ] as const) {
      const found = ids(code, file);
      expect({ code, found }).toEqual({ code, found: [id] });
      expect({ code, left: found.filter((f) => f !== id) }).toEqual({ code, left: [] });
    }
  });

  test("a secret-shaped value with no provider rule, or more than the provider key, still reports the declaration rule", () => {
    expect(ids('const token = "' + S + '";', "src/client.ts")).toEqual(["env.kv.js"]);
    expect(ids('token := "' + HEX + '"', "cmd/client.go")).toEqual(["env.kv.go"]);
    expect(ids('const token = "' + AIZA + ":" + S + '";', "src/client.ts").sort()).toEqual(["env.kv.js", "google.api_key"]);
  });
});

describe("env.value: a base64 form matches only the secret's exact bits", () => {
  const env = { BUILD_TOKEN: "build123" };
  const stream = (value: string, shift: number, tail: number) => Buffer.concat([filler(30 + shift, shift), Buffer.from(value), filler(tail, 7)]).toString("base64");
  const url = (text: string) => text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const envHits = (text: string) => scan("blob: " + text + "\n", { processEnv: env }).findings.filter((f) => f.id === "env.value").map((f) => f.severity);

  test("a value that differs only in a boundary character's bits does not report at any alignment", () => {
    for (const other of ["build124", "ruild123", j('"', "uild123"), "build12;"]) for (const shift of [0, 1, 2]) for (const tail of [0, 31]) for (const u of [false, true]) {
      const text = u ? url(stream(other, shift, tail)) : stream(other, shift, tail);
      expect({ other, shift, tail, u, hits: envHits(text) }).toEqual({ other, shift, tail, u, hits: [] });
    }
  });

  test("a base64 or base64url symbol beside a form is read for its bits in either alphabet", () => {
    const value = "build123secretvalue";
    const near = { MY_API_TOKEN: value };
    const forms = (shift: number) => Buffer.concat([Buffer.alloc(shift), Buffer.from(value)]).toString("base64").replace(/=+$/, "");
    const core = forms(1).slice(2, -1);
    expect(forms(1)[1]).toBe("G");
    for (const lead of ["+", "/", "-", "_", "Q"]) {
      const hits = scan("xx " + lead + core + " yy", { processEnv: near }).findings.filter((f) => f.id === "env.value");
      expect({ lead, hits: hits.length }).toEqual({ lead, hits: 0 });
    }
    expect(scan("xx G" + core + " yy", { processEnv: near }).findings.filter((f) => f.id === "env.value").length).toBe(1);
  });

  test("the exact secret's base64 and base64url forms still report HIGH at every alignment, mid-stream and at its end", () => {
    for (const shift of [0, 1, 2]) for (const tail of [0, 31]) for (const u of [false, true]) {
      const text = u ? url(stream("build123", shift, tail)) : stream("build123", shift, tail);
      expect({ shift, tail, u, hits: envHits(text) }).toEqual({ shift, tail, u, hits: ["HIGH"] });
    }
  });
});
