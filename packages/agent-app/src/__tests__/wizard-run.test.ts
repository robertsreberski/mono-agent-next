import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { CANCEL, ESCAPE, promptMock } = vi.hoisted(() => ({
  CANCEL: Symbol("clack:cancel:test"),
  ESCAPE: Symbol("clack:escape:test"),
  promptMock: {
    selectAnswers: [] as unknown[],
    autocompleteAnswers: [] as unknown[],
    confirmAnswers: [] as unknown[],
    multiselectAnswers: [] as unknown[],
    textAnswers: [] as unknown[],
    passwordAnswers: [] as unknown[],
    selectCalls: [] as Array<Record<string, unknown>>,
    autocompleteCalls: [] as Array<Record<string, unknown>>,
    confirmCalls: [] as Array<Record<string, unknown>>,
    textCalls: [] as Array<Record<string, unknown>>,
    passwordCalls: [] as Array<Record<string, unknown>>,
    notes: [] as Array<{ message: string; title?: string }>,
  },
}));

const discoveryMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  discover: vi.fn(async (opts: Record<string, unknown> = {}) => {
    discoveryMock.calls.push(opts);
    return {
      candidates: [
        {
          value: "codex:gpt-5.6-terra",
          label: "Codex GPT-5.6 Terra",
          source: "codex" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "credential_detected" as const,
          supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"] as const,
          defaultEffort: "low" as const,
        },
        {
          value: "codex:gpt-5.6-sol",
          label: "Codex GPT-5.6 Sol",
          source: "codex" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "credential_detected" as const,
          supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"] as const,
          defaultEffort: "low" as const,
          providerDefault: true,
        },
        {
          value: "pi:ollama:qwen3:8b",
          label: "Ollama qwen3:8b",
          source: "ollama" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "not_required" as const,
          supportedEfforts: ["none", "low", "medium", "high"] as const,
          defaultEffort: "medium" as const,
        },
        {
          value: "pi:opencode-go:kimi-k2.6",
          label: "OpenCode Go Kimi K2.6",
          source: "pi" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "auth_required" as const,
          supportedEfforts: ["low", "medium", "high"] as const,
          defaultEffort: "medium" as const,
        },
        {
          value: "claude:claude-sonnet-5",
          label: "Claude Sonnet 5",
          source: "claude" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "auth_required" as const,
          supportedEfforts: ["low", "medium", "high", "max"] as const,
          defaultEffort: "high" as const,
        },
      ],
      statuses: [
        { provider: "Codex" as const, status: "detected" as const, detail: "sign-in detected; readiness not yet verified" },
      ],
    };
  }),
}));

const memoryEmbeddingMock = vi.hoisted(() => ({
  discover: vi.fn(async (options: { provider: "ollama" | "lmstudio" }) =>
    options.provider === "ollama"
      ? ["nomic-embed-text:v1.5"]
      : ["text-embedding-nomic-embed-text-v1.5"]
  ),
  probe: vi.fn(async () => ({ dimension: 768 })),
}));

function nextAnswer(queue: unknown[], name: string): unknown {
  if (queue.length === 0) throw new Error(`No queued ${name} answer.`);
  return queue.shift();
}

function nextPromptAnswer(queue: unknown[], name: string): unknown {
  const answer = nextAnswer(queue, name);
  if (answer === ESCAPE) {
    process.stdin.emit("keypress", "", { name: "escape" });
    return CANCEL;
  }
  return answer;
}

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown): value is symbol => value === CANCEL,
  intro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn((message: string, title?: string) => {
    promptMock.notes.push({ message, ...(title === undefined ? {} : { title }) });
  }),
  select: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.selectCalls.push(options);
    return nextPromptAnswer(promptMock.selectAnswers, "select");
  }),
  autocomplete: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.autocompleteCalls.push(options);
    return nextPromptAnswer(promptMock.autocompleteAnswers, "autocomplete");
  }),
  confirm: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.confirmCalls.push(options);
    return nextPromptAnswer(promptMock.confirmAnswers, "confirm");
  }),
  multiselect: vi.fn(async () => nextPromptAnswer(promptMock.multiselectAnswers, "multiselect")),
  text: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.textCalls.push(options);
    // Role prompt: existing flow tests press Enter on the
    // supplied default so their unrelated module-input queues stay stable.
    if (options.message === "What Role should be saved to IDENTITY.md → ## Role?") {
      return options.initialValue;
    }
    return nextPromptAnswer(promptMock.textAnswers, "text");
  }),
  password: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.passwordCalls.push(options);
    return nextPromptAnswer(promptMock.passwordAnswers, "password");
  }),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../wizard/model-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/model-discovery.js")>();
  return { ...actual, discoverWizardModelCandidates: discoveryMock.discover };
});

