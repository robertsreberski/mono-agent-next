#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = "0.15.0";
const EXPECTED_REPLY = "mono-agent-next-packed-e2e-ok";
const WEBHOOK_SECRET = "packed-smoke-webhook-token";
const COMMAND_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const PACKAGES = Object.freeze([
  { name: "@mono-agent/module-sdk", directory: "packages/module-sdk" },
  { name: "@mono-agent/core", directory: "packages/core" },
  { name: "@mono-agent/cli", directory: "packages/cli" },
  { name: "@mono-agent/runtime-pi", directory: "packages/runtime-pi" },
  { name: "@mono-agent/channel-webhook", directory: "packages/channel-webhook" },
  { name: "create-mono-agent", directory: "packages/create-mono-agent" },
]);

const RUNTIME_DEPENDENCIES = Object.freeze([
  "@mono-agent/module-sdk",
  "@mono-agent/core",
  "@mono-agent/cli",
  "@mono-agent/runtime-pi",
  "@mono-agent/channel-webhook",
]);

const FORBIDDEN_V0_PACKAGES = Object.freeze([
  "@mono-agent/agent-app",
  "@mono-agent/agent-runtime",
  "@mono-agent/runtime-adapter",
  "@mono-agent/webhook-adapter",
]);

async function main() {
  assertSupportedNode();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-agent-v1-minimal-"));
  const tarballDirectory = join(temporaryRoot, "tarballs");
  const bootstrapDirectory = join(temporaryRoot, "bootstrap");
  const consumerDirectory = join(temporaryRoot, "consumer");
  let runningCli;
  let provider;
  let packageRegistry;

  try {
    await Promise.all([
      mkdir(tarballDirectory, { recursive: true }),
      mkdir(bootstrapDirectory, { recursive: true }),
    ]);

    buildPackages();
    const tarballs = packPackages(tarballDirectory);
    packageRegistry = await startPackageRegistry(tarballs);
    await installScaffolder(bootstrapDirectory, tarballs, packageRegistry.url);
    run(
      join(bootstrapDirectory, "node_modules", ".bin", "create-mono-agent"),
      [consumerDirectory],
      bootstrapDirectory,
    );

    const scaffoldManifestPath = join(consumerDirectory, "package.json");
    const scaffoldManifest = await readJson(scaffoldManifestPath);
    assertScaffoldDependencies(scaffoldManifest);

    await installPackedRuntime(consumerDirectory, packageRegistry.url);
    await assertCleanInstalledClosure(consumerDirectory);

    provider = await startOpenAiCompatibleProvider();
    const configPath = join(consumerDirectory, "mono-agent.config.json");
    const cli = join(consumerDirectory, "node_modules", ".bin", "mono-agent");
    const childEnvironment = { ...process.env, WEBHOOK_API_KEY: WEBHOOK_SECRET };
    const untouchedValidation = run(
      cli,
      ["validate", "--config", configPath, "--json"],
      consumerDirectory,
      childEnvironment,
    );
    assertJsonOk(untouchedValidation.stdout, "untouched scaffold validate");

    const scaffoldSchemaPath = join(consumerDirectory, ".mono-agent", "mono-agent.config.schema.json");
    const scaffoldSchema = JSON.parse(await readFile(scaffoldSchemaPath, "utf8"));
    assertScaffoldSchemaBoundary(scaffoldSchema);

    const schema = run(
      cli,
      ["config", "schema", "--config", configPath, "--write"],
      consumerDirectory,
      childEnvironment,
    );
    assertJsonOk(schema.stdout, "config schema");
    const generatedSchema = JSON.parse(
      await readFile(scaffoldSchemaPath, "utf8"),
    );
    if (generatedSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      throw new Error("Generated config schema did not use JSON Schema draft 2020-12");
    }

    await writeJson(configPath, packedSmokeConfig(provider.baseUrl));
    const smokeValidation = run(
      cli,
      ["validate", "--config", configPath, "--json"],
      consumerDirectory,
      childEnvironment,
    );
    assertJsonOk(smokeValidation.stdout, "local-provider smoke validate");

    const explanation = run(
      cli,
      ["config", "explain", "--config", configPath, "--json", "channels.inbound.apiKey"],
      consumerDirectory,
      childEnvironment,
    );
    if (!explanation.stdout.includes("WEBHOOK_API_KEY")) {
      throw new Error("Config explanation did not preserve the API-key environment provenance");
    }
    if (explanation.stdout.includes(WEBHOOK_SECRET)) {
      throw new Error("Config explanation exposed the resolved API-key value");
    }

    runningCli = startCli(cli, configPath, consumerDirectory, childEnvironment);
    const started = await runningCli.started;
    const endpoint = started.channels?.find((channel) => channel.instanceId === "inbound")?.endpoint;
    if (typeof endpoint !== "string" || !endpoint.endsWith("/webhook/invoke")) {
      throw new Error(`CLI did not report the webhook endpoint: ${JSON.stringify(started)}`);
    }

    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "prove the packed runtime" }),
    });
    if (unauthorized.status !== 401) {
      throw new Error(`Unauthenticated webhook request returned ${String(unauthorized.status)}, expected 401`);
    }
    const unauthorizedBody = await unauthorized.text();
    if (unauthorizedBody.includes(WEBHOOK_SECRET)) {
      throw new Error("Unauthenticated webhook response exposed the configured secret");
    }

    const authorized = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WEBHOOK_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "prove the packed runtime",
        conversationId: "packed-e2e",
      }),
    });
    const authorizedBody = await authorized.text();
    if (authorized.status !== 200) {
      throw new Error(`Authenticated webhook request returned ${String(authorized.status)}: ${authorizedBody}`);
    }
    const completed = JSON.parse(authorizedBody);
    if (completed.status !== "succeeded" || completed.text !== EXPECTED_REPLY) {
      throw new Error(`Packed turn returned an unexpected result: ${authorizedBody}`);
    }

    const signalled = runningCli.child.kill("SIGTERM");
    let exit;
    try {
      exit = await withTimeout(runningCli.exited, SHUTDOWN_TIMEOUT_MS, "CLI shutdown");
    } catch (error) {
      const output = runningCli.output();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; SIGTERM delivered: ${String(signalled)}\n`
        + `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
    runningCli = undefined;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`CLI shutdown was not clean: ${JSON.stringify(exit)}`);
    }

    console.log(
      `Verified scaffold, packed five-package runtime closure, authenticated webhook, Pi-native turn, and graceful shutdown on Node.js ${process.versions.node}.`,
    );
  } finally {
    if (runningCli !== undefined) {
      await terminateRunningCli(runningCli);
    }
    await provider?.close();
    await packageRegistry?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Packed v1 proof requires Node.js >=22.19.0; current runtime is ${process.versions.node}`);
  }
}

function buildPackages() {
  const args = ["-r", "--sort"];
  for (const pkg of PACKAGES) args.push("--filter", pkg.name);
  args.push("run", "build");
  run("pnpm", args, REPO_ROOT);
}

function packPackages(tarballDirectory) {
  const packed = new Map();
  for (const pkg of PACKAGES) {
    const result = run(
      "pnpm",
      ["--dir", pkg.directory, "pack", "--pack-destination", tarballDirectory, "--json"],
      REPO_ROOT,
    );
    const packResult = parsePackJson(result.stdout);
    if (packResult.name !== pkg.name || packResult.version !== VERSION) {
      throw new Error(
        `Packed identity mismatch for ${pkg.name}: ${String(packResult.name)}@${String(packResult.version)}`,
      );
    }
    const packedFiles = new Set((packResult.files ?? []).map((entry) => entry.path));
    for (const required of ["package.json", "README.md", "LICENSE"]) {
      if (!packedFiles.has(required)) throw new Error(`${pkg.name} tarball is missing ${required}`);
    }
    const filename = typeof packResult.filename === "string"
      ? packResult.filename
      : `${pkg.name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`;
    const tarballPath = resolve(tarballDirectory, filename);
    packed.set(pkg.name, tarballPath);
  }
  return packed;
}

function parsePackJson(output) {
  const start = output.search(/^(?:\{|\[)/mu);
  if (start === -1) throw new Error("pnpm pack did not emit JSON");
  const parsed = JSON.parse(output.slice(start));
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error(`pnpm pack emitted ${String(parsed.length)} results`);
    return parsed[0];
  }
  return parsed;
}

async function installScaffolder(directory, tarballs, registryUrl) {
  await writeJson(join(directory, "package.json"), {
    name: "mono-agent-next-scaffold-bootstrap",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { "create-mono-agent": `file:${tarballs.get("create-mono-agent")}` },
  });
  await writeRegistryConfig(directory, registryUrl);
  await runAsync(
    "pnpm",
    ["install", "--ignore-scripts", "--no-frozen-lockfile"],
    directory,
    installEnvironment(),
  );
}

function assertScaffoldDependencies(manifest) {
  const actual = Object.keys(manifest.dependencies ?? {}).sort();
  const expected = [...RUNTIME_DEPENDENCIES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Scaffold dependency set must be exactly ${expected.join(", ")}; found ${actual.join(", ")}`);
  }
  for (const dependency of expected) {
    if (manifest.dependencies[dependency] !== VERSION) {
      throw new Error(`Scaffold must pin ${dependency} to ${VERSION}`);
    }
  }
}

