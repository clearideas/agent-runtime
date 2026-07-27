#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packagesDirectory = path.join(root, "packages");
const packageLicenseCleanup = path.join(
  root,
  "scripts",
  "cleanup-package-license.mjs",
);
const npmCache = await mkdtemp(path.join(tmpdir(), "agent-runtime-pack-"));
const entries = (
  await readdir(packagesDirectory, { withFileTypes: true })
).filter((entry) => entry.isDirectory());
const failures = [];
const reports = [];
const forbiddenPath =
  /(^|\/)(?:src|test|tests|coverage|node_modules)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.test\.[cm]?[jt]sx?$|\.tsbuildinfo$|(?:^|\/)(?:id_rsa|id_ed25519)$|\.(?:pem|key)$/u;

for (const entry of entries) {
  const packageRoot = path.join(packagesDirectory, entry.name);
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: npmCache,
        npm_config_fund: "false",
        npm_config_loglevel: "error",
      },
    },
  );
  const cleanup = spawnSync(process.execPath, [packageLicenseCleanup], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (cleanup.status !== 0) {
    failures.push(
      `${manifest.name}: package license cleanup failed: ${(
        cleanup.stderr || cleanup.stdout
      ).trim()}`,
    );
  }

  if (result.status !== 0) {
    failures.push(
      `${manifest.name}: npm pack failed: ${(
        result.stderr || result.stdout
      ).trim()}`,
    );
    continue;
  }

  let pack;
  try {
    [pack] = JSON.parse(result.stdout);
  } catch {
    failures.push(`${manifest.name}: npm pack returned invalid JSON`);
    continue;
  }
  const files = new Map(pack.files.map((file) => [file.path, file]));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    if (!files.has(required))
      failures.push(`${manifest.name}: tarball is missing ${required}`);
  }
  if (manifest.bin) {
    for (const target of Object.values(manifest.bin)) {
      if (!files.has(target.replace(/^\.\//u, ""))) {
        failures.push(
          `${manifest.name}: tarball is missing executable ${target}`,
        );
      }
    }
  }
  for (const file of files.values()) {
    if (forbiddenPath.test(file.path)) {
      failures.push(
        `${manifest.name}: tarball contains forbidden path ${file.path}`,
      );
    }
    if (file.size > 2 * 1024 * 1024) {
      failures.push(
        `${manifest.name}: ${file.path} exceeds the 2 MiB per-file limit`,
      );
    }
  }
  if (pack.unpackedSize > 5 * 1024 * 1024) {
    failures.push(`${manifest.name}: unpacked tarball exceeds 5 MiB`);
  }
  reports.push({
    name: manifest.name,
    filename: pack.filename,
    files: files.size,
    bytes: pack.size,
    unpackedBytes: pack.unpackedSize,
  });
}

await rm(npmCache, { recursive: true, force: true });

if (failures.length > 0) {
  process.stderr.write(
    `Tarball validation failed:\n${failures
      .map((value) => `- ${value}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  process.stdout.write(
    `Tarball contents are clean (${reports.length} packages).\n`,
  );
}