vi.mock("../memory-embedding-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory-embedding-service.js")>();
  return {
    ...actual,
    discoverMemoryEmbeddingModels: memoryEmbeddingMock.discover,
    probeMemoryEmbeddingSelection: memoryEmbeddingMock.probe,
  };
});

import { defaultAnswers } from "../wizard/answers.js";
import {
  guidedModelRefProblem,
  runInitWizard,
  runSetupRepairWizard,
} from "../wizard/run.js";

beforeEach(() => {
  for (const queue of [
    promptMock.selectAnswers,
    promptMock.autocompleteAnswers,
    promptMock.confirmAnswers,
    promptMock.multiselectAnswers,
    promptMock.textAnswers,
    promptMock.passwordAnswers,
    promptMock.selectCalls,
    promptMock.autocompleteCalls,
    promptMock.confirmCalls,
    promptMock.textCalls,
    promptMock.passwordCalls,
    promptMock.notes,
  ]) queue.length = 0;
  discoveryMock.calls.length = 0;
  discoveryMock.discover.mockClear();
  memoryEmbeddingMock.discover.mockClear();
  memoryEmbeddingMock.probe.mockClear();
});

async function withTtyStdin<T>(run: () => Promise<T>): Promise<T> {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const rawBefore = (process.stdin as NodeJS.ReadStream).isRaw;
  const keypressListenersBefore = process.stdin.rawListeners("keypress");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    const result = await run();
    expect(process.stdin.rawListeners("keypress")).toEqual(keypressListenersBefore);
    expect((process.stdin as NodeJS.ReadStream).isRaw).toBe(rawBefore);
    return result;
  } finally {
    if (ttyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  }
}

