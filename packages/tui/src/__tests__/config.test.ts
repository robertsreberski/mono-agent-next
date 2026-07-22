import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigView } from "../ui/views/config.js";
import { stripAnsi } from "./test-terminal.js";

type ConfigModule = typeof import("@mono-agent/config");

const configMocks = vi.hoisted(() => ({
  read: vi.fn<ConfigModule["readMonoAgentConfigJson"]>(),
  load: vi.fn<ConfigModule["loadMonoAgentConfigWithSources"]>(),
  actualRead: undefined as ConfigModule["readMonoAgentConfigJson"] | undefined,
  actualLoad: undefined as ConfigModule["loadMonoAgentConfigWithSources"] | undefined,
}));

vi.mock("@mono-agent/config", async (importOriginal) => {
  const actual = await importOriginal<ConfigModule>();
  configMocks.actualRead = actual.readMonoAgentConfigJson;
  configMocks.actualLoad = actual.loadMonoAgentConfigWithSources;
  return {
    ...actual,
    readMonoAgentConfigJson: configMocks.read,
    loadMonoAgentConfigWithSources: configMocks.load,
  };
});

const SECRET = "aud-062-config-view-secret";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-config-view-"));
  configMocks.read.mockReset().mockImplementation((...args) => configMocks.actualRead!(...args));
  configMocks.load.mockReset().mockImplementation((...args) => configMocks.actualLoad!(...args));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
    MONO_AGENT_IDENTITY_PATH: join(dir, "IDENTITY.md"),
    MONO_AGENT_MEMORY_MODE: "journal",
    MONO_AGENT_MEMORY_PATH: join(dir, "memory"),
    MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
    MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
    MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: SECRET,
    ...overrides,
  };
}

function setup(env = environment()): { view: ConfigView; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const tui = { requestRender } as unknown as TUI;
  return { view: new ConfigView({ tui, env }), requestRender };
}

function renderText(view: ConfigView): string {
  return stripAnsi(view.render(180).join("\n"));
}

async function waitForText(view: ConfigView, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(renderText(view)).toContain(text);
  });
}

