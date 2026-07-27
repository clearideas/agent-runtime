#!/usr/bin/env node

import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const packageRoot = process.cwd();
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const packagesRoot = path.join(repositoryRoot, "packages");
if (!packageRoot.startsWith(`${packagesRoot}${path.sep}`)) {
  throw new Error(
    "Package license cleanup must run from a direct packages/* workspace.",
  );
}

const marker = path.join(packageRoot, ".license-prepack-generated");

try {
  await access(marker);
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}

const markerValue = JSON.parse(await readFile(marker, "utf8"));
if (
  !Array.isArray(markerValue.generated) ||
  markerValue.generated.some((name) => name !== "LICENSE" && name !== "NOTICE")
) {
  throw new Error("Package legal-file marker is malformed.");
}

for (const name of markerValue.generated) {
  const source = path.join(repositoryRoot, name);
  const target = path.join(packageRoot, name);
  const [expected, generated] = await Promise.all([
    readFile(source),
    readFile(target),
  ]);
  if (!generated.equals(expected)) {
    throw new Error(
      `Refusing to remove a generated package ${name} whose content changed.`,
    );
  }
  await rm(target);
}
await rm(marker);
