// Install real tarballs outside the workspace: no source aliases or workspace links.
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "agent-runtime-consumer-"));
const npm = process.env.npm_execpath;
const runNpm = (args, cwd) =>
  execFileSync(
    npm ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    [...(npm ? [npm] : []), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: path.join(scratch, "cache") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
const packages = new Map();
for (const name of await readdir(path.join(root, "packages"))) {
  const directory = path.join(root, "packages", name);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  packages.set(manifest.name, { directory, manifest });
}
const selected = new Set();
const visit = (name) => {
  if (selected.has(name) || !packages.has(name)) return;
  selected.add(name);
  for (const dependency of Object.keys(
    packages.get(name).manifest.dependencies ?? {},
  ))
    visit(dependency);
};
visit("@clearideas/agent-runtime");
visit("@clearideas/agent-runtime-cli");
try {
  const dependencies = {};
  for (const name of selected) {
    const result = JSON.parse(
      runNpm(
        ["pack", "--json", "--pack-destination", scratch],
        packages.get(name).directory,
      ),
    );
    const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
    dependencies[name] = `file:${path.join(scratch, pack.filename)}`;
  }
  const consumer = path.join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  runNpm(
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    consumer,
  );
  const source = `import { createAgentRuntime, defineAgent } from '@clearideas/agent-runtime';
const manifest = defineAgent({schemaVersion:'1.0',model:{provider:'openai',model:'test'},steps:[{id:'hello',type:'prompt',prompt:'Hello',includeInFinalOutput:true}]});
const result = await createAgentRuntime({manifest,model:{generate:async()=>({output:'hello',transcript:[]})}}).run({});
if(result.output !== 'hello') throw new Error('Unexpected consumer result');
`;
  await writeFile(path.join(consumer, "smoke.ts"), source);
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["smoke.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      path.join(consumer, "tsconfig.json"),
    ],
    { stdio: "pipe" },
  );
  execFileSync(process.execPath, ["smoke.ts"], {
    cwd: consumer,
    stdio: "pipe",
  });
  const cli = path.join(
    consumer,
    "node_modules/@clearideas/agent-runtime-cli/dist/bin.js",
  );
  const listed = execFileSync(process.execPath, [cli, "examples", "list"], {
    cwd: consumer,
    encoding: "utf8",
  });
  if (!listed.includes("variables"))
    throw new Error("Packed CLI did not list examples");
  await writeFile(
    path.join(consumer, "mock.mjs"),
    "export const model = {generate:async()=>({output:'hello',transcript:[]})};",
  );
  execFileSync(
    process.execPath,
    [
      cli,
      "examples",
      "run",
      "variables",
      "--runtime-module",
      "./mock.mjs",
      "--events",
      "none",
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  let bytes = 0;
  const measure = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await measure(target);
      else if (entry.isFile()) bytes += (await stat(target)).size;
    }
  };
  await measure(path.join(consumer, "node_modules"));
  const lock = JSON.parse(
    await readFile(path.join(consumer, "package-lock.json"), "utf8"),
  );
  console.log(
    `Packed API, TypeScript, and CLI passed. Combined standard API + CLI installation: ${Object.keys(lock.packages).length - 1} packages, ${(bytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
