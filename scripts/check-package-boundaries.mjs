#!/usr/bin/env node

import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const packagesRoot = path.join(workspaceRoot, "packages");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const testOnlyImports = new Set(["vitest"]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (sourceExtensions.has(path.extname(entry.name)))
      files.push(entryPath);
  }
  return files;
};

const importSpecifiers = (source) => {
  const values = new Set();
  for (const pattern of [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) values.add(match[1]);
  }
  return values;
};

const dependencyName = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];

const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
const runtimePackages = packageEntries
  .filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(path.join(packagesRoot, entry.name, "package.json")),
  )
  .map((entry) => path.join(packagesRoot, entry.name));

const violations = [];
for (const packageRoot of runtimePackages) {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]);

  for (const name of declared) {
    if (
      name.startsWith("@clearideas/") &&
      name !== "@clearideas/agent-runtime" &&
      !name.startsWith("@clearideas/agent-runtime-")
    ) {
      violations.push({
        file: path.relative(
          workspaceRoot,
          path.join(packageRoot, "package.json"),
        ),
        reason: `declares private Clear Ideas dependency ${name}`,
      });
    }
  }

  for (const file of await collectFiles(packageRoot)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        if (
          target !== packageRoot &&
          !target.startsWith(`${packageRoot}${path.sep}`)
        ) {
          violations.push({
            file: path.relative(workspaceRoot, file),
            reason: `imports outside its package (${specifier})`,
          });
        }
        continue;
      }
      if (specifier.startsWith("/") || specifier.startsWith("#")) {
        violations.push({
          file: path.relative(workspaceRoot, file),
          reason: `uses unsupported import ${specifier}`,
        });
        continue;
      }
      const dependency = dependencyName(specifier);
      if (
        !builtins.has(specifier) &&
        !declared.has(dependency) &&
        !testOnlyImports.has(dependency) &&
        !(
          file.includes(".test.") &&
          (dependency === "@clearideas/agent-runtime" ||
            dependency.startsWith("@clearideas/agent-runtime-"))
        )
      ) {
        violations.push({
          file: path.relative(workspaceRoot, file),
          reason: `imports undeclared or private dependency ${specifier}`,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Agent Runtime package import boundary violations:");
  for (const violation of violations)
    console.error(`- ${violation.file}: ${violation.reason}`);
  process.exitCode = 1;
} else {
  console.log(
    `Agent Runtime package import boundaries are clean (${runtimePackages.length} packages).`,
  );
}
