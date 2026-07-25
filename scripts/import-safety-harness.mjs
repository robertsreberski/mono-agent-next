#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { createRequire, syncBuiltinESMExports } from "node:module";

const REPORT_PREFIX = "MONO_AGENT_IMPORT_SAFETY:";
const target = process.argv[2];
const format = process.argv[3];
const violations = [];
const require = createRequire(import.meta.url);

if (typeof target !== "string" || (format !== "module" && format !== "json")) {
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({ ok: false, harnessError: "invalid invocation" })}\n`);
  process.exitCode = 2;
} else {
  installImportBoundary();
  let importError;
  try {
    if (format === "json") await import(target, { with: { type: "json" } });
    else await import(target);
  } catch (error) {
    importError = boundedReason(error);
  }
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(
    violations.length > 0
      ? { ok: false, violation: violations[0] }
      : importError === undefined
        ? { ok: true }
        : { ok: false, importError },
  )}\n`);
}

function installImportBoundary() {
  const fs = require("node:fs");
  const childProcess = require("node:child_process");
  const dns = require("node:dns");
  const dnsPromises = dns.promises;
  const timers = require("node:timers");
  const timersPromises = require("node:timers/promises");
  const workerThreads = require("node:worker_threads");
  const networkModules = [
    [require("node:net"), ["connect", "createConnection"], "network access"],
    [require("node:tls"), ["connect"], "network access"],
    [require("node:http"), ["ClientRequest", "get", "request"], "network access"],
    [require("node:https"), ["get", "request"], "network access"],
    [require("node:http2"), ["connect"], "network access"],
    [require("node:dgram"), ["createSocket"], "network access"],
  ];
  replaceMethods(childProcess, [
    "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
  ], "process spawn");
  replaceMethods(childProcess.ChildProcess?.prototype, ["spawn"], "process spawn");
  for (const [module, names, label] of networkModules) replaceMethods(module, names, label);
  replaceMethods(require("node:net").Socket.prototype, ["connect"], "network access");
  replaceMethods(require("node:net").Server.prototype, ["listen"], "network access");
  replaceMethods(require("node:tls").TLSSocket.prototype, ["connect"], "network access");
  replaceMethods(require("node:dgram").Socket.prototype, ["bind", "connect", "send"], "network access");
  replaceMatchingMethods(dns, isDnsResolutionMethod, "network access");
  replaceMatchingMethods(dns.Resolver?.prototype, isDnsResolutionMethod, "network access");
  replaceMatchingMethods(dnsPromises, isDnsResolutionMethod, "network access");
  replaceMatchingMethods(
    dnsPromises.Resolver?.prototype,
    isDnsResolutionMethod,
    "network access",
  );
  replaceConstructor(workerThreads, "BroadcastChannel", "async scheduling");
  replaceConstructor(workerThreads, "MessageChannel", "async scheduling");
  replaceConstructor(workerThreads, "Worker", "worker creation");
  replaceMethods(
    timers,
    ["setImmediate", "setInterval", "setTimeout"],
    "async scheduling",
  );
  replaceMethods(
    timersPromises,
    ["setImmediate", "setInterval", "setTimeout"],
    "async scheduling",
  );
  replaceMethods(
    timersPromises.scheduler,
    ["wait", "yield"],
    "async scheduling",
  );

  replaceMethodsFromImportedCode(fs, [
    "createReadStream", "openAsBlob", "read", "readFile", "readFileSync",
    "readSync", "readv", "readvSync",
  ], "filesystem read");
  replaceMethods(fs, [
    "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
    "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "WriteStream", "fchmod",
    "fchmodSync", "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "ftruncate",
    "ftruncateSync", "futimes", "futimesSync", "lchmod", "lchmodSync", "lchown",
    "lchownSync", "link", "linkSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
    "mkdtemp", "mkdtempDisposableSync", "mkdtempSync", "rename", "renameSync", "rm",
    "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate",
    "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write",
    "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
  ], "filesystem write");
  guardOpen(fs, "open");
  guardOpen(fs, "openSync");
  replaceMethodsFromImportedCode(fs.promises, ["readFile"], "filesystem read");
  replaceMethods(fs.promises, [
    "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link",
    "lutimes", "mkdir", "mkdtemp", "mkdtempDisposable", "rename", "rm", "rmdir",
    "symlink", "truncate", "unlink", "utimes", "writeFile",
  ], "filesystem write");
  guardOpen(fs.promises, "open");

  const sqlite = optionalBuiltin("node:sqlite");
  replaceConstructor(sqlite, "DatabaseSync", "SQLite database creation");
  const wasi = optionalBuiltin("node:wasi");
  replaceConstructor(wasi, "WASI", "WASI execution");

  replaceGlobal("fetch", "network access");
  replaceGlobalConstructor("WebSocket", "network access");
  replaceGlobalConstructor("EventSource", "network access");
  replaceGlobalConstructor("BroadcastChannel", "async scheduling");
  replaceGlobalConstructor("MessageChannel", "async scheduling");
  replaceGlobal("queueMicrotask", "async scheduling");
  replaceGlobal("setImmediate", "async scheduling");
  replaceGlobal("setInterval", "async scheduling");
  replaceGlobal("setTimeout", "async scheduling");
  replaceMethods(globalThis.AbortSignal, ["timeout"], "async scheduling");
  syncBuiltinESMExports();

  const originalEnvironment = process.env;
  Object.defineProperty(process, "env", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: new Proxy(originalEnvironment, {
      deleteProperty(environment, key) {
        if (calledFromImportedCode()) return violate("environment mutation");
        return Reflect.deleteProperty(environment, key);
      },
      get(environment, key) {
        if (calledFromImportedCode()) return violate("environment read");
        return Reflect.get(environment, key, environment);
      },
      getOwnPropertyDescriptor(environment, key) {
        if (calledFromImportedCode()) return violate("environment read");
        return Reflect.getOwnPropertyDescriptor(environment, key);
      },
      has(environment, key) {
        if (calledFromImportedCode()) return violate("environment read");
        return Reflect.has(environment, key);
      },
      ownKeys(environment) {
        if (calledFromImportedCode()) return violate("environment read");
        return Reflect.ownKeys(environment);
      },
      set(environment, key, value) {
        if (calledFromImportedCode()) return violate("environment mutation");
        return Reflect.set(environment, key, value, environment);
      },
    }),
  });
}

