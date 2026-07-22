import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("cross-spawn", () => ({ default: mocks.launch }));
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient: mocks.createClient }));

import {
  createIsolatedOpencode,
  disposeIsolatedOpenCodeState,
  verifyOpenCodeVersion,
} from "../../ai/providers/opencode-server.js";

let userDataHome;
let priorXdgDataHome;
let priorAuthContent;
let priorPermission;
let priorApiKey;
let priorWorkspace;
let priorPluginMeta;
let priorAwsSecret;

beforeEach(async () => {
  mocks.launch.mockReset();
  mocks.createClient.mockReset().mockReturnValue({ kind: "client" });
  await disposeIsolatedOpenCodeState();
  userDataHome = await mkdtemp(join(tmpdir(), "mono-agent-opencode-user-"));
  await mkdir(join(userDataHome, "opencode"), { mode: 0o700 });
  await writeFile(join(userDataHome, "opencode", "auth.json"), '{"github-copilot":{"type":"oauth","refresh":"secret"}}', { mode: 0o600 });
  await writeFile(join(userDataHome, "opencode", "opencode.db"), "", { mode: 0o600 });
  await chmod(join(userDataHome, "opencode", "auth.json"), 0o600);
  await chmod(join(userDataHome, "opencode", "opencode.db"), 0o600);
  priorXdgDataHome = process.env.XDG_DATA_HOME;
  priorAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  priorPermission = process.env.OPENCODE_PERMISSION;
  priorApiKey = process.env.OPENCODE_API_KEY;
  priorWorkspace = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES;
  priorPluginMeta = process.env.OPENCODE_PLUGIN_META_FILE;
  priorAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.XDG_DATA_HOME = userDataHome;
  delete process.env.OPENCODE_AUTH_CONTENT;
  process.env.OPENCODE_PERMISSION = '{"*":"allow"}';
  process.env.OPENCODE_API_KEY = "test-opencode-key";
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = "true";
  process.env.OPENCODE_PLUGIN_META_FILE = "/tmp/untrusted-plugin.json";
  process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-provider-shell";
  mocks.launch.mockReturnValue(fakeVersionChild("1.15.13"));
  await verifyOpenCodeVersion();
  mocks.launch.mockReset();
});

afterEach(async () => {
  await disposeIsolatedOpenCodeState();
  await rm(userDataHome, { recursive: true, force: true });
  restoreEnv("XDG_DATA_HOME", priorXdgDataHome);
  restoreEnv("OPENCODE_AUTH_CONTENT", priorAuthContent);
  restoreEnv("OPENCODE_PERMISSION", priorPermission);
  restoreEnv("OPENCODE_API_KEY", priorApiKey);
  restoreEnv("OPENCODE_EXPERIMENTAL_WORKSPACES", priorWorkspace);
  restoreEnv("OPENCODE_PLUGIN_META_FILE", priorPluginMeta);
  restoreEnv("AWS_SECRET_ACCESS_KEY", priorAwsSecret);
});

