/**
 * #4209: env.kv flagged the Django test-client idiom `session = self.client.session`
 * in a Python test file, and the pregate secrets stage (never downgradable)
 * stopped /ship on it. An unquoted dotted attribute chain that is the whole
 * right-hand side of an `=` assignment in Python or Dart source reads a
 * name; it holds no credential. The hold cases below are the same shapes
 * carrying a real value, or the same line where it is text, and must still fire.
 */
// Value: protects=env.kv stays fail-closed on literals, tokens, env files and strings while a source attribute read passes; fails_when=the attribute-reference exemption reaches a quoted, token-shaped, string or config value; why_new=#4209 had no test of an = assignment reading an attribute; seam=none; no_claim=scanner-level only; the pregate end-to-end case lives in pregate-secrets-source-context.test.ts
import { describe, expect, test } from "bun:test";
import { scan } from "../lib/redact-engine";

const kv = (text: string, sourcePath?: string) =>
  scan(text, { repoVisibility: "private", processEnv: {}, ...(sourcePath ? { sourcePath } : {}) }).findings.some((f) => f.id === "env.kv");
const v = "8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ";
const tokenShaped = ["NzE4MjkzNjQ1MDcyODM5Mjk0", "Gx7QpL", "Kq9wErTy5UiOp3AsDf7GhJkL2Zx"].join(".");
const django = "        session = self.client.session";

describe("env.kv: an attribute reference assigned in source is a name (#4209)", () => {
  test("hold: quoted literal values still fire", () => {
    for (const [literal, file] of [
      [`        session = "${v}"`, "tests/test_views.py"],
      [`        session = '${v}'`, "tests/test_views.py"],
      ['        session = "self.client.session"', "tests/test_views.py"],
      ["        session = 'self.client.session'", "tests/test_views.py"],
      ['    session = "widget.session.value";', "lib/a.dart"],
    ] as const) expect({ literal, file, kv: kv(literal, file) }).toEqual({ literal, file, kv: true });
  });

  test("hold: high-entropy tokens still fire, unquoted ones included", () => {
    for (const [literal, file] of [
      [`    token = ${v}`, "app/views.py"],
      [`    token = ${tokenShaped}`, "app/views.py"],
      [`    session = ${tokenShaped};`, "lib/a.dart"],
      ["    token = 8Fk2pQ9v.Xz4wL7mN3rT6", "app/views.py"],
      ["    token = Fk2p-Q9vX.z4wL7mN3rT6", "app/views.py"],
      ["    token = abc.def/ghi+jkl==", "app/views.py"],
    ] as const) expect({ literal, file, kv: kv(literal, file) }).toEqual({ literal, file, kv: true });
  });

  test("hold: env-style assignments and config files still fire, a dotted value included", () => {
    for (const [literal, file] of [
      [`SESSION_TOKEN=${v}`, ".env"],
      ["SESSION=self.client.session", ".env"],
      ["export SESSION=self.client.session", "deploy/env.sh"],
      ["API_KEY=app.settings.api_key", ".env.production"],
      ["session = self.client.session", "config/app.ini"],
      ["session = self.client.session", "pyproject.toml"],
      ["session: self.client.session", "deploy/values.yaml"],
      ["  session = this.client.session;", "src/a.ts"],
      [django, undefined],
      [django, "added.txt"],
    ] as const) expect({ literal, file, kv: kv(literal, file) }).toEqual({ literal, file, kv: true });
  });

  test("hold: the same line inside a string or followed by more value still fires", () => {
    for (const [literal, file] of [
      [`CONFIG = """\n${django}\n"""`, "tests/conftest.py"],
      [`CONFIG = f'''\n${django}\n'''`, "tests/conftest.py"],
      [`CFG = "db \\\n${django} \\\n"`, "app.py"],
      [`const fixture = '''\n  session = widget.client.session;\n''';`, "test/fixtures.dart"],
      [`${django} or "${v}"`, "tests/test_views.py"],
      [`${django}, "${v}"`, "tests/test_views.py"],
      [`${django} + "${v}"`, "tests/test_views.py"],
      [`${django} \\\n    + "${v}"`, "tests/test_views.py"],
      ["      password=request.password,", "app/api/handlers.py"],
    ] as const) expect({ literal, file, kv: kv(literal, file) }).toEqual({ literal, file, kv: true });
  });

  test("the Django test-client line and other attribute reads in Python and Dart source pass", () => {
    for (const [code, file] of [
      [django, "tests/test_views.py"],
      [django, "app/tests/test_views.py"],
      [`class T(TestCase):\n    def test_x(self):\n${django}\n        session["k"] = 1\n`, "tests/test_views.py"],
      [`${django}  # Django test client`, "tests/test_views.py"],
      [`${django}\r`, "tests/test_views.py"],
      ["    token = request.auth", "app/views.py"],
      ["    self.session = self.client.session", "tests/test_views.py"],
      ["      password = request.password", "app/api/handlers.py"],
      ["    session = widget.session;", "lib/a.dart"],
      ["    session = widget.client.session; // from the parent", "lib/a.dart"],
    ] as const) expect({ code, file, kv: kv(code, file) }).toEqual({ code, file, kv: false });
  });
});
