import { join, normalize } from "node:path";

const root = import.meta.dir;
const port = Number(process.env.PORT || 4173);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(root, pathname));

    if (!filePath.startsWith(root)) {
      return new Response("Not found", { status: 404 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: {
        "content-type": mimeTypes[filePath.match(/\.[^.]+$/)?.[0] || ""] || "application/octet-stream",
      },
    });
  },
});

console.log(`Tradeoff Search running at http://127.0.0.1:${port}`);

process.on("SIGTERM", () => server.stop());
process.on("SIGINT", () => server.stop());
await new Promise(() => {});
