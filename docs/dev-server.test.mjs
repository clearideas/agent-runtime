import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Resolve through VitePress so the regression covers the documentation server,
// even when Vitest installs a different Vite version elsewhere in the workspace.
const require = createRequire(import.meta.url);
const vitepressRequire = createRequire(
  require.resolve("vitepress/package.json"),
);
const viteEntry = vitepressRequire.resolve("vite");
const vite = await import(pathToFileURL(viteEntry).href);
const { createServer } = vite.createServer ? vite : vite.default;

const request = (port, requestPath, headers = {}) =>
  new Promise((resolve, reject) => {
    // Preserve dot segments and encoded separators, unlike URL normalization.
    get({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
        }),
      );
      response.on("error", reject);
    }).on("error", reject);
  });

test("documentation Vite refuses optimized-map traversal and serves valid maps", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "docs-vite-security-"));
  const root = path.join(fixture, "site");
  const cacheDir = path.join(root, "node_modules", ".vite");
  let server;
  try {
    await mkdir(path.join(cacheDir, "deps"), { recursive: true });
    const map = { version: 3, sources: [], names: [], mappings: "" };
    await writeFile(
      path.join(fixture, "outside.map"),
      JSON.stringify({ ...map, file: "OUTSIDE_ALLOWED_ROOT" }),
    );
    await writeFile(
      path.join(root, "control.js.map"),
      JSON.stringify({ ...map, file: "control.js" }),
    );
    server = await createServer({
      root,
      cacheDir,
      configFile: false,
      appType: "custom",
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { strict: true, allow: [root] },
      },
      optimizeDeps: { entries: [] },
    });
    await server.listen();
    const { port } = server.httpServer.address();
    const control = await request(port, "/control.js.map");
    assert.equal(control.status, 200);
    assert.equal(JSON.parse(control.body).file, "control.js");

    for (const requestPath of [
      "/node_modules/.vite/deps/../../../../outside.map",
      "/node_modules/.vite/deps/..%2f..%2f..%2f..%2foutside.map",
      "/node_modules/.vite/deps/%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.map",
    ]) {
      const result = await request(port, requestPath);
      assert.ok(!result.body.includes("OUTSIDE_ALLOWED_ROOT"), requestPath);
      // Encoded paths may return Vite's synthetic empty map rather than 404.
      if (result.status === 200) {
        assert.deepEqual(JSON.parse(result.body).sources, [], requestPath);
        assert.deepEqual(
          JSON.parse(result.body).sourcesContent,
          [],
          requestPath,
        );
      } else {
        assert.ok([403, 404].includes(result.status), requestPath);
      }
    }
  } finally {
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("documentation esbuild does not allow arbitrary websites to read its server", async () => {
  const viteRequire = createRequire(viteEntry);
  const { context } = await import(
    pathToFileURL(viteRequire.resolve("esbuild")).href
  );
  const fixture = await mkdtemp(path.join(tmpdir(), "docs-esbuild-security-"));
  let build;
  try {
    await writeFile(path.join(fixture, "control.txt"), "local control");
    build = await context({});
    const { port } = await build.serve({
      host: "127.0.0.1",
      port: 0,
      servedir: fixture,
    });
    const result = await request(port, "/control.txt", {
      Origin: "https://attacker.invalid",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, "local control");
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  } finally {
    await build?.dispose();
    await rm(fixture, { recursive: true, force: true });
  }
});
