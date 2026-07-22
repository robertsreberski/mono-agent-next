import launch from "cross-spawn";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const VERSION_CHECK_TIMEOUT_MS = 3_000;
const MAX_START_OUTPUT_CHARS = 16_384;
const MAX_VERSION_OUTPUT_CHARS = 128;
const PRIVATE_STATE_PREFIX = "mono-agent-opencode-";
const MINIMUM_OPENCODE_VERSION = [1, 15, 0];

let versionCheckPromise;
let exitCleanupRegistered = false;
const privateStateDirectories = new Set();

/**
 * Start one OpenCode server with mono-agent-owned process state.
 *
 * OpenCode stores sessions and project-wide permission approvals in SQLite. A
 * unique per-run DB prevents pre-existing user approvals and other conversations
 * from entering this tool environment. The normal OpenCode data home remains
 * mounted so auth refresh rotation persists; global/repo config, external
 * plugins, and external skills are disabled below. State is deleted after close.
 */
export async function createIsolatedOpencode(options = {}) {
  if (process.env.OPENCODE_AUTH_CONTENT !== undefined) {
    throw new Error(
      "Direct OpenCode cannot safely inherit OPENCODE_AUTH_CONTENT. Persist credentials with `opencode auth login`, unset OPENCODE_AUTH_CONTENT, and retry.",
    );
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (hostname !== "127.0.0.1" || port !== 0) {
    throw new Error("The direct OpenCode server must bind to 127.0.0.1 on an ephemeral port.");
  }
  const timeoutMs = positiveTimeout(options.timeout);
  await verifyOpenCodeVersion();
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  const state = await createPrivateOpenCodeState();
  const args = [
    "serve",
    "--pure",
    `--hostname=${hostname}`,
    `--port=${port}`,
  ];
  if (options.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`);

  const serverUsername = "mono-agent";
  const serverPassword = randomBytes(32).toString("base64url");
  const serverConfig = {
    ...(options.config ?? {}),
    share: "disabled",
    autoshare: false,
  };
  // Provider-owned Bash inherits the server environment. Start from a narrow,
  // non-secret process allowlist; provider credentials come only from auth.json.
  const childEnv = safeProcessEnv();
  Object.assign(childEnv, {
    HOME: state.privateHome,
    USERPROFILE: state.privateHome,
    OPENCODE_TEST_HOME: state.privateHome,
    XDG_CONFIG_HOME: state.configHome,
    XDG_CONFIG_DIRS: state.configHome,
    XDG_DATA_HOME: state.userDataHome,
    XDG_STATE_HOME: state.stateHome,
    OPENCODE_DB: state.databasePath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(serverConfig),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_EXPERIMENTAL: "false",
    OPENCODE_EXPERIMENTAL_WORKSPACES: "false",
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
    OPENCODE_EXPERIMENTAL_PARALLEL: "false",
    OPENCODE_EXPERIMENTAL_SCOUT: "false",
    OPENCODE_ENABLE_PARALLEL: "false",
    OPENCODE_ENABLE_QUESTION_TOOL: "false",
    OPENCODE_SERVER_USERNAME: serverUsername,
    OPENCODE_SERVER_PASSWORD: serverPassword,
  });
  let child;
  try {
    child = launch("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
  } catch (error) {
    await disposePrivateOpenCodeState(state);
    throw error;
  }

  let closed = false;
  let ready = false;
  let startOutput = "";
  let stdoutBuffer = "";
  let timer;
  let rejectStartup;
  let closePromise;
  let disposePromise;

  const stop = () => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", onAbort);
    child.stdout?.off?.("data", onStdout);
    child.stderr?.off?.("data", onStderr);
    child.off?.("error", onError);
    child.off?.("exit", onExit);
    closePromise = new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      let ultimateTimer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        if (ultimateTimer !== undefined) clearTimeout(ultimateTimer);
        child.off?.("exit", onStopped);
        child.off?.("error", onStopError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onStopped = () => finish();
      const onStopError = () => finish(new Error("OpenCode server process failed while stopping."));
      const forceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
          // Wait for the actual exit before deleting the DB. Retain one final
          // bound for pathological/mocked processes that never report exit.
          ultimateTimer = setTimeout(() => {
            finish(new Error("Timed out waiting for the OpenCode server to exit after SIGKILL."));
          }, DEFAULT_STOP_TIMEOUT_MS);
          ultimateTimer.unref?.();
        } catch {
          finish(new Error("Unable to terminate the OpenCode server process."));
        }
      }, DEFAULT_STOP_TIMEOUT_MS);
      forceTimer.unref?.();
      child.once?.("exit", onStopped);
      child.once?.("error", onStopError);
      try {
        child.kill();
      } catch {
        finish(new Error("Unable to terminate the OpenCode server process."));
      }
    });
    return closePromise;
  };

  const close = () => {
    if (disposePromise === undefined) {
      // Only delete run state after process exit is confirmed. If termination
      // cannot be confirmed, retain the directory in the exit-cleanup set.
      disposePromise = stop().then(() => disposePrivateOpenCodeState(state));
    }
    return disposePromise;
  };

  const failStartup = (error) => {
    if (ready || closed) return;
    // Captured output is intentionally not attached: the child can load provider
    // config/auth and startup errors must never echo either into host diagnostics.
    void close().then(
      () => rejectStartup(error),
      () => rejectStartup(error),
    );
  };

  const onAbort = () => {
    if (ready) {
      void close().catch(() => undefined);
      return;
    }
    failStartup(abortReason(options.signal));
  };
  const onError = (error) => failStartup(error instanceof Error ? error : new Error(String(error)));
  const onExit = (code, signal) => {
    if (ready || closed) return;
    failStartup(new Error(`OpenCode server exited before startup (code=${code ?? "none"}, signal=${signal ?? "none"}).`));
  };
  const onStderr = (chunk) => {
    startOutput = appendBounded(startOutput, chunk);
  };

  let resolveStartup;
  const started = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const onStdout = (chunk) => {
    const text = String(chunk);
    startOutput = appendBounded(startOutput, text);
    stdoutBuffer = appendBounded(stdoutBuffer, text);
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("opencode server listening")) continue;
      const match = line.match(/on\s+(https?:\/\/[^\s]+)/u);
      const safeUrl = match?.[1] === undefined ? undefined : safeLoopbackServerUrl(match[1]);
      if (safeUrl === undefined) {
        failStartup(new Error("OpenCode server reported an invalid listening URL."));
        return;
      }
      ready = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      child.off?.("error", onError);
      child.off?.("exit", onExit);
      child.stdout?.resume?.();
      child.stderr?.resume?.();
      resolveStartup(safeUrl);
      return;
    }
  };

  child.stdout?.on?.("data", onStdout);
  child.stderr?.on?.("data", onStderr);
  child.on?.("error", onError);
  child.on?.("exit", onExit);
  options.signal?.addEventListener?.("abort", onAbort, { once: true });
  timer = setTimeout(() => {
    failStartup(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms.`));
  }, timeoutMs);
  timer.unref?.();

  try {
    const url = await started;
    const authorization = Buffer.from(`${serverUsername}:${serverPassword}`, "utf8").toString("base64");
    return {
      client: createOpencodeClient({
        baseUrl: url,
        headers: { Authorization: `Basic ${authorization}` },
      }),
      server: { url, close },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

async function createPrivateOpenCodeState() {
  const userDataHome = await assertUserMigrationMarker();
  const directory = await mkdtemp(join(tmpdir(), PRIVATE_STATE_PREFIX));
  try {
    await chmod(directory, 0o700);
    const privateHome = await privateDirectory(directory, "home");
    const configHome = await privateDirectory(directory, "config");
    const opencodeConfig = await privateDirectory(configHome, "opencode");
    if (process.platform !== "win32") await chmod(opencodeConfig, 0o500);
    const stateHome = await privateDirectory(directory, "state");
    const databasePath = join(directory, "opencode.db");
    await createPrivateFile(databasePath);
    privateStateDirectories.add(directory);
    registerExitCleanup();
    return {
      directory,
      privateHome,
      configHome,
      stateHome,
      userDataHome,
      databasePath,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function disposePrivateOpenCodeState(state) {
  await rm(state.directory, { recursive: true, force: true });
  privateStateDirectories.delete(state.directory);
}

async function privateDirectory(parent, name) {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function createPrivateFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    if (content !== undefined) await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function assertUserMigrationMarker() {
  const userDataHome = process.env.XDG_DATA_HOME
    || join(homedir(), ".local", "share");
  const marker = join(userDataHome, "opencode", "opencode.db");
  let info;
  try {
    info = await lstat(marker);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
      throw new Error("Unable to verify the OpenCode database migration marker.", { cause: error });
    }
    throw migrationRequiredError();
  }
  const ownedByCurrentUser = typeof process.getuid !== "function"
    || info.uid === process.getuid();
  if (!info.isFile() || !ownedByCurrentUser) {
    throw migrationRequiredError();
  }
  return userDataHome;
}

function migrationRequiredError() {
  return new Error(
    "Direct OpenCode requires a migrated user database before it can isolate run state. Run `opencode db migrate --pure` once, then retry.",
  );
}

function registerExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const directory of privateStateDirectories) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
}

/** Internal test cleanup for any server state left by an interrupted test/process. */
export async function disposeIsolatedOpenCodeState() {
  versionCheckPromise = undefined;
  const directories = [...privateStateDirectories];
  privateStateDirectories.clear();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

/** Cached security preflight for the CLI features/event contract this bridge requires. */
export function verifyOpenCodeVersion() {
  if (versionCheckPromise === undefined) {
    const pending = runOpenCodeVersionCheck();
    versionCheckPromise = pending;
    void pending.catch(() => {
      // A user may install/upgrade OpenCode while this host process remains
      // alive. Cache successes, but let a later run retry a failed preflight.
      if (versionCheckPromise === pending) versionCheckPromise = undefined;
    });
  }
  return versionCheckPromise;
}

function runOpenCodeVersionCheck() {
  const env = safeProcessEnv();
  const child = launch("opencode", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let output = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off?.("data", onStdout);
      child.off?.("error", onError);
      child.off?.("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onStdout = (chunk) => {
      output = appendVersionOutput(output, chunk);
    };
    const onError = () => finish(versionUnavailableError());
    const onExit = (code) => {
      if (code !== 0) {
        finish(versionUnavailableError());
        return;
      }
      const version = parseStableVersion(output.trim());
      if (version === undefined) {
        finish(versionUnavailableError());
        return;
      }
      if (compareVersion(version, MINIMUM_OPENCODE_VERSION) < 0) {
        finish(new Error(
          `Direct OpenCode requires stable opencode CLI >=1.15.0; found ${version.join(".")}. Upgrade OpenCode and retry.`,
        ));
        return;
      }
      finish();
    };
    child.stdout?.on?.("data", onStdout);
    child.stderr?.resume?.();
    child.on?.("error", onError);
    child.on?.("exit", onExit);
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      finish(versionUnavailableError());
    }, VERSION_CHECK_TIMEOUT_MS);
    timer.unref?.();
  });
}

function parseStableVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return undefined;
  const version = match.slice(1, 4).map(Number);
  return version.every((part) => Number.isSafeInteger(part)) ? version : undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function versionUnavailableError() {
  return new Error(
    "Direct OpenCode requires stable opencode CLI >=1.15.0, but its installed version could not be verified. Install or upgrade OpenCode and retry.",
  );
}

function appendVersionOutput(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_VERSION_OUTPUT_CHARS
    ? next
    : next.slice(0, MAX_VERSION_OUTPUT_CHARS);
}

function safeProcessEnv() {
  const env = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

function positiveTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_START_TIMEOUT_MS;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("OpenCode server startup aborted."), { name: "AbortError" });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_START_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_START_OUTPUT_CHARS);
}

function safeLoopbackServerUrl(value) {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (parsed.protocol !== "http:"
      || parsed.hostname !== "127.0.0.1"
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}
