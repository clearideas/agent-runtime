#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packagesDirectory = path.join(root, "packages");
const expectedRepository =
  "git+https://github.com/clearideas/agent-runtime.git";
const expectedHomepage = "https://github.com/clearideas/agent-runtime#readme";
const expectedIssues = "https://github.com/clearideas/agent-runtime/issues";
const expectedRegistry = "https://registry.npmjs.org/";
const expectedPrerelease = /^0\.1\.0-alpha\.\d+$/u;
const entries = await readdir(packagesDirectory, { withFileTypes: true });
const failures = [];
const names = new Set();
const versions = new Set();
const npmConfig = await readFile(path.join(root, ".npmrc"), "utf8");
const rootManifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

if (rootManifest.private !== true) {
  failures.push("the workspace root must remain private:true");
}
for (const relativeManifest of [
  path.join("docs", "package.json"),
  path.join("examples", "interactive-web", "package.json"),
]) {
  const manifest = JSON.parse(
    await readFile(path.join(root, relativeManifest), "utf8"),
  );
  if (manifest.private !== true) {
    failures.push(
      `${relativeManifest}: non-package workspace must be private:true`,
    );
  }
}

if (
  !npmConfig
    .split(/\r?\n/u)
    .includes(`@clearideas:registry=${expectedRegistry}`)
) {
  failures.push(
    `.npmrc must route the @clearideas scope to ${expectedRegistry}`,
  );
}
if (npmConfig.includes("npm.pkg.github.com")) {
  failures.push(
    ".npmrc must not route Agent Runtime packages to GitHub Packages",
  );
}

for (const entry of entries.filter((value) => value.isDirectory())) {
  const relativeManifest = path.join("packages", entry.name, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, relativeManifest), "utf8"),
    );
  } catch (error) {
    failures.push(
      `${relativeManifest}: unreadable package manifest (${error.message})`,
    );
    continue;
  }

  const fail = (message) => failures.push(`${relativeManifest}: ${message}`);
  if (
    manifest.name !== "@clearideas/agent-runtime" &&
    !manifest.name?.startsWith("@clearideas/agent-runtime-")
  ) {
    fail(`unexpected package name ${JSON.stringify(manifest.name)}`);
  }
  if (names.has(manifest.name)) fail(`duplicate package name ${manifest.name}`);
  names.add(manifest.name);
  versions.add(manifest.version);

  if (manifest.private === true) {
    fail("publishable private-alpha package must not have private:true");
  }
  if (!expectedPrerelease.test(manifest.version)) {
    fail(
      `version must be a 0.1.0-alpha prerelease; found ${JSON.stringify(manifest.version)}`,
    );
  }
  if (manifest.license !== "Apache-2.0") fail("license must be Apache-2.0");
  if (manifest.repository?.type !== "git") fail("repository.type must be git");
  if (manifest.repository?.url !== expectedRepository) {
    fail(`repository.url must be ${expectedRepository}`);
  }
  if (manifest.repository?.directory !== `packages/${entry.name}`) {
    fail(`repository.directory must be packages/${entry.name}`);
  }
  if (manifest.homepage !== expectedHomepage) {
    fail(`homepage must be ${expectedHomepage}`);
  }
  if (manifest.bugs?.url !== expectedIssues) {
    fail(`bugs.url must be ${expectedIssues}`);
  }
  if (
    !Array.isArray(manifest.keywords) ||
    !["ai", "agents", "agent-runtime", "workflows"].every((keyword) =>
      manifest.keywords.includes(keyword),
    )
  ) {
    fail("keywords must identify AI agents, Agent Runtime, and workflows");
  }
  if (manifest.publishConfig?.access !== "restricted") {
    fail("publishConfig.access must be restricted for the private alpha");
  }
  if (manifest.publishConfig?.provenance !== false) {
    fail(
      "publishConfig.provenance must be false while the repository is private",
    );
  }
  if (manifest.publishConfig?.registry !== expectedRegistry) {
    fail(`publishConfig.registry must be ${expectedRegistry}`);
  }
  if (manifest.engines?.node !== ">=24") fail("engines.node must be >=24");
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    fail("files must explicitly include dist");
  }
  if (
    !manifest.scripts?.build ||
    !manifest.scripts?.test ||
    !manifest.scripts?.prepack
  ) {
    fail("build, test, and prepack scripts are required");
  }

  const runtimeDependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  };
  for (const [dependency, range] of Object.entries(runtimeDependencies)) {
    if (
      (dependency === "@clearideas/agent-runtime" ||
        dependency.startsWith("@clearideas/agent-runtime-")) &&
      range !== manifest.version
    ) {
      fail(
        `internal dependency ${dependency} must match ${manifest.version}; found ${range}`,
      );
    }
  }
}

if (versions.size !== 1) {
  failures.push(
    `workspace packages must begin with one aligned version; found ${[
      ...versions,
    ].join(", ")}`,
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `Package metadata validation failed:\n${failures
      .map((value) => `- ${value}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Package metadata is private-alpha ready (${names.size} restricted packages).\n`,
  );
}
