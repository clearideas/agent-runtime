#!/usr/bin/env node

import { access, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const packageRoot = process.cwd();
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const packagesRoot = path.join(repositoryRoot, "packages");
if (!packageRoot.startsWith(`${packagesRoot}${path.sep}`)) {
  throw new Error(
    "Package license preparation must run from a direct packages/* workspace.",
  );
}

const marker = path.join(packageRoot, ".license-prepack-generated");
const generated = [];

for (const name of ["LICENSE", "NOTICE"]) {
  const source = path.join(repositoryRoot, name);
  const target = path.join(packageRoot, name);
  const expected = await readFile(source);
  try {
    await access(target);
    const existing = await readFile(target);
    if (!existing.equals(expected)) {
      throw new Error(`Existing package ${name} differs from ${source}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(source, target);
    generated.push(name);
  }
}

if (generated.length > 0) {
  await rm(marker, { force: true });
  await writeFile(marker, `${JSON.stringify({ generated }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}
