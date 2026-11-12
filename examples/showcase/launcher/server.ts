/** A local, static launcher. It never starts the runtime on this machine. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SHOWCASE_LAUNCHER_PORT ?? 4179);
const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"],
  "/launcher.js": ["launcher.js", "text/javascript"],
  "/readiness.js": ["readiness.js", "text/javascript"],
  "/launcher.css": ["launcher.css", "text/css"],
};
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET") return void response.writeHead(405).end();
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (pathname === "/config.json") {
    response.writeHead(200, { "content-type": "application/json" });
    return void response.end(
      JSON.stringify({ endpoint: process.env.SHOWCASE_URL ?? "" }),
    );
  }
  const entry = files[pathname];
  if (!entry) return void response.writeHead(404).end();
  readFile(path.join(directory, entry[0]))
    .then((content) => {
      response
        .writeHead(200, { "content-type": `${entry[1]}; charset=utf-8` })
        .end(content);
    })
    .catch(() => response.writeHead(500).end());
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Showcase launcher: http://127.0.0.1:${port}`);
  console.log(
    "Only this launcher runs locally; the showcase runs at SHOWCASE_URL.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close(() => process.exit()));
