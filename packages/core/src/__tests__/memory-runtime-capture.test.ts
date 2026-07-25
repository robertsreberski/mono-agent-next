// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type {
  MemoryHost,
  MemoryRuntimeCaptureGrant,
  RuntimeCapabilities,
} from "@mono-agent/module-sdk";

import { createAgentHost } from "../index.js";
import {
  createFixtureProject,
  minimalConfig,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("memory runtime-capture host grant", () => {
  it("uses the exact requested runtime/model and enforces runtime-owned model preflight", async () => {
    const suffix = randomUUID().toLowerCase();
    const mainPackage = `@fixture/runtime-main-${suffix}`;
    const capturePackage = `@fixture/runtime-memory-${suffix}`;
    const memoryPackage = `@fixture/memory-${suffix}`;
    let grant: MemoryRuntimeCaptureGrant | undefined;
    let mainTurns = 0;
    let captureTurns = 0;
    const preflightModels: string[] = [];
    const project = await fixture([
      {
        name: mainPackage,
        kind: "runtime",
        controller: {
          create: () => runtimeInstance(async () => {
            mainTurns += 1;
            return completed("wrong runtime");
          }),
        },
      },
      {
        name: capturePackage,
        kind: "runtime",
        controller: {
          create: () => ({
            ...runtimeInstance(async (request: unknown) => {
              captureTurns += 1;
              const turn = request as {
                readonly model: string;
                readonly tools: readonly unknown[];
                readonly options?: { readonly responseSchema?: unknown };
              };
              expect(turn.model).toBe("fixture:memory-model");
              expect(turn.tools).toEqual([]);
              expect(turn.options?.responseSchema).toMatchObject({ type: "object" });
              return {
                ...completed("{\"records\":[{\"text\":\"durable fact\"}]}"),
                structuredOutput: { records: [{ text: "durable fact" }] },
              };
            }),
            preflightModel({ model }: { readonly model: string }) {
              preflightModels.push(model);
              return { supported: model === "fixture:memory-model" };
            },
          }),
        },
      },
      {
        name: memoryPackage,
        kind: "memory",
        capabilities: ["memory.runtime-capture"],
        controller: {
          create(context: unknown) {
            grant = (context as { readonly host: MemoryHost }).host.runtimeCapture;
            return memoryInstance();
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(mainPackage, {
      runtimes: {
        main: { $use: mainPackage },
        memory: { $use: capturePackage },
      },
      memory: { $use: memoryPackage },
    }));
    const host = await createAgentHost(project.configPath);
    try {
      const result = await grant!.complete({
        instructions: "Extract one durable fact.",
        input: "The bicycle is blue.",
        responseSchema: {
          type: "object",
          required: ["records"],
          properties: { records: { type: "array" } },
        },
        maxOutputTokens: 128,
        runtime: "memory",
        model: "fixture:memory-model",
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      });
      expect(result.structuredOutput).toEqual({ records: [{ text: "durable fact" }] });
      expect(preflightModels).toEqual(["fixture:memory-model"]);
      expect(mainTurns).toBe(0);
      expect(captureTurns).toBe(1);

      await expect(grant!.complete({
        instructions: "Extract one durable fact.",
        input: "Unsupported route.",
        maxOutputTokens: 128,
        runtime: "memory",
        model: "fixture:unsupported",
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      })).rejects.toThrow(/does not support the selected model/u);
      expect(captureTurns).toBe(1);
    } finally {
      await host.stop();
    }
  });

  it("rejects capture routes without structured output and bounds timeout independently", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimePackage = `@fixture/runtime-${suffix}`;
    const memoryPackage = `@fixture/memory-${suffix}`;
    let grant: MemoryRuntimeCaptureGrant | undefined;
    let turnSignal: AbortSignal | undefined;
    const noStructuredOutput: RuntimeCapabilities = {
      tools: false,
      mcp: false,
      attachments: false,
      approvals: false,
      structuredOutput: false,
      sandbox: false,
      sessions: false,
    };
    const project = await fixture([
      {
        name: runtimePackage,
        kind: "runtime",
        controller: {
          create: () => ({
            capabilities: noStructuredOutput,
            async runTurn(request: { readonly signal: AbortSignal }) {
              turnSignal = request.signal;
              await new Promise<never>((_, reject) => {
                request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                  once: true,
                });
              });
            },
          }),
        },
      },
      {
        name: memoryPackage,
        kind: "memory",
        capabilities: ["memory.runtime-capture"],
        controller: {
          create(context: unknown) {
            grant = (context as { readonly host: MemoryHost }).host.runtimeCapture;
            return memoryInstance();
          },
        },
      },
    ]);
    await project.writeConfig(minimalConfig(runtimePackage, {
      memory: { $use: memoryPackage },
    }));
    const host = await createAgentHost(project.configPath);
    try {
      await expect(grant!.complete({
        instructions: "Extract.",
        input: "Input.",
        responseSchema: { type: "object" },
        maxOutputTokens: 16,
        runtime: "main",
        model: "fixture:model",
        timeoutMs: 10,
        signal: new AbortController().signal,
      })).rejects.toThrow(/does not support structured output/u);
      expect(turnSignal).toBeUndefined();
      await expect(grant!.complete({
        instructions: "Extract.",
        input: "Input.",
        maxOutputTokens: 16,
        runtime: "missing",
        model: "fixture:model",
        timeoutMs: 10,
        signal: new AbortController().signal,
      })).rejects.toThrow(/runtime missing is unavailable/u);
    } finally {
      await host.stop();
    }
  });
});

async function fixture(
  options: Parameters<typeof createFixtureProject>[0],
): Promise<FixtureProject> {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

function runtimeInstance(runTurn: (request: unknown) => unknown | Promise<unknown>) {
  return {
    capabilities: {
      tools: true,
      mcp: true,
      attachments: true,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
    },
    runTurn,
  };
}

function memoryInstance() {
  return {
    capabilities: { capture: true, forget: true },
    async recall() { return { records: [] }; },
    async capture() {},
    async forget() { return false; },
  };
}

function completed(text: string) {
  return {
    status: "completed",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}
