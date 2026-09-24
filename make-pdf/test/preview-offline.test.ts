import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { preview } from "../src/orchestrator";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const dataImage = `data:image/png;base64,${pixel.toString("base64")}`;
let browser: Browser;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let html = "";
let requests: string[] = [];
const artifacts: string[] = [];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-offline-"));
  browser = await chromium.launch();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/preview.html") return new Response(html, { headers: { "Content-Type": "text/html" } });
      requests.push(url.pathname);
      return new Response(pixel, { headers: { "Content-Type": "image/png" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function artifact(markdown: string, allowNetwork?: boolean): Promise<string> {
  const input = path.join(root, `preview-${path.basename(root)}-${artifacts.length}.md`);
  fs.writeFileSync(input, markdown);
  const open = spyOn(childProcess, "spawn").mockReturnValue({ unref() {} } as childProcess.ChildProcess);
  try {
    const output = await preview({ input, allowNetwork, quiet: true, toc: true, date: "September 24, 2026" });
    artifacts.push(output);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1]).toContain(output);
    return output;
  } finally {
    open.mockRestore();
  }
}

const resources: [string, (url: string) => string][] = [
  ["Markdown image", url => `![Remote illustration](${url})`],
  ["double-quoted image", url => `<img src="${url}" alt="Remote illustration">`],
  ["single-quoted image", url => `<img src='${url}' alt='Remote illustration'>`],
  ["unquoted image", url => `<img src=${url} alt=Remote>`],
  ["entity-encoded image", url => `<img src="${url.replace("http:", "&#104;ttp&colon;")}">`],
  ["unquoted entity image", url => `<img src=${url.replace("http", "&#x68;ttp")}>`],
  ["protocol-relative image", url => `<img src="${url.replace("http:", "")}">`],
  ["entity srcset", url => `<img src="${dataImage}" srcset="${url.replace("http", "&#104;ttp")} 1x">`],
  ["relative srcset", () => `<img src="${dataImage}" srcset="/srcset.png 1x">`],
  ["relative image", () => `<img src="/relative.png">`],
  ["CSS style block", url => `<style>p { background: url(${url}); }</style>`],
  ["CSS relative url", () => `<style>p { background: url(/background.png); }</style>`],
  ["CSS relative image-set", () => `<style>p { background-image: image-set("/image-set.png" 1x); }</style>`],
  ["CSS unquoted entity attribute", url => `<p style=background:url(${url.replace("http", "&#104;ttp")})>Styled prose</p>`],
  ["CSS import", url => `<style>@import "${url}";</style>`],
  ["CSS relative font", () => `<style>@font-face { font-family: probe; src: url(/font.woff2); } p { font-family: probe; }</style>`],
  ["SVG image", url => `<svg width="20" height="20"><image href="${url}" width="20" height="20"/></svg>`],
  ["SVG relative image", () => `<svg width="20" height="20"><image href="/svg.png" width="20" height="20"/></svg>`],
  ["SVG relative use", () => `<svg><use href="/sprite.svg#icon"/></svg>`],
  ["SVG filter image", () => `<svg><filter id="f"><feImage href="/filter.png"/></filter><rect width="20" height="20" filter="url(#f)"/></svg>`],
  ["entity video poster", url => `<video poster="${url.replace("http", "&#104;ttp")}"></video>`],
  ["entity media source", url => `<audio preload="auto"><source src="${url.replace("http", "&#104;ttp")}"></audio>`],
  ["sanitized active elements", url => `<script src="${url}"></script><iframe src="${url}"></iframe><link rel="stylesheet" href="${url}"><meta http-equiv="refresh" content="0;url=${url}"><base href="${url}"><form action="${url}"></form>`],
  ["ordinary meta refresh", url => `<div>\n<meta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["NUL-reconstructed meta refresh", url => `<div>\n<me\u0000ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["space-separated meta refresh control", url => `<div>\n<me ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["reconstructed meta refresh", url => `<div>\n<me<form></form>ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["attribute-reconstructed meta refresh", url => `<div>\n<me onload=""ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["srcdoc-reconstructed meta refresh", url => `<div>\n<me srcdoc=""ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["srcset-reconstructed meta refresh", url => `<div>\n<me srcset="${url} 1x"ta http-equiv="refresh" content="0;url=${url}">\n</div>`],
  ["all removed-tag token boundaries", url => `<div>\n${["script", "iframe", "object", "embed", "link", "meta", "base", "form", "applet", "frame", "frameset"].map(tag => `<me<${tag}></${tag}>ta http-equiv="refresh" content="0;url=${url}">`).join("\n")}\n</div>`],
];

for (const [name, markup] of resources) {
  test(`offline saved preview blocks ${name} from file and HTTP`, async () => {
    const output = await artifact(`# Offline reading\n\nReadable prose.\n\n${markup(`${origin}/pixel.png`)}\n`);
    html = fs.readFileSync(output, "utf8");
    const page = await browser.newPage();
    try {
      for (const location of [pathToFileURL(output).href, `${origin}/preview.html`]) {
        requests = [];
        await page.goto(location, { waitUntil: "networkidle" });
        expect(requests).toEqual([]);
        expect(page.url()).toBe(location);
        expect(await page.locator("h1").innerText()).toBe("Offline reading");
        expect(await page.locator("body").innerText()).toContain("network resources are blocked");
      }
      const head = await page.locator("head").innerHTML();
      expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<style>"));
      expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toContain("default-src 'none'");
    } finally {
      await page.close();
    }
  });
}

test("offline saved preview keeps decoded heading text inside its stylesheet", async () => {
  const output = await artifact(`# Heading &lt;/style&gt;&lt;meta http-equiv=refresh content=0;url=${origin}/heading&gt;\n\nReadable body.\n`, false);
  html = fs.readFileSync(output, "utf8");
  const page = await browser.newPage();
  try {
    for (const location of [pathToFileURL(output).href, `${origin}/preview.html`]) {
      requests = [];
      await page.goto(location, { waitUntil: "networkidle" });
      expect(requests).toEqual([]);
      expect(page.url()).toBe(location);
      expect(await page.locator('meta[http-equiv="refresh"]').count()).toBe(0);
      expect(await page.locator("h1").innerText()).toContain("Heading </style><meta");
    }
  } finally {
    await page.close();
  }
});

test("explicit online preview still fetches supported remote image spellings", async () => {
  const onlineImages = resources.slice(0, 6).map(([_, markup], i) => markup(`${origin}/online-${i}.png`));
  const output = await artifact(`# Online control\n\n${onlineImages.join("\n\n")}`, true);
  const page = await browser.newPage();
  try {
    requests = [];
    await page.goto(pathToFileURL(output).href, { waitUntil: "networkidle" });
    expect(requests.sort()).toEqual(Array.from({ length: 6 }, (_, i) => `/online-${i}.png`));
    expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(0);
    expect(await page.locator("img").evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  } finally {
    await page.close();
  }
});

test("explicit offline preview preserves data/local assets, inline SVG, TOC and diagram-as-code", async () => {
  const image = path.join(root, "local.png");
  fs.writeFileSync(image, pixel);
  const cssImage = path.join(root, "local-css.png");
  const svgImage = path.join(root, "local-svg.png");
  fs.writeFileSync(cssImage, pixel);
  fs.writeFileSync(svgImage, pixel);
  const output = await artifact([
    '# Readable document',
    'Local and embedded illustrations.',
    `![Local](${pathToFileURL(image).href})`,
    `<img src="${dataImage}" alt="Embedded">`,
    `<img srcset="${pathToFileURL(image).href} 1x" alt="Local srcset">`,
    `<img srcset="${dataImage} 1x" alt="Data srcset">`,
    `<div style="width:20px;height:20px;background-image:url(${pathToFileURL(cssImage).href})">CSS image</div>`,
    `<svg width="24" height="24"><defs><circle id="dot" cx="12" cy="12" r="10"/></defs><use href="#dot" fill="green"/><image href="${pathToFileURL(svgImage).href}" width="10" height="10"/></svg>`,
    '```mermaid\ngraph LR\n  A --> B\n```',
    '![Unresolved local](missing-relative.png)',
    `<img src="${origin}/explicit-offline.png" alt="Blocked network">`,
  ].join('\n\n'), false);
  const page = await browser.newPage();
  const loaded: string[] = [];
  page.on("requestfinished", request => loaded.push(request.url()));
  try {
    requests = [];
    await page.goto(pathToFileURL(output).href, { waitUntil: "networkidle" });
    expect(requests).toEqual([]);
    expect(await page.locator('img:not([alt="Unresolved local"]):not([alt="Blocked network"])').evaluateAll(images => images.length === 4 && images.every(img => (img as HTMLImageElement).naturalWidth === 1))).toBe(true);
    expect(await page.locator('img[alt="Blocked network"]').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(0);
    expect(loaded).toContain(pathToFileURL(cssImage).href);
    expect(loaded).toContain(pathToFileURL(svgImage).href);
    expect(await page.locator("svg use").getAttribute("href")).toBe("#dot");
    expect(await page.locator("code.language-mermaid").innerText()).toContain("graph LR");
    expect(await page.locator('img[alt="Unresolved local"]').getAttribute("src")).toBe("missing-relative.png");
    expect(await page.locator("h1").evaluate(el => getComputedStyle(el).fontFamily)).toContain("Helvetica");
    await page.locator('.toc a').click();
    expect(new URL(page.url()).hash).toBe('#toc-0');
  } finally {
    await page.close();
  }
});

test("offline saved preview preserves intentional hyperlink navigation", async () => {
  const output = await artifact(`# Intentional links\n\n[Open local destination](${origin}/intentional)`, false);
  const page = await browser.newPage();
  try {
    requests = [];
    await page.goto(pathToFileURL(output).href, { waitUntil: "networkidle" });
    expect(requests).toEqual([]);
    await page.getByRole("link", { name: "Open local destination" }).click();
    await page.waitForURL(`${origin}/intentional`);
    expect(requests).toContain("/intentional");
  } finally {
    await page.close();
  }
});