describe("wizard production flow", () => {
  it("accepts only canonical guided model families and rejects direct OpenCode", () => {
    expect(guidedModelRefProblem("codex:gpt-5.6-sol")).toBeUndefined();
    expect(guidedModelRefProblem("claude:claude-sonnet-5")).toBeUndefined();
    expect(guidedModelRefProblem("pi:ollama:qwen3:8b")).toBeUndefined();
    expect(guidedModelRefProblem("opencode:github-copilot:gpt-5.1")).toMatch(/scaffold\/config-only/u);
    expect(guidedModelRefProblem("foo:bar")).toBeDefined();
    expect(guidedModelRefProblem("claude:")).toBeDefined();
    expect(guidedModelRefProblem("pi:ollama:")).toBeDefined();
  });

  it("uses searchable model pickers, per-route efforts, mixed safety, and a clear creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__", // preset
      "minimal", // primary effort
      "high", // fallback effort
      "", // memory
      "per-route-native", // route safety
      "create", // final action
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "claude:claude-sonnet-5",
      "__done__",
    );
    promptMock.textAnswers.push("Research Companion");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallbacks
      true, // allow all
      true, // accept the one per-route matrix
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/research-companion" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      name: "Research Companion",
      model: "codex:gpt-5.6-terra",
      effort: "minimal",
      fallbacks: [{ model: "claude:claude-sonnet-5", effort: "high" }],
      routeSafety: "per-route-native",
    });
    expect(result.runProviderSetup).toBe(true);
    expect(result.credentialStates).toEqual({
      codex: "credential_detected",
      claude: "auth_required",
    });
    expect(promptMock.autocompleteCalls).toHaveLength(3);
    for (const call of promptMock.autocompleteCalls) {
      expect(call).toMatchObject({ maxItems: 10 });
      expect(call.placeholder).toContain("search");
    }
    expect(promptMock.autocompleteCalls[0]?.initialValue).toBe("codex:gpt-5.6-sol");
    const matrix = promptMock.notes.find((note) => note.title === "Per-route safety contract")?.message ?? "";
    expect(matrix).toContain("Codex-native sandbox + exact allow-all");
    expect(matrix).toContain("Claude: provider-native sandbox");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("Agent:        Research Companion");
    expect(review).toContain("Role target:  IDENTITY.md → ## Role");
    expect(review).toContain("Role text:    Help the operator work effectively in this folder.");
    expect(review).toContain("Create IDENTITY.md with the entered text as its ## Role body.");
    expect(review).toContain("minimal");
    expect(review).toContain("high");
    expect(review).toContain("2 real model call(s)");
    expect(review).toContain("mono-agent.config.json");
    expect(review).toContain("credential/sign-in detected; skip initial auth");
    const finalCall = promptMock.selectCalls.find((call) => String(call.message).startsWith("Create "));
    expect(finalCall?.message).toBe("Create “Research Companion”?");
    expect((finalCall?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Run setup and readiness checks, then create agent",
      "Edit choices",
      "Cancel without writing",
    ]);
  });

  it("warns in Creation review that an existing IDENTITY.md keeps its current Role", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wizard-existing-identity-"));
    try {
      await writeFile(join(cwd, "IDENTITY.md"), "# Operator identity\n\n## Role\n\nKeep me.\n");
      promptMock.selectAnswers.push("__custom__", "", "", "create");
      promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
      promptMock.textAnswers.push("Preserved Identity Agent");
      promptMock.multiselectAnswers.push(["channel:webhook"]);
      promptMock.confirmAnswers.push(false, false);

      const result = await runInitWizard({ cwd });

      expect(result.status).toBe("answers");
      const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
      expect(review).toContain("Role target:  IDENTITY.md → ## Role");
      expect(review).toContain("Role text:    Help the operator work effectively in this folder.");
      expect(review).toContain(
        "Preserve the existing IDENTITY.md unchanged; the entered Role text will not be written.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves a uniform managed-SRT mismatch before provider setup can begin", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // primary provider-default effort
      "low", // fallback effort
      "", // memory
      "uniform", // requested chain contract
      "disable-managed-srt", // resolve the invalid mixed contract
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "pi:ollama:qwen3:8b",
      "codex:gpt-5.6-terra",
      "__done__",
    );
    promptMock.textAnswers.push("Mixed Safety Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallback
      true, // allow all tools
      true, // initially request managed SRT
      true, // explicitly accept high-risk unsandboxed access
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/mixed-safety-agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      routeSafety: "uniform",
      sandbox: false,
    });
    const safetyNote = promptMock.notes.find((note) => note.title === "Safety choice required")?.message ?? "";
    expect(safetyNote).toContain("cannot promise one uniform managed-SRT contract");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).not.toContain("Managed SRT: install");
    const resolutionIndex = promptMock.selectCalls.findIndex((call) =>
      call.message === "How should this mixed chain resolve the managed-SRT mismatch?"
    );
    const creationIndex = promptMock.selectCalls.findIndex((call) =>
      String(call.message).startsWith("Create ")
    );
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    expect(creationIndex).toBeGreaterThan(resolutionIndex);
  });

  it("shows only advertised efforts and never offers none for Claude", async () => {
    promptMock.selectAnswers.push("__custom__", "max", "", "create");
    promptMock.autocompleteAnswers.push("claude:claude-sonnet-5");
    promptMock.textAnswers.push("Claude Helper");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all
      true, // high-risk provider-native
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/claude-helper" });

    expect(result.status).toBe("answers");
    const effortCall = promptMock.selectCalls.find((call) => String(call.message).includes("Reasoning effort"));
    expect((effortCall?.options as Array<{ value: string }>).map((option) => option.value))
      .toEqual(["", "low", "medium", "high", "max"]);
    expect((effortCall?.options as Array<{ value: string }>).map((option) => option.value)).not.toContain("none");
  });

  it("uses the humanized folder name as the early name default", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Research Companion");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await runInitWizard({ cwd: "/tmp/research-companion" });

    expect(result.status).toBe("answers");
    expect(promptMock.textCalls[0]).toMatchObject({
      message: "What should this agent be called?",
      initialValue: "Research Companion",
    });
  });

  it("keeps a custom agent name visible when Escape returns from model selection", async () => {
    promptMock.selectAnswers.push("__custom__", "high", "", "create");
    promptMock.autocompleteAnswers.push(ESCAPE, "codex:gpt-5.6-sol");
    promptMock.textAnswers.push("Polished Production Agent", "Polished Production Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/research-companion" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.name).toBe("Polished Production Agent");
    const nameCalls = promptMock.textCalls.filter((call) => call.message === "What should this agent be called?");
    expect(nameCalls).toHaveLength(2);
    expect(nameCalls[1]).toMatchObject({ initialValue: "Polished Production Agent" });
  });

  it("lets Escape interrupt model discovery and return to the prior wizard step", async () => {
    discoveryMock.discover.mockImplementationOnce(async (options: Record<string, unknown> = {}) => {
      discoveryMock.calls.push(options);
      const signal = options.abortSignal as AbortSignal;
      queueMicrotask(() => process.stdin.emit("keypress", "", { name: "escape" }));
      await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
      return { candidates: [], statuses: [] };
    });
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Discovery Agent", "Discovery Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/discovery-agent" }));

    expect(result.status).toBe("answers");
    expect(discoveryMock.calls).toHaveLength(2);
    expect((discoveryMock.calls[0]?.abortSignal as AbortSignal).aborted).toBe(true);
    const nameCalls = promptMock.textCalls.filter((call) => call.message === "What should this agent be called?");
    expect(nameCalls).toHaveLength(2);
  });

  it("skips non-interactive direct-Codex steps when Escape goes back from observability", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push(
      "Scheduled Partner",
      "30 7 * * 1-5",
      "45 6 * * 1-5",
    );
    promptMock.multiselectAnswers.push(["channel:cron"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks
      ESCAPE, // observability -> last prompt that actually accepted input
      false, // observability after editing the preserved cron value
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/scheduled-partner" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.moduleInputs["channel:cron"]?.cronExpression).toBe("45 6 * * 1-5");
    const cronCalls = promptMock.textCalls.filter(
      (call) => call.message === "Scheduled jobs (cron): Cron expression",
    );
    expect(cronCalls).toHaveLength(2);
    expect(cronCalls[1]).toMatchObject({ initialValue: "30 7 * * 1-5" });
    const observabilityCalls = promptMock.confirmCalls.filter(
      (call) => String(call.message).startsWith("Export traces to Phoenix"),
    );
    expect(observabilityCalls).toHaveLength(2);
  });

  it("does not review or collect an optional-only channel secret that will not be written", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Loopback API");
    promptMock.multiselectAnswers.push(["channel:openai-api"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await runInitWizard({ cwd: "/tmp/loopback-api" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.moduleSecrets).toEqual({});
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain(".env.example (placeholders only)");
    expect(review).toContain("Secret persistence: none");
    expect(review).not.toContain("MONO_AGENT_OPENAI_API_KEY ->");
    expect(review).not.toContain(".env (owner-only secret merge)");
    expect(review).not.toContain(".gitignore (ensure /.env is ignored)");
  });

  it("treats a non-empty destination OPENCODE_API_KEY as durable credential detection", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Durable OpenCode Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-opencode-agent",
      persistedEnv: { OPENCODE_API_KEY: "durable-agent-key" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ "pi:opencode-go": "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    expect(result.providerSetupSecrets).toEqual({});
    expect(result.providerEnvironmentSecrets).toEqual({});
    expect(result.piApiKeyPersistenceByProvider).toEqual({});
    expect(promptMock.selectCalls.some((call) => String(call.message).includes("store OPENCODE_API_KEY?")))
      .toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("pi:opencode-go:kimi-k2.6: credential/sign-in detected");
    expect(review).not.toContain("durable-agent-key");
  });

  it("treats a destination Claude credential as detected without exposing it in review", async () => {
    promptMock.selectAnswers.push("__custom__", "high", "", "create");
    promptMock.autocompleteAnswers.push("claude:claude-sonnet-5");
    promptMock.textAnswers.push("Durable Claude Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // accept provider-native high-risk access
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-claude-agent",
      persistedEnv: { ANTHROPIC_AUTH_TOKEN: "durable-claude-token" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ claude: "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("claude:claude-sonnet-5: credential/sign-in detected");
    expect(review).not.toContain("durable-claude-token");
  });

  it("treats a destination OPENAI_API_KEY as a direct Codex credential", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("__other__");
    promptMock.textAnswers.push("Durable Codex Agent", "codex:gpt-private");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-codex-agent",
      persistedEnv: { OPENAI_API_KEY: "durable-openai-key" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ codex: "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("codex:gpt-private: credential/sign-in detected");
    expect(review).not.toContain("durable-openai-key");
    const createCall = promptMock.selectCalls.find((call) => String(call.message).startsWith("Create "));
    expect((createCall?.options as Array<{ label: string }>)[0]?.label)
      .toBe("Run readiness checks, then create agent");
  });

  it("reviews an environment-selected Pi key as an owner-only .env write before creation", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // no memory
      "environment", // Pi API-key persistence
      "create",
    );
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Environment Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );
    promptMock.passwordAnswers.push("review-secret-value");

    const previousAmbient = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "shell-only-key";
    try {
      const result = await runInitWizard({ cwd: "/tmp/environment-agent", persistedEnv: {} });

      expect(result.status).toBe("answers");
      if (result.status !== "answers") return;
      expect(result.credentialStates).toEqual({ "pi:opencode-go": "auth_required" });
      expect(result.providerEnvironmentSecrets).toEqual({ OPENCODE_API_KEY: "review-secret-value" });
      expect(result.providerSetupSecrets).toEqual({});
      expect(result.piApiKeyPersistenceByProvider).toEqual({ "opencode-go": "environment" });
      const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
      expect(review).toContain("OPENCODE_API_KEY -> owner-only .env merge");
      expect(review).toContain("(environment): read OPENCODE_API_KEY");
      expect(review).not.toContain("(secure store): read OPENCODE_API_KEY");
      expect(review).toContain("May create or update: .env (owner-only secret merge), .gitignore");
      const createsLine = review.split("\n").find((line) => line.startsWith("Creates if missing")) ?? "";
      expect(createsLine).not.toContain(".env (owner-only secret merge)");
      expect(createsLine).not.toContain(".gitignore");
      expect(review).toContain("do not write Pi auth.json");
      expect(review).not.toContain("review-secret-value");
      expect(review).not.toContain("shell-only-key");
    } finally {
      if (previousAmbient === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousAmbient;
    }
  });

  it("reviews a secure-store Pi key as auth.json-only before creation", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "secure-store", "create");
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Secure Store Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, true, true, false);
    promptMock.passwordAnswers.push("auth-store-secret-value");

    const result = await runInitWizard({ cwd: "/tmp/secure-store-agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.providerEnvironmentSecrets).toEqual({});
    expect(result.providerSetupSecrets).toHaveProperty("pi-api-key:opencode-go", "auth-store-secret-value");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("(secure store): save credential");
    expect(review).toContain("save credential to owner-only");
    expect(review).toContain("Pi auth.json");
    expect(review).toContain("not copied to .env");
    expect(review).not.toContain(".env (owner-only secret merge)");
    expect(review).not.toContain("auth-store-secret-value");
  });

  it("uses an actual Escape keypress at primary effort to return to the model picker", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      ESCAPE, // first primary effort prompt
      "high", // replacement primary effort
      "", // memory
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-sol",
    );
    promptMock.textAnswers.push("Effort Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks after replacing the primary model
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/effort-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      name: "Effort Back Agent",
      model: "codex:gpt-5.6-sol",
      effort: "high",
      fallbacks: [],
    });
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => String(call.message).startsWith("Reasoning effort for ")))
      .toHaveLength(2);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses actual Escape keypresses to retry fallback effort and remove the latest fallback", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "minimal", // primary effort
      ESCAPE, // first Claude fallback effort
      "high", // retried Claude fallback effort
      "xhigh", // replacement Codex fallback effort
      "", // memory
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "claude:claude-sonnet-5",
      "claude:claude-sonnet-5", // effort Escape reopens fallback model #1
      ESCAPE, // fallback model #2 removes the latest fallback
      "codex:gpt-5.6-sol",
      "__done__",
    );
    promptMock.textAnswers.push("Fallback Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallbacks
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/fallback-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      model: "codex:gpt-5.6-terra",
      effort: "minimal",
      fallbacks: [{ model: "codex:gpt-5.6-sol", effort: "xhigh" }],
    });
    expect(promptMock.selectCalls.filter((call) => call.message === "Reasoning effort for claude:claude-sonnet-5"))
      .toHaveLength(2);
    expect(promptMock.autocompleteCalls
      .filter((call) => String(call.message).startsWith("Fallback model #"))
      .map((call) => call.message))
      .toEqual([
        "Fallback model #1",
        "Fallback model #1",
        "Fallback model #2",
        "Fallback model #1",
        "Fallback model #2",
      ]);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses an actual Escape keypress in the edit submenu to return directly to creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // memory
      "edit",
      ESCAPE, // edit submenu
      "create",
    );
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Review Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/review-back-agent" }));

    expect(result.status).toBe("answers");
    expect(promptMock.notes.filter((note) => note.title === "Creation review")).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => call.message === "What would you like to edit?"))
      .toHaveLength(1);
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(1);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses an actual Escape keypress in a provider secret prompt to return to creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // memory
      "environment", // first review's Pi key destination
      "create",
      "environment", // repeated review's Pi key destination
      "create",
    );
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Secret Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );
    promptMock.passwordAnswers.push(
      ESCAPE,
      "replacement-secret",
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/secret-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.providerEnvironmentSecrets).toEqual({ OPENCODE_API_KEY: "replacement-secret" });
    expect(promptMock.notes.filter((note) => note.title === "Creation review")).toHaveLength(2);
    expect(promptMock.passwordCalls).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => String(call.message).includes("store OPENCODE_API_KEY?")))
      .toHaveLength(2);
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(1);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("exits cleanly when setup is cancelled again during the default-No exit confirmation", async () => {
    promptMock.selectAnswers.push(CANCEL);
    promptMock.confirmAnswers.push(CANCEL);

    await expect(runInitWizard({ cwd: "/tmp/agent" })).resolves.toEqual({ status: "cancelled" });
  });

  it("forwards cron validation to Clack and trims the accepted value", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Cron Agent", "  15 9 * * 1-5  ");
    promptMock.multiselectAnswers.push(["channel:cron"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await runInitWizard({ cwd: "/tmp/cron-agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.moduleInputs["channel:cron"]?.cronExpression).toBe("15 9 * * 1-5");
    const cronCall = promptMock.textCalls.find((call) => call.message === "Scheduled jobs (cron): Cron expression");
    const validate = cronCall?.validate as ((value: string | undefined) => string | undefined) | undefined;
    expect(validate?.("")).toBe(
      "Enter a cron expression using five fields: minute hour day-of-month month day-of-week.",
    );
    expect(validate?.("0 8 * * * *")).toBe(
      "Use exactly five fields: minute hour day-of-month month day-of-week (for example, 0 8 * * *).",
    );
  });

  it("repairs capability details from Creation review without replaying unrelated prompts", async () => {
    const answers = defaultAnswers({
      name: "Scheduled Partner",
      model: "codex:gpt-5.6-terra",
      channels: ["channel:cron"],
      moduleInputs: { "channel:cron": { cronExpression: "30 7 * * 1-5" } },
    });
    promptMock.selectAnswers.push("edit", "4", "create");
    promptMock.textAnswers.push("  45 6 * * 1-5  ");

    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      answers,
      runProviderSetup: true,
      providerSetupSecrets: { "pi-api-key:openai-codex": "provider-secret" },
      providerEnvironmentSecrets: { OPENAI_API_KEY: "environment-secret" },
      piApiKeyPersistenceByProvider: { "openai-codex": "secure-store" },
      credentialStates: { codex: "auth_required" },
      moduleSecrets: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "stale-deselected-secret" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.name).toBe("Scheduled Partner");
    expect(result.answers.moduleInputs["channel:cron"]?.cronExpression).toBe("45 6 * * 1-5");
    expect(result.runProviderSetup).toBe(true);
    expect(result.providerSetupSecrets).toEqual({ "pi-api-key:openai-codex": "provider-secret" });
    expect(result.providerEnvironmentSecrets).toEqual({ OPENAI_API_KEY: "environment-secret" });
    expect(result.piApiKeyPersistenceByProvider).toEqual({ "openai-codex": "secure-store" });
    expect(result.credentialStates).toEqual({ codex: "auth_required" });
    expect(result.moduleSecrets).toEqual({});
    const cronCall = promptMock.textCalls[0];
    expect(cronCall).toMatchObject({ initialValue: "30 7 * * 1-5" });
    expect(promptMock.textCalls).toHaveLength(1);
    expect(promptMock.autocompleteCalls).toHaveLength(0);
    expect(promptMock.multiselectAnswers).toHaveLength(0);
    expect(promptMock.confirmCalls).toHaveLength(0);
  });

  it("returns Escape from seeded setup repair to recovery without changing state", async () => {
    promptMock.selectAnswers.push(ESCAPE);
    await withTtyStdin(async () => {
      await expect(runSetupRepairWizard({
        cwd: "/tmp/agent",
        answers: defaultAnswers({ name: "Keep Me", model: "codex:gpt-5.6-terra" }),
        runProviderSetup: false,
        providerSetupSecrets: {},
        providerEnvironmentSecrets: {},
        piApiKeyPersistenceByProvider: {},
        credentialStates: { codex: "credential_detected" },
        moduleSecrets: {},
      })).resolves.toEqual({ status: "cancelled" });
    });
    expect(promptMock.textCalls).toHaveLength(0);
    expect(promptMock.confirmCalls).toHaveLength(0);
  });

  it("returns a focused name edit directly to Creation review", async () => {
    promptMock.textAnswers.push("Renamed Partner");
    promptMock.selectAnswers.push("create");

    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      initialStep: 0,
      answers: defaultAnswers({ name: "Original Partner", model: "codex:gpt-5.6-terra" }),
      runProviderSetup: false,
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      moduleSecrets: {},
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.name).toBe("Renamed Partner");
    expect(promptMock.textCalls.map((call) => call.message)).toEqual([
      "What should this agent be called?",
      "What Role should be saved to IDENTITY.md → ## Role?",
    ]);
    expect(promptMock.autocompleteCalls).toHaveLength(0);
    expect(promptMock.multiselectAnswers).toHaveLength(0);
    expect(promptMock.confirmCalls).toHaveLength(0);
  });

  it("preserves ephemeral provider state during a focused unchanged-model edit", async () => {
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.selectAnswers.push("medium", "create");
    promptMock.confirmAnswers.push(false); // no fallbacks

    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      initialStep: 1,
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6", effort: "medium" }),
      runProviderSetup: false,
      providerSetupSecrets: { "pi-api-key:opencode-go": "in-memory-key" },
      providerEnvironmentSecrets: { OPENCODE_API_KEY: "environment-key" },
      piApiKeyPersistenceByProvider: { "opencode-go": "environment" },
      credentialStates: { "pi:opencode-go": "credential_detected" },
      moduleSecrets: {},
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.providerSetupSecrets).toEqual({ "pi-api-key:opencode-go": "in-memory-key" });
    expect(result.providerEnvironmentSecrets).toEqual({ OPENCODE_API_KEY: "environment-key" });
    expect(result.piApiKeyPersistenceByProvider).toEqual({ "opencode-go": "environment" });
    expect(promptMock.textCalls).toHaveLength(0);
    expect(promptMock.multiselectAnswers).toHaveLength(0);
  });

  it("recomputes provider setup when a memory edit changes hidden setup model refs", async () => {
    promptMock.selectAnswers.push(
      "edit",
      "3",
      "memory:bujo",
      "lmstudio",
      "create",
    );
    promptMock.autocompleteAnswers.push("text-embedding-nomic-embed-text-v1.5");
    promptMock.textAnswers.push("http://localhost:1234", "LM_STUDIO_API_KEY");
    promptMock.confirmAnswers.push(false); // observability while the existing review flow advances
    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      persistedEnv: { LM_STUDIO_API_KEY: "local-test-secret" },
      answers: defaultAnswers({ model: "codex:gpt-5.6-terra" }),
      runProviderSetup: false,
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      moduleSecrets: {},
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.memory).toBe("memory:bujo");
    expect(result.answers.moduleInputs["memory:bujo"]).toEqual({
      embeddingProvider: "lmstudio",
      embeddingEndpoint: "http://localhost:1234",
      embeddingModel: "text-embedding-nomic-embed-text-v1.5",
      embeddingDimension: "768",
      embeddingApiKeyEnv: "LM_STUDIO_API_KEY",
    });
    expect(memoryEmbeddingMock.discover).toHaveBeenCalledWith(expect.objectContaining({
      provider: "lmstudio",
      endpoint: "http://localhost:1234",
      apiKey: "local-test-secret",
    }));
    expect(memoryEmbeddingMock.probe).toHaveBeenCalledWith(expect.objectContaining({
      provider: "lmstudio",
      model: "text-embedding-nomic-embed-text-v1.5",
      apiKey: "local-test-secret",
    }));
    expect(JSON.stringify(result.answers)).not.toContain("local-test-secret");
    expect(result.runProviderSetup).toBe(true);
  });

  it("replaces the complete managed-memory provider bag when an edit switches services", async () => {
    promptMock.selectAnswers.push("edit", "4", "ollama", "create");
    promptMock.autocompleteAnswers.push("nomic-embed-text:v1.5");
    promptMock.textAnswers.push("http://localhost:11434", "");

    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      answers: defaultAnswers({
        memory: "memory:bujo",
        moduleInputs: {
          "memory:bujo": {
            embeddingProvider: "lmstudio",
            embeddingEndpoint: "http://localhost:1234",
            embeddingModel: "old-lmstudio-model",
            embeddingDimension: "1024",
            embeddingApiKeyEnv: "STALE_LM_STUDIO_KEY",
          },
        },
      }),
      runProviderSetup: false,
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      moduleSecrets: {},
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.moduleInputs["memory:bujo"]).toEqual({
      embeddingProvider: "ollama",
      embeddingEndpoint: "http://localhost:11434",
      embeddingModel: "nomic-embed-text:v1.5",
      embeddingDimension: "768",
    });
  });

  it("keeps manual model and positive dimension explicit when typed discovery and probing are unavailable", async () => {
    memoryEmbeddingMock.discover.mockResolvedValueOnce([]);
    memoryEmbeddingMock.probe.mockRejectedValueOnce(new Error("service unavailable"));
    promptMock.selectAnswers.push("edit", "4", "lmstudio", "create");
    promptMock.textAnswers.push(
      "http://localhost:1234",
      "",
      "manually-loaded-embedding-model",
      "512",
    );

    const result = await runSetupRepairWizard({
      cwd: "/tmp/agent",
      answers: defaultAnswers({
        memory: "memory:journal",
        moduleInputs: {
          "memory:journal": {
            embeddingProvider: "lmstudio",
            embeddingEndpoint: "http://localhost:1234",
            embeddingModel: "previous-model",
            embeddingDimension: "768",
          },
        },
      }),
      runProviderSetup: false,
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      moduleSecrets: {},
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.moduleInputs["memory:journal"]).toEqual({
      embeddingProvider: "lmstudio",
      embeddingEndpoint: "http://localhost:1234",
      embeddingModel: "manually-loaded-embedding-model",
      embeddingDimension: "512",
    });
  });

});