async function writeConfig(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ConfigView", () => {
  it("renders the no-config state and requests a redraw when a selection has no path", async () => {
    const { view, requestRender } = setup();

    expect(renderText(view)).toContain("No config path available for the selected agent.");
    view.setConfigPath(undefined);

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));
    expect(renderText(view)).toContain("No config path available for the selected agent.");
  });

  it("loads the selected file and renders honest env/json/default provenance without exposing secrets", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, {
      agent: { name: "Audit fixture" },
      runtime: { maxTurns: 7 },
    });
    const { view, requestRender } = setup(environment({ MONO_AGENT_MAX_TURNS: "9" }));

    view.setConfigPath(configPath, dir);
    await waitForText(view, "Display name Audit fixture [json]");

    const rendered = renderText(view);
    expect(rendered).toContain(configPath);
    expect(rendered).toContain("read-only · r reload · env overrides shown are from this shell, not the agent process");
    expect(rendered).toContain("Model pi:ollama:qwen3:8b [env]");
    expect(rendered).toContain("Max turns 9 [env]");
    expect(rendered).toContain("Effort — [default]");
    expect(rendered).toContain("Embeddings API key (redacted) [env]");
    expect(rendered).not.toContain(SECRET);
    expect(requestRender).toHaveBeenCalled();
  });

  it.each(["r", "R"])("reloads the current file for the %s key and ignores unrelated input", async (reloadKey) => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, { agent: { name: "Before reload" } });
    const { view, requestRender } = setup();

    view.setConfigPath(configPath, dir);
    await waitForText(view, "Before reload");
    const rendersBeforeIgnoredKey = requestRender.mock.calls.length;

    view.handleInput("x");
    expect(requestRender).toHaveBeenCalledTimes(rendersBeforeIgnoredKey);

    await writeConfig(configPath, { agent: { name: `After ${reloadKey} reload` } });
    view.handleInput(reloadKey);
    await waitForText(view, `After ${reloadKey} reload`);

    expect(renderText(view)).not.toContain("Before reload");
    expect(requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeIgnoredKey);
  });

  it("does not paint a stale successful load after switching instances", async () => {
    const firstPath = join(dir, "first.config.json");
    const secondPath = join(dir, "second.config.json");
    await writeConfig(firstPath, { agent: { name: "Superseded first agent" } });
    await writeConfig(secondPath, { agent: { name: "Selected second agent" } });
    const firstConfig = await configMocks.actualLoad!({ env: environment(), cwd: dir, jsonPath: firstPath });
    const firstLoad = deferred<typeof firstConfig>();
    configMocks.load.mockImplementation((options) =>
      options.jsonPath === firstPath ? firstLoad.promise : configMocks.actualLoad!(options),
    );
    const { view, requestRender } = setup();

    view.setConfigPath(firstPath, dir);
    await vi.waitFor(() =>
      expect(configMocks.load).toHaveBeenCalledWith(expect.objectContaining({ jsonPath: firstPath })),
    );
    view.setConfigPath(secondPath, dir);
    await waitForText(view, "Selected second agent");
    const rendersAfterSecondAgent = requestRender.mock.calls.length;

    firstLoad.resolve(firstConfig);
    await flushAsyncWork();

    const rendered = renderText(view);
    expect(rendered).toContain(secondPath);
    expect(rendered).toContain("Selected second agent");
    expect(rendered).not.toContain(firstPath);
    expect(rendered).not.toContain("Superseded first agent");
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterSecondAgent);
  });

  it("does not paint a stale load error after switching instances", async () => {
    const firstPath = join(dir, "first.config.json");
    const secondPath = join(dir, "second.config.json");
    await writeConfig(firstPath, { agent: { name: "Superseded first agent" } });
    await writeConfig(secondPath, { agent: { name: "Selected second agent" } });
    const firstRead = deferred<Awaited<ReturnType<ConfigModule["readMonoAgentConfigJson"]>>>();
    configMocks.read.mockImplementation((path) =>
      path === firstPath ? firstRead.promise : configMocks.actualRead!(path),
    );
    const { view, requestRender } = setup();

    view.setConfigPath(firstPath, dir);
    await vi.waitFor(() => expect(configMocks.read).toHaveBeenCalledWith(firstPath));
    view.setConfigPath(secondPath, dir);
    await waitForText(view, "Selected second agent");
    const rendersAfterSecondAgent = requestRender.mock.calls.length;

    firstRead.reject(new Error("stale first-agent failure"));
    await flushAsyncWork();

    const rendered = renderText(view);
    expect(rendered).toContain(secondPath);
    expect(rendered).toContain("Selected second agent");
    expect(rendered).not.toContain("stale first-agent failure");
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterSecondAgent);
  });

  it("does not paint an older successful reload for the same config path", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, { agent: { name: "Older same-path load" } });
    const olderConfig = await configMocks.actualLoad!({
      env: environment(),
      cwd: dir,
      jsonPath: configPath,
    });
    const olderLoad = deferred<typeof olderConfig>();
    let loadCalls = 0;
    configMocks.load.mockImplementation((options) => {
      loadCalls += 1;
      return loadCalls === 1 ? olderLoad.promise : configMocks.actualLoad!(options);
    });
    const { view, requestRender } = setup();

    view.setConfigPath(configPath, dir);
    await vi.waitFor(() => expect(configMocks.load).toHaveBeenCalledTimes(1));
    await writeConfig(configPath, { agent: { name: "Newest same-path load" } });
    view.handleInput("r");
    await waitForText(view, "Newest same-path load");
    const rendersAfterNewestLoad = requestRender.mock.calls.length;

    olderLoad.resolve(olderConfig);
    await flushAsyncWork();

    const rendered = renderText(view);
    expect(rendered).toContain("Newest same-path load");
    expect(rendered).not.toContain("Older same-path load");
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterNewestLoad);
  });

  it("does not paint an older failed reload for the same config path", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, { agent: { name: "Newest same-path result" } });
    const olderRead = deferred<Awaited<ReturnType<ConfigModule["readMonoAgentConfigJson"]>>>();
    let readCalls = 0;
    configMocks.read.mockImplementation((path) => {
      readCalls += 1;
      return readCalls === 1 ? olderRead.promise : configMocks.actualRead!(path);
    });
    const { view, requestRender } = setup();

    view.setConfigPath(configPath, dir);
    await vi.waitFor(() => expect(configMocks.read).toHaveBeenCalledTimes(1));
    view.handleInput("r");
    await waitForText(view, "Newest same-path result");
    const rendersAfterNewestLoad = requestRender.mock.calls.length;

    olderRead.reject(new Error("older same-path failure"));
    await flushAsyncWork();

    const rendered = renderText(view);
    expect(rendered).toContain("Newest same-path result");
    expect(rendered).not.toContain("older same-path failure");
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterNewestLoad);
  });

  it("uses the newest cwd when the same config path is selected again", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const firstCwd = join(dir, "first-agent");
    const secondCwd = join(dir, "second-agent");
    const env = environment({ MONO_AGENT_IDENTITY_PATH: "IDENTITY.md" });
    await writeConfig(configPath, { agent: { name: "Shared config path" } });
    const firstConfig = await configMocks.actualLoad!({ env, cwd: firstCwd, jsonPath: configPath });
    const firstLoad = deferred<typeof firstConfig>();
    let loadCalls = 0;
    configMocks.load.mockImplementation((options) => {
      loadCalls += 1;
      return loadCalls === 1 ? firstLoad.promise : configMocks.actualLoad!(options);
    });
    const { view, requestRender } = setup(env);

    view.setConfigPath(configPath, firstCwd);
    await vi.waitFor(() => expect(configMocks.load).toHaveBeenCalledTimes(1));
    view.setConfigPath(configPath, secondCwd);
    await waitForText(view, join(secondCwd, "IDENTITY.md"));
    const rendersAfterSecondCwd = requestRender.mock.calls.length;

    firstLoad.resolve(firstConfig);
    await flushAsyncWork();

    const rendered = renderText(view);
    expect(rendered).toContain(join(secondCwd, "IDENTITY.md"));
    expect(rendered).not.toContain(join(firstCwd, "IDENTITY.md"));
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterSecondCwd);
  });

  it("replaces prior content with a safe load failure for malformed JSON", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, { agent: { name: "Previously valid agent" } });
    const { view, requestRender } = setup();

    view.setConfigPath(configPath, dir);
    await waitForText(view, "Previously valid agent");
    await writeFile(configPath, "{ not-json", "utf8");
    view.handleInput("r");
    await waitForText(view, "Failed to load config. Check the selected config file and reload.");

    const rendered = renderText(view);
    expect(rendered).toContain("Failed to load config. Check the selected config file and reload.");
    expect(rendered).not.toContain("Previously valid agent");
    expect(rendered).not.toContain("read-only · r reload");
    expect(requestRender).toHaveBeenCalled();
  });

  it("does not expose upstream failure details that could contain config secrets", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeConfig(configPath, { agent: { name: "Previously valid agent" } });
    const { view } = setup();

    view.setConfigPath(configPath, dir);
    await waitForText(view, "Previously valid agent");
    configMocks.read.mockRejectedValueOnce(
      new Error(`Parser echoed malformed credential ${SECRET}`),
    );
    view.handleInput("r");
    await waitForText(view, "Failed to load config. Check the selected config file and reload.");

    const rendered = renderText(view);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain("Parser echoed malformed credential");
    expect(rendered).not.toContain("Previously valid agent");
  });
});
