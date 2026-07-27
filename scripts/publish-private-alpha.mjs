#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const registry = "https://registry.npmjs.org/";
const publish = process.argv.includes("--publish");
const root = process.cwd();
const packagesDirectory = path.join(root, "packages");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, options = {}) {
  return spawnSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      npm_config_registry: registry,
      ...options.env,
    },
  });
}

function outputFor(result) {
  return (result.stderr || result.stdout || "").trim();
}

const entries = (
  await readdir(packagesDirectory, { withFileTypes: true })
).filter((entry) => entry.isDirectory());
const packages = [];
const failures = [];

for (const entry of entries) {
  const directory = path.join(packagesDirectory, entry.name);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (manifest.private === true) continue;
  packages.push({ directory, manifest });
}

const byName = new Map(packages.map((item) => [item.manifest.name, item]));
const versions = new Set(packages.map((item) => item.manifest.version));
if (packages.length === 0) failures.push("no publishable packages found");
if (versions.size !== 1) {
  failures.push(
    `package versions are not aligned: ${[...versions].join(", ")}`,
  );
}

for (const { manifest } of packages) {
  if (!/^0\.1\.0-alpha\.\d+$/u.test(manifest.version)) {
    failures.push(
      `${manifest.name}: ${manifest.version} is not an alpha version`,
    );
  }
  if (manifest.publishConfig?.access !== "restricted") {
    failures.push(`${manifest.name}: publishConfig.access must be restricted`);
  }
  if (manifest.publishConfig?.provenance !== false) {
    failures.push(
      `${manifest.name}: provenance must be false for the private repository`,
    );
  }
  if (manifest.publishConfig?.registry !== registry) {
    failures.push(`${manifest.name}: registry must be ${registry}`);
  }
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (byName.has(name) && range !== manifest.version) {
        failures.push(
          `${manifest.name}: ${section}.${name} must be ${manifest.version}; found ${range}`,
        );
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();
const ordered = [];
function visit(item) {
  const name = item.manifest.name;
  if (visited.has(name)) return;
  if (visiting.has(name)) {
    failures.push(`internal dependency cycle includes ${name}`);
    return;
  }
  visiting.add(name);
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const dependency of Object.keys(item.manifest[section] ?? {})) {
      const internal = byName.get(dependency);
      if (internal) visit(internal);
    }
  }
  visiting.delete(name);
  visited.add(name);
  ordered.push(item);
}
for (const item of packages) visit(item);

if (failures.length > 0) {
  process.stderr.write(
    `Private-alpha release validation failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Private-alpha package order (${ordered.length} packages):\n${ordered
    .map(
      ({ manifest }, index) =>
        `${index + 1}. ${manifest.name}@${manifest.version}`,
    )
    .join("\n")}\n`,
);

if (!publish) {
  process.stdout.write(
    "\nValidation only. Run `npm run release:bootstrap:private` after npm login to publish with the alpha tag.\n",
  );
  process.exit(0);
}

const identity = run(["whoami"]);
if (identity.status !== 0) {
  process.stderr.write(
    `npm authentication is required before publishing: ${outputFor(identity)}\n`,
  );
  process.exit(1);
}
process.stdout.write(`\nPublishing as npm user ${identity.stdout.trim()}.\n`);

for (const { directory, manifest } of ordered) {
  const specifier = `${manifest.name}@${manifest.version}`;
  const existing = run(["view", specifier, "version", "--json"]);
  if (existing.status === 0) {
    process.stdout.write(`Skipping ${specifier}; it already exists.\n`);
    continue;
  }
  const lookupError = outputFor(existing);
  if (!/\bE404\b|404 Not Found/iu.test(lookupError)) {
    process.stderr.write(
      `Could not confirm whether ${specifier} exists: ${lookupError}\n`,
    );
    process.exit(existing.status ?? 1);
  }

  process.stdout.write(`Publishing ${specifier}...\n`);
  const result = run(
    [
      "publish",
      directory,
      "--access",
      "restricted",
      "--tag",
      "alpha",
      "--provenance=false",
    ],
    { stdio: "inherit", encoding: undefined },
  );
  if (result.status !== 0) {
    process.stderr.write(
      `Publishing stopped at ${specifier}. Re-run the command after resolving the error; previously published versions will be skipped.\n`,
    );
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(
  "\nPrivate alpha published. Configure the trusted publisher for every package before enabling the GitHub release workflow.\n",
);
