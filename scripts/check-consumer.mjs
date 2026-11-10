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
  await writeFile(
    path.join(consumer, "serve.agent.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      model: { provider: "test", model: "local" },
      messages: { required: true },
      steps: [
        {
          id: "reply",
          type: "prompt",
          systemPrompt: "Answer.",
          history: "all",
        },
      ],
    }),
  );
  const source = `import { AgentServer, createFetchHandler, singleManifestServerConfig } from '@clearideas/agent-runtime-server';
import { createAgentRuntime, createHmacMessageSigner, conversationTurns, defineAgent, MessagesValidationError } from '@clearideas/agent-runtime';
const manifest = defineAgent({schemaVersion:'1.0',model:{provider:'openai',model:'test'},steps:[{id:'hello',type:'prompt',prompt:'Hello',includeInFinalOutput:true}]});
const result = await createAgentRuntime({manifest,model:{generate:async()=>({output:'hello',transcript:[]})}}).run({});
if(result.output !== 'hello') throw new Error('Unexpected consumer result');
const chat = createAgentRuntime({
  manifest: defineAgent({schemaVersion:'1.0', model:{provider:'openai',model:'test'}, messages:{required:true,requireSignature:true}, steps:[{id:'reply',type:'prompt',systemPrompt:'Answer.',history:'all'}]}),
  messages: {signer:createHmacMessageSigner({activeKeyId:'test',keys:{test:'hex:'+'ab'.repeat(32)}})},
  model: {generate:async(request)=>({output:'reply '+request.messages.filter(message=>message.role==='user').length,transcript:[]})},
});
const first = await chat.run({messages:[{role:'user',content:'Hello'}],messagesScope:'consumer:chat'});
if(!first.messages || !first.messagesSignature) throw new Error('Packed runtime did not return signed history');
const history = [...first.messages, {role:'user' as const,content:'Again'}];
const second = await chat.run({messages:history,messagesSignature:first.messagesSignature,messagesScope:'consumer:chat'});
if(second.output !== 'reply 2' || !second.messages || conversationTurns(second.messages).currentTurn !== 3) throw new Error('Packed conversation did not continue');
try {
  await chat.run({messages:history,messagesSignature:first.messagesSignature,messagesScope:'consumer:another-chat'});
  throw new Error('Packed conversation accepted a replay in another scope');
} catch(error) {
  if(!(error instanceof MessagesValidationError) || error.code !== 'MESSAGES_SIGNATURE_INVALID') throw error;
}
`;
  const serverSource = `
const server = await AgentServer.create({
  loaded: singleManifestServerConfig({manifest:'./serve.agent.json',servedModelName:'packed-agent'}),
  runtime: {model:{generate:async()=>({output:'packed reply',transcript:[]})}},
  logger: {info(){},warn(){},error(){}},
});
try {
  const handle = createFetchHandler(server);
  const models = await handle(new Request('http://localhost/v1/models'));
  if(models.status !== 200 || (await models.json()).data[0].id !== 'packed-agent') throw new Error('Packed server did not list its model');
  const response = await handle(new Request('http://localhost/v1/chat/completions', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'packed-agent',messages:[{role:'user',content:'Hello'}]}),
  }));
  if(response.status !== 200 || (await response.json()).choices[0].message.content !== 'packed reply') throw new Error('Packed server did not execute its manifest');
} finally { await server.shutdown(0); }
`;
  await writeFile(path.join(consumer, "smoke.ts"), source + serverSource);
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
  const checked = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        "serve",
        "./serve.agent.json",
        "--runtime-module",
        "./mock.mjs",
        "--check",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  if (checked.valid !== true || checked.models[0].name !== "serve")
    throw new Error("Packed CLI did not preflight its served manifest");
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
    `Packed API, TypeScript, CLI, and server passed. Combined standard API + CLI installation: ${Object.keys(lock.packages).length - 1} packages, ${(bytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