describe("isolated OpenCode server", () => {
  it("uses an authenticated pure server with private 0700/0600 state and durable user auth", async () => {
    const child = fakeChild();
    mocks.launch.mockReturnValue(child);
    const started = createIsolatedOpencode({
      hostname: "127.0.0.1",
      port: 0,
      config: { permission: { "*": "ask" }, share: "auto" },
    });
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    child.stdout.write("opencode server listening on http://127.0.0.1:43123\n");

    const result = await started;
    const [executable, args, spawnOptions] = mocks.launch.mock.calls[0];
    const env = spawnOptions.env;
    expect(executable).toBe("opencode");
    expect(args).toEqual(["serve", "--pure", "--hostname=127.0.0.1", "--port=0"]);
    expect(env.XDG_DATA_HOME).toBe(userDataHome);
    expect(env.OPENCODE_DB).not.toBe(join(userDataHome, "opencode", "opencode.db"));
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(env.OPENCODE_PERMISSION).toBeUndefined();
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
    expect(env.OPENCODE_DISABLE_SHARE).toBe("true");
    expect(env.OPENCODE_AUTO_SHARE).toBe("false");
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("true");
    expect(env.OPENCODE_EXPERIMENTAL_WORKSPACES).toBe("false");
    expect(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("false");
    expect(env.OPENCODE_EXPERIMENTAL_PARALLEL).toBe("false");
    expect(env.OPENCODE_ENABLE_PARALLEL).toBe("false");
    expect(env.OPENCODE_ENABLE_QUESTION_TOOL).toBe("false");
    expect(env.OPENCODE_PLUGIN_META_FILE).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      permission: { "*": "ask" },
      share: "disabled",
      autoshare: false,
    });

    const privateRoot = dirname(env.OPENCODE_DB);
    expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(env.OPENCODE_DB)).mode & 0o777).toBe(0o600);
    const durableAuth = join(env.XDG_DATA_HOME, "opencode", "auth.json");
    expect((await stat(durableAuth)).mode & 0o777).toBe(0o600);
    expect(await readFile(durableAuth, "utf8")).toContain('"refresh":"secret"');
    expect(env.XDG_CONFIG_HOME).toContain(privateRoot);
    expect(env.OPENCODE_TEST_HOME).toContain(privateRoot);
    if (process.platform !== "win32") {
      expect((await stat(join(env.XDG_CONFIG_HOME, "opencode"))).mode & 0o777).toBe(0o500);
    }

    const password = env.OPENCODE_SERVER_PASSWORD;
    expect(password).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(args.join(" ")).not.toContain(password);
    const clientOptions = mocks.createClient.mock.calls[0][0];
    expect(clientOptions.baseUrl).toBe("http://127.0.0.1:43123");
    const decoded = Buffer.from(clientOptions.headers.Authorization.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe(`${env.OPENCODE_SERVER_USERNAME}:${password}`);

    await result.server.close();
    await result.server.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a distinct private database for every run and deletes each after close", async () => {
    const first = fakeChild();
    const second = fakeChild();
    mocks.launch.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const firstStart = createIsolatedOpencode();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    first.stdout.write("opencode server listening on http://127.0.0.1:41001\n");
    const firstServer = await firstStart;
    await firstServer.server.close();

    const secondStart = createIsolatedOpencode();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2));
    second.stdout.write("opencode server listening on http://127.0.0.1:41002\n");
    const secondServer = await secondStart;

    const firstEnv = mocks.launch.mock.calls[0][2].env;
    const secondEnv = mocks.launch.mock.calls[1][2].env;
    expect(secondEnv.OPENCODE_DB).not.toBe(firstEnv.OPENCODE_DB);
    expect(secondEnv.OPENCODE_DB).not.toContain(userDataHome);
    await expect(stat(dirname(firstEnv.OPENCODE_DB))).rejects.toMatchObject({ code: "ENOENT" });
    await secondServer.server.close();
    await expect(stat(dirname(secondEnv.OPENCODE_DB))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains private state until a SIGKILLed server confirms exit", async () => {
    const child = fakeChild();
    child.kill = vi.fn(() => true);
    mocks.launch.mockReturnValue(child);
    const started = createIsolatedOpencode();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    child.stdout.write("opencode server listening on http://127.0.0.1:41003\n");
    const result = await started;
    const privateRoot = dirname(mocks.launch.mock.calls[0][2].env.OPENCODE_DB);

    const closing = result.server.close();
    await vi.waitFor(
      () => expect(child.kill).toHaveBeenCalledWith("SIGKILL"),
      { timeout: 1_500, interval: 20 },
    );
    await expect(stat(privateRoot)).resolves.toBeDefined();

    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    await closing;
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills a timed-out child and never includes password, auth, or config output in the error", async () => {
    const child = fakeChild();
    mocks.launch.mockReturnValue(child);
    const started = createIsolatedOpencode({
      timeout: 5,
      config: { mcp: { secret: { headers: { Authorization: "Bearer CONFIG_SECRET" } } } },
    });
    const settled = started.then(
      () => undefined,
      (error) => error,
    );
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    const env = mocks.launch.mock.calls[0][2].env;
    child.stderr.write(`${env.OPENCODE_SERVER_PASSWORD} CONFIG_SECRET secret\n`);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Timeout waiting for OpenCode server");
    const message = error.message;
    expect(message).not.toContain(env.OPENCODE_SERVER_PASSWORD);
    expect(message).not.toContain("CONFIG_SECRET");
    expect(message).not.toContain("refresh");
    expect(child.kill).toHaveBeenCalled();
  });

  it("fails before spawn when OPENCODE_AUTH_CONTENT could expose inline credentials", async () => {
    process.env.OPENCODE_AUTH_CONTENT = '{"secret":"inline"}';

    await expect(createIsolatedOpencode()).rejects.toThrow("opencode auth login");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("requires a regular native migration marker before creating private run state", async () => {
    await rm(join(userDataHome, "opencode", "opencode.db"));

    await expect(createIsolatedOpencode()).rejects.toThrow("opencode db migrate --pure");
    expect(mocks.launch).not.toHaveBeenCalled();

    await writeFile(join(userDataHome, "opencode", "opencode.db"), "", { mode: 0o600 });
    const child = fakeChild();
    mocks.launch.mockReturnValue(child);
    const retry = createIsolatedOpencode();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    child.stdout.write("opencode server listening on http://127.0.0.1:42001\n");
    const server = await retry;
    await server.server.close();
  });

  it("rejects a non-loopback bind before spawning OpenCode", async () => {
    await expect(createIsolatedOpencode({ hostname: "0.0.0.0", port: 0 })).rejects.toThrow("127.0.0.1");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("rejects a startup URL outside the exact authenticated loopback origin", async () => {
    const child = fakeChild();
    mocks.launch.mockReturnValue(child);
    const started = createIsolatedOpencode();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    child.stdout.write("opencode server listening on http://0.0.0.0:42002\n");

    await expect(started).rejects.toThrow("invalid listening URL");
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
  });

  it.each(["1.14.9", "1.15.0-beta.1", "not-a-version"])(
    "rejects unsupported OpenCode version output %s before private state or server startup",
    async (version) => {
      await disposeIsolatedOpenCodeState();
      mocks.launch.mockReset().mockReturnValue(fakeVersionChild(version));

      await expect(createIsolatedOpencode()).rejects.toThrow("stable opencode CLI >=1.15.0");
      expect(mocks.launch).toHaveBeenCalledTimes(1);
      expect(mocks.launch).toHaveBeenCalledWith(
        "opencode",
        ["--version"],
        expect.objectContaining({ env: expect.any(Object) }),
      );
    },
  );

  it("retries a failed version preflight after OpenCode is installed or upgraded", async () => {
    await disposeIsolatedOpenCodeState();
    mocks.launch.mockReset()
      .mockImplementationOnce(() => fakeVersionChild("1.14.9"))
      .mockImplementationOnce(() => fakeVersionChild("1.15.13"));

    await expect(verifyOpenCodeVersion()).rejects.toThrow("stable opencode CLI >=1.15.0");
    await expect(verifyOpenCodeVersion()).resolves.toBeUndefined();
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child;
}

function fakeVersionChild(version) {
  const child = fakeChild();
  queueMicrotask(() => {
    child.stdout.write(`${version}\n`);
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });
  return child;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