async function installPackedRuntime(directory, registryUrl) {
  await writeRegistryConfig(directory, registryUrl);
  const environment = installEnvironment();
  await runAsync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], directory, environment);
  await runAsync("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile"], directory, environment);
}

async function assertCleanInstalledClosure(directory) {
  const lockPath = join(directory, "pnpm-lock.yaml");
  const lock = await readFile(lockPath, "utf8");
  for (const forbidden of FORBIDDEN_V0_PACKAGES) {
    if (lock.includes(forbidden)) {
      throw new Error(`Packed project lockfile contains predecessor package ${forbidden}`);
    }
  }

  const listed = run("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], directory).stdout;
  for (const forbidden of FORBIDDEN_V0_PACKAGES) {
    if (listed.includes(forbidden)) {
      throw new Error(`Packed project installed predecessor package ${forbidden}`);
    }
  }
  const listedPackages = collectPackageNames(JSON.parse(listed));
  const installedMonoAgentPackages = [...listedPackages]
    .filter((name) => name.startsWith("@mono-agent/"))
    .sort();
  const expectedMonoAgentPackages = [...RUNTIME_DEPENDENCIES].sort();
  if (JSON.stringify(installedMonoAgentPackages) !== JSON.stringify(expectedMonoAgentPackages)) {
    throw new Error(
      `Packed project @mono-agent closure must be exactly ${expectedMonoAgentPackages.join(", ")}; `
      + `found ${installedMonoAgentPackages.join(", ")}`,
    );
  }

  const nativeAddons = await findFiles(join(directory, "node_modules"), (name) => name.endsWith(".node"));
  if (nativeAddons.length > 0) {
    throw new Error(`Packed project unexpectedly installed native addons: ${nativeAddons.join(", ")}`);
  }

  for (const packageName of RUNTIME_DEPENDENCIES) {
    const installed = await readJson(join(directory, "node_modules", ...packageName.split("/"), "package.json"));
    if (installed.name !== packageName || installed.version !== VERSION) {
      throw new Error(`Installed package identity mismatch for ${packageName}`);
    }
  }
}

function collectPackageNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPackageNames(entry, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (typeof value.name === "string") output.add(value.name);
  if (typeof value.from === "string") output.add(value.from);
  if (value.dependencies !== null && typeof value.dependencies === "object" && !Array.isArray(value.dependencies)) {
    for (const name of Object.keys(value.dependencies)) output.add(name);
  }
  for (const child of Object.values(value)) collectPackageNames(child, output);
  return output;
}

function assertScaffoldSchemaBoundary(schema) {
  const runtimeUse = schema?.properties?.runtimes?.properties?.pi?.properties?.$use?.const;
  const channelUse = schema?.properties?.channels?.properties?.inbound?.properties?.$use?.const;
  const envPattern = schema?.$defs?.envReference?.properties?.$env?.pattern;
  if (runtimeUse !== "@mono-agent/runtime-pi" || channelUse !== "@mono-agent/channel-webhook") {
    throw new Error("Scaffold schema does not lock the generated project to the selected runtime and channel modules");
  }
  if (envPattern !== "^[A-Z_][A-Z0-9_]*$") {
    throw new Error("Scaffold schema does not preserve the explicit environment-reference boundary");
  }
}

async function writeRegistryConfig(directory, registryUrl) {
  await writeFile(join(directory, ".npmrc"), `@mono-agent:registry=${registryUrl}\n`, "utf8");
}

function installEnvironment() {
  return {
    ...process.env,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

function packedSmokeConfig(providerBaseUrl) {
  return {
    $schema: "./.mono-agent/mono-agent.config.schema.json",
    configVersion: 1,
    agent: {
      id: "packed-e2e",
      name: "Packed E2E",
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: { path: "./.secrets/pi/auth.json" },
        retry: { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 },
        localProviders: [
          {
            id: "local",
            baseUrl: providerBaseUrl,
            models: [{ id: "echo", contextWindow: 16_384, maxTokens: 1_024 }],
          },
        ],
      },
    },
    routing: {
      primary: { runtime: "pi", model: "local:echo" },
      fallbacks: [],
      effort: "high",
    },
    session: { mode: "continuous" },
    channels: {
      inbound: {
        $use: "@mono-agent/channel-webhook",
        listen: { host: "127.0.0.1", port: 0 },
        apiKey: { $env: "WEBHOOK_API_KEY" },
        defaultMode: "sync",
        maxRunMs: 10_000,
      },
    },
    policy: {
      tools: { default: "deny", allow: [] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    },
  };
}

async function startPackageRegistry(tarballs) {
  const packages = new Map();
  for (const packageName of RUNTIME_DEPENDENCIES) {
    const tarballPath = tarballs.get(packageName);
    if (tarballPath === undefined) throw new Error(`Missing packed tarball for ${packageName}`);
    const bytes = await readFile(tarballPath);
    const manifest = readPackedManifest(tarballPath);
    packages.set(packageName, {
      bytes,
      manifest,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }

  let registryUrl;
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://registry.invalid").pathname);
      if (pathname.startsWith("/tarballs/")) {
        const packageName = pathname.slice("/tarballs/".length, -`.tgz`.length);
        const entry = packages.get(packageName);
        if (entry === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-length": String(entry.bytes.length),
          "content-type": "application/octet-stream",
        });
        response.end(entry.bytes);
        return;
      }
      const packageName = pathname.replace(/^\//u, "");
      const entry = packages.get(packageName);
      if (entry === undefined || registryUrl === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const tarball = `${registryUrl}tarballs/${packageName}.tgz`;
      const versionManifest = {
        ...entry.manifest,
        dist: { tarball, shasum: entry.shasum, integrity: entry.integrity },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: packageName,
        "dist-tags": { latest: VERSION },
        versions: { [VERSION]: versionManifest },
      }));
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "registry fixture failed" }));
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Package registry fixture did not bind a port");
  registryUrl = `http://127.0.0.1:${String(address.port)}/`;
  return {
    url: registryUrl,
    async close() {
      server.closeAllConnections();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

function readPackedManifest(tarballPath) {
  const result = spawnSync("tar", ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Could not read packed manifest from ${tarballPath}: ${result.stderr ?? result.error?.message}`);
  }
  return JSON.parse(result.stdout);
}

async function startOpenAiCompatibleProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      requests.push({ url: request.url, method: request.method, body });
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed.model !== "echo" || parsed.stream !== true) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected request" } }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      const id = "chatcmpl-mono-agent-next-e2e";
      const created = Math.floor(Date.now() / 1_000);
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }));
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: { content: EXPECTED_REPLY }, finish_reason: null }],
      }));
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      }));
      response.end("data: [DONE]\n\n");
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider fixture failed" } }));
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider fixture did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function startCli(cli, configPath, cwd, environment) {
  const child = spawn(cli, ["start", "--config", configPath], {
    cwd,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let resolveExit;
  const exited = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const started = withTimeout(new Promise((resolvePromise, rejectPromise) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const event = JSON.parse(line);
          if (!settled && event.event === "started") {
            settled = true;
            resolvePromise(event);
          }
        } catch {
          // A partial line or a non-JSON diagnostic is retained for the exit error.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal, stdout, stderr });
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`CLI exited before start (${String(code)}/${String(signal)}): ${stderr || stdout}`));
      }
    });
  }), START_TIMEOUT_MS, "CLI startup");
  return { child, started, exited, output: () => ({ stdout, stderr }) };
}

function run(command, args, cwd, environment = process.env) {
  console.log(`$ ${basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${basename(command)} ${args.join(" ")} failed (${String(result.status)}): ${result.error?.message ?? detail}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runAsync(command, args, cwd, environment = process.env) {
  console.log(`$ ${basename(command)} ${args.join(" ")}`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      encoding: "utf8",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;
    let finalTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
      finalTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectPromise(new Error(
            `${basename(command)} ${args.join(" ")} exceeded ${String(COMMAND_TIMEOUT_MS)}ms and did not exit`,
          ));
        }
      }, SHUTDOWN_TIMEOUT_MS * 2);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      if (timedOut) {
        rejectPromise(new Error(`${basename(command)} ${args.join(" ")} exceeded ${String(COMMAND_TIMEOUT_MS)}ms`));
        return;
      }
      if (code === 0 && signal === null) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(
        `${basename(command)} ${args.join(" ")} failed (${String(code)}/${String(signal)}): ${stderr || stdout}`,
      ));
    });
  });
}

async function terminateRunningCli(runningCli) {
  runningCli.child.kill("SIGTERM");
  const exitedAfterTerm = await Promise.race([
    runningCli.exited.then(() => true, () => true),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (exitedAfterTerm) return;
  runningCli.child.kill("SIGKILL");
  await Promise.race([
    runningCli.exited.catch(() => undefined),
    delay(SHUTDOWN_TIMEOUT_MS),
  ]);
}

function assertJsonOk(output, command) {
  const parsed = JSON.parse(output);
  if (parsed.ok !== true) throw new Error(`${command} did not report success: ${output}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findFiles(root, predicate) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(entry.name)) found.push(path);
    }
  }
  return found.sort();
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(milliseconds)}ms`)), milliseconds);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