function calledFromImportedCode() {
  const stack = new Error().stack ?? "";
  return stack.split("\n").some((line) => !line.includes("import-safety-harness.mjs")
    && (
      line.includes("data:")
      || line.includes("file:")
      || line.includes(" (/")
      || /^\s*at \//u.test(line)
    ));
}

function replaceMethods(targetObject, names, label) {
  for (const name of names) {
    if (typeof targetObject?.[name] !== "function") continue;
    targetObject[name] = function importBoundaryBlocked() {
      return violate(label);
    };
  }
}

function replaceMethodsFromImportedCode(targetObject, names, label) {
  for (const name of names) {
    if (typeof targetObject?.[name] !== "function") continue;
    const original = targetObject[name];
    targetObject[name] = function importBoundaryRead(...args) {
      if (calledFromImportedCode()) return violate(label);
      return Reflect.apply(original, this, args);
    };
  }
}

function replaceMatchingMethods(targetObject, predicate, label) {
  for (const name of Object.getOwnPropertyNames(targetObject ?? {})) {
    if (predicate(name)) replaceMethods(targetObject, [name], label);
  }
}

function replaceConstructor(targetObject, name, label) {
  if (typeof targetObject?.[name] !== "function") return;
  targetObject[name] = function ImportBoundaryBlockedConstructor() {
    return violate(label);
  };
}

function isDnsResolutionMethod(name) {
  return name === "lookup"
    || name === "lookupService"
    || name === "reverse"
    || name === "resolve"
    || /^resolve[A-Z0-9]/u.test(name);
}

function optionalBuiltin(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ERR_UNKNOWN_BUILTIN_MODULE"
    ) {
      return undefined;
    }
    throw error;
  }
}

function guardOpen(targetObject, name) {
  if (typeof targetObject?.[name] !== "function") return;
  const original = targetObject[name];
  targetObject[name] = function importBoundaryOpen(path, flags, ...rest) {
    if (!calledFromImportedCode()) {
      return Reflect.apply(original, this, [path, flags, ...rest]);
    }
    if (isWriteFlag(flags)) return violate("filesystem write");
    return violate("filesystem read");
  };
}

function isWriteFlag(flags) {
  if (typeof flags === "string") return /[+awx]/u.test(flags);
  if (typeof flags !== "number") return true;
  const constants = require("node:fs").constants;
  return (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_APPEND
    | constants.O_CREAT | constants.O_TRUNC)) !== 0;
}

function replaceGlobal(name, label) {
  if (typeof globalThis[name] !== "function") return;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value() { return violate(label); },
  });
}

function replaceGlobalConstructor(name, label) {
  if (typeof globalThis[name] !== "function") return;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: class ImportBoundaryBlocked {
      constructor() { violate(label); }
    },
  });
}

function violate(label) {
  violations.push(label);
  process.exitCode = 1;
  throw new Error(`Import-time ${label} is forbidden`);
}

function boundedReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, " ").slice(0, 500);
}
