import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("packages/core/package.json", root), "utf8"),
);
const target = new URL("packages/core/src/version.ts", root);
const source = `// Generated from package.json by scripts/generate-runtime-version.mjs.
export const RUNTIME_VERSION = ${JSON.stringify(version)};
`;
if ((await readFile(target, "utf8").catch(() => "")) !== source)
  await writeFile(target, source);
