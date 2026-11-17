import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("packages/core/package.json", root), "utf8"),
);
const target = new URL("python/pyproject.toml", root);
const source = await readFile(target, "utf8");
const matches = source.match(/^version = "[^"]+"/gm);
if (matches?.length !== 1 || !source.includes("[project]\n")) {
  throw new Error("Expected one Python project version in pyproject.toml");
}
const updated = source.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (source !== updated) await writeFile(target, updated);

const lockTarget = new URL("python/uv.lock", root);
const lock = await readFile(lockTarget, "utf8");
const packageVersion =
  /(\[\[package\]\]\nname = "clearideas-agent-runtime"\nversion = ")[^"]+("\n)/g;
if ([...lock.matchAll(packageVersion)].length !== 1) {
  throw new Error(
    "Expected one clearideas-agent-runtime entry in python/uv.lock",
  );
}
const updatedLock = lock.replace(
  packageVersion,
  (_, before, after) => `${before}${version}${after}`,
);
if (lock !== updatedLock) await writeFile(lockTarget, updatedLock);
