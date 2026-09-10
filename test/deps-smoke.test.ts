/**
 * Dependency-override smoke tests (v1.78.0.0 dependency wave).
 *
 * The wave's `overrides` entries (package.json: ip-address 10.3.1,
 * sharp 0.35.0; lib/diagram-render: nanoid 5.x, lodash-es 4.18.x) defeat
 * nested exact pins, so a green unit suite alone does not prove the forced
 * versions actually work for their consumers. These smokes exercise the
 * overridden surfaces directly. SOCKS is covered by
 * browse/test/socks-bridge.test.ts; the diagram bundle by
 * test/diagram-render-drift.test.ts + the paid diagram E2E.
 */
import { describe, expect, test } from "bun:test";

describe("dependency-wave smoke", () => {
  test("sharp 0.35 override: import + metadata + resize round-trip", async () => {
    const sharp = (await import("sharp")).default;
    // 1x1 red PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(1);
    const out = await sharp(png).resize(4, 4).png().toBuffer();
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBe(4);
  });

  test("ip-address 10.3.1 override: both nested consumers resolve the fixed version", async () => {
    const lock = await Bun.file(`${import.meta.dir}/../bun.lock`).text();
    // No vulnerable ip-address node may survive anywhere in the tree
    // (socks pulled 10.2.0; express-rate-limit exact-pinned 10.1.0 — the
    // override must defeat both).
    expect(lock).not.toMatch(/ip-address@10\.(1|2)\./);
    expect(lock).toMatch(/ip-address@10\.3\./);
  });

  test("marked stays importable and parses (direct-dep bump)", async () => {
    const { marked } = await import("marked");
    const html = await marked.parse("**b**");
    expect(html).toContain("<strong>b</strong>");
  });
});
