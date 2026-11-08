#!/usr/bin/env node
/**
 * npm run use-local-runtime
 *
 * Runs the showcase against this repository's own Agent Runtime packages
 * instead of the published versions in package.json. Use it to try demos that
 * need runtime changes that are not released yet, such as Long Investigation.
 *
 * It removes the published @clearideas packages from this example's
 * node_modules, so Node resolves them from the repository root's workspace
 * links (node_modules/@clearideas/* → packages/*). Nothing tracked changes.
 * Run `npm ci` here to return to the published packages.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const showcase = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repository = path.resolve(showcase, "..", "..");
const stop = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

if (
  !existsSync(
    path.join(repository, "packages", "agent-runtime", "package.json"),
  )
)
  stop(
    "This script runs inside the agent-runtime repository (examples/showcase).",
  );
if (
  !existsSync(
    path.join(repository, "node_modules", "@clearideas", "agent-runtime"),
  )
)
  stop(
    "The repository's dependencies are not installed. From the repository root, run:\n    npm ci\n    npm run build",
  );
if (
  !existsSync(
    path.join(repository, "packages", "agent-runtime", "dist", "index.js"),
  )
)
  stop(
    "The repository's packages are not built. From the repository root, run:\n    npm run build",
  );
if (!existsSync(path.join(showcase, "node_modules")))
  stop(
    "This example's dependencies are not installed. In examples/showcase, run:\n    npm ci",
  );

rmSync(path.join(showcase, "node_modules", "@clearideas"), {
  recursive: true,
  force: true,
});

const entry = createRequire(path.join(showcase, "package.json")).resolve(
  "@clearideas/agent-runtime",
);
const local = path
  .relative(repository, entry)
  .split(path.sep)
  .slice(0, 2)
  .join("/");
if (local !== "packages/agent-runtime")
  stop(`@clearideas/agent-runtime still resolves to ${entry}.`);
const { version } = JSON.parse(
  readFileSync(
    path.join(repository, "packages", "agent-runtime", "package.json"),
    "utf8",
  ),
);

console.log(`
✓ The showcase now uses this repository's Agent Runtime, built from source
  (package version ${version}, ${path.join(repository, "packages")}).
  Rebuild with \`npm run build\` at the repository root after changing runtime code.
  To return to the published packages, run \`npm ci\` in examples/showcase.
`);
