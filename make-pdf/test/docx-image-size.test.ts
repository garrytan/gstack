/**
 * DOCX image sizing (#2753). package.json overrides image-size to 2.x, which
 * fixes GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr in the lockfile, but
 * html-to-docx 1.8.0 never loads it: it runs its own bundled image-size 1.x.
 * The golden document.xml pins the Word output the change must not move. The
 * guard tests prove ICNS bytes, which hang that bundled copy, never reach it,
 * however the <img> tag is spelled.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { guardDocxImages } from "../src/docx-images";
import { generate } from "../src/orchestrator";

const FIXTURES = path.join(import.meta.dir, "fixtures", "docx-images");
const EMU_PER_PX = 9525;
const IMAGES = [
  { file: "wide.png", ext: "png", width: 120, height: 48 },
  { file: "tall.jpg", ext: "jpeg", width: 30, height: 90 },
  { file: "square.gif", ext: "gif", width: 64, height: 64 },
];

/** GHSA-w3rx-r6r6-pgpr: valid ICNS magic and a zero-length entry. */
function icnsLoop(): Buffer {
  const buf = Buffer.alloc(24);
  buf.write("icns", 0);
  buf.writeUInt32BE(24, 4);
  buf.write("ic08", 8);
  return buf;
}

function unzip(args: string[]): Buffer {
  return execFileSync("unzip", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

describe("make-pdf --to docx image sizing", () => {
  test("embeds every image at its pixel size, matching the image-size 1.x output", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-docx-images-"));
    try {
      const out = path.join(workDir, "out.docx");
      await generate({ input: path.join(FIXTURES, "doc.md"), output: out, to: "docx", quiet: true });

      const xml = unzip(["-p", out, "word/document.xml"]).toString("utf8");
      const extents = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(m => [Number(m[1]), Number(m[2])]);
      expect(extents).toEqual(IMAGES.map(img => [img.width * EMU_PER_PX, img.height * EMU_PER_PX]));

      const media = unzip(["-Z1", out]).toString("utf8").split("\n").filter(name => /^word\/media\/.+/.test(name));
      expect(media).toHaveLength(IMAGES.length);
      for (const [i, img] of IMAGES.entries()) {
        expect(media[i].endsWith(`.${img.ext}`)).toBe(true);
        expect(unzip(["-p", out, media[i]]).equals(fs.readFileSync(path.join(FIXTURES, img.file)))).toBe(true);
      }

      const normalized = xml.replace(/image-[A-Za-z0-9_-]{21}\.(png|jpeg|gif)/g, "image-ID.$1");
      const golden = fs.readFileSync(path.join(FIXTURES, "document.golden.xml"), "utf8").replace(/\r\n/g, "\n");
      expect(normalized.trimEnd()).toBe(golden.trimEnd());
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("the guard drops ICNS images however the tag is spelled and keeps every other format", () => {
    const icns = "data:image/png;base64," + icnsLoop().toString("base64");
    const png = "data:image/png;base64," + fs.readFileSync(path.join(FIXTURES, "wide.png")).toString("base64");
    const bmp = "data:image/bmp;base64," + Buffer.from("BM" + "\0".repeat(52)).toString("base64");
    const warnings: string[] = [];
    const guard = (html: string) => guardDocxImages(html, msg => warnings.push(msg));
    expect(guard(`<p><img src="${png}"><img src="${bmp}"></p>`)).toBe(`<p><img src="${png}"><img src="${bmp}"></p>`);
    expect(warnings).toEqual([]);
    for (const tag of [
      `<img src="${icns}">`,
      `<img src='${icns}' alt="x">`,
      `<img src=${icns}>`,
      `<IMG SRC="${icns}">`,
      `<img data-src="${png}" src="${icns}">`,
      `<img src="${icns.replace("base64,a", "base64,%61")}">`,
      `<img src="${icns.replace(";", "%3B")}">`,
      `<img src=${icns.replace(":", "%3A")}>`,
    ]) expect(guard(`<p>${tag}</p>`)).toBe("<p></p>");
    expect(warnings).toHaveLength(8);
  });

  test("a tag the regex misreads fails closed through html-to-docx's own parser", () => {
    const icns = "data:image/png;base64," + icnsLoop().toString("base64");
    expect(() => guardDocxImages(`<p><img alt=">" src="${icns}"></p>`, () => {})).toThrow("hides an ICNS image");
  });

  test("the re-parse uses the html-to-vdom copy html-to-docx loads", () => {
    const fromDocx = require.resolve("html-to-vdom/package.json", { paths: [path.dirname(require.resolve("html-to-docx/package.json"))] });
    expect(fromDocx).toBe(require.resolve("html-to-vdom/package.json"));
  });

  test("an ICNS file named .png is dropped with a warning instead of hanging the conversion", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-docx-icns-"));
    try {
      fs.writeFileSync(path.join(workDir, "evil.png"), icnsLoop());
      fs.writeFileSync(path.join(workDir, "doc.md"), "# ICNS\n\n![evil](evil.png)\n\n![inline](data:image/png;base64," + icnsLoop().toString("base64") + ")\n");
      const out = path.join(workDir, "out.docx");
      const script = `import { generate } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "orchestrator.ts"))};
await generate({ input: ${JSON.stringify(path.join(workDir, "doc.md"))}, output: ${JSON.stringify(out)}, to: "docx" });`;
      const run = Bun.spawnSync([process.execPath, "-e", script], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
      const stderr = run.stderr.toString();
      expect(run.exitCode).toBe(0);
      expect(stderr).toContain("not a recognized image (png, jpeg, gif, webp, svg): evil.png");
      expect(stderr.match(/docx: dropped an ICNS image/g)).toHaveLength(1);
      expect(unzip(["-p", out, "word/document.xml"]).toString("utf8")).not.toContain("<w:drawing>");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
