// SPDX-License-Identifier: MIT

// Core records runtime/model on every run entry but never told the model, so
// "what model are you running?" was answered by reading the agent's own config
// file — which reports the configured primary and the whole fallback chain, not
// the model actually serving the turn. After an operator override that made a
// working feature look broken.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { RuntimeTurnError } from "@mono-agent/module-sdk";

import { createAgentHost } from "../index.js";
import type { AgentConfig } from "../types.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  runtimeController,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function fixture(options: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

/** The text of the `route` system message Core injects for the attempt. */
function routeFact(request: unknown): string {
  if (typeof request !== "object" || request === null) return "";
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const entry = message as { name?: unknown; content?: unknown };
    if (entry.name !== "route" || !Array.isArray(entry.content)) continue;
    const part = entry.content[0] as { text?: unknown } | undefined;
    if (typeof part?.text === "string") return part.text;
  }
  return "";
}

describe("ground-truth route identity", () => {
  it("states the serving runtime, model, and effort to the model", async () => {
    const runtime = `@fixture/runtime-identity-${randomUUID().toLowerCase()}`;
    let fact = "";
    const project = await fixture([{
      name: runtime,
      kind: "runtime",
      controller: runtimeController((request) => {
        fact = routeFact(request);
        return completed("ok");
      }),
    }]);
    await project.writeConfig({
      ...minimalConfig(runtime),
      routing: {
        primary: { runtime: "main", model: "fixture:model" },
        fallbacks: [],
        effort: "high",
      },
    } as AgentConfig);

    const host = await createAgentHost(project.configPath);
    await host.submit({ conversationId: "identity", text: "which model are you?" });
    await host.stop();

    expect(fact).toContain("- runtime instance: main");
    expect(fact).toContain("- model: fixture:model");
    expect(fact).toContain("- effort: high");
    expect(fact).toContain("never from configuration files");
  });

  it("names the route that actually served the turn after a failover", async () => {
    // The reported case: an override worked, the fallback answered, and the
    // agent still described the configured primary.
    const primary = `@fixture/runtime-primary-${randomUUID().toLowerCase()}`;
    const fallback = `@fixture/runtime-fallback-${randomUUID().toLowerCase()}`;
    const facts: string[] = [];
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: runtimeController((request) => {
          facts.push(routeFact(request));
          throw new RuntimeTurnError({
            code: "fixture_primary_unavailable",
            message: "primary unavailable",
            retryability: "retryable",
            sideEffects: "none",
          });
        }),
      },
      {
        name: fallback,
        kind: "runtime",
        controller: runtimeController((request) => {
          facts.push(routeFact(request));
          return completed("ok");
        }),
      },
    ]);
    await project.writeConfig({
      ...minimalConfig(primary),
      runtimes: { main: { $use: primary }, spare: { $use: fallback } },
      routing: {
        primary: { runtime: "main", model: "fixture:model" },
        fallbacks: [{ runtime: "spare", model: "fixture:spare-model" }],
      },
    } as AgentConfig);

    const host = await createAgentHost(project.configPath);
    await host.submit({ conversationId: "failover", text: "which model are you?" });
    await host.stop();

    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("- model: fixture:model");
    expect(facts[1]).toContain("- runtime instance: spare");
    expect(facts[1]).toContain("- model: fixture:spare-model");
    // The serving attempt must not describe itself as the primary.
    expect(facts[1]).not.toContain("- model: fixture:model\n");
  });

  it("does not recite the routing topology to the model", async () => {
    // The same read that produced the wrong answer also exposed the operator's
    // full fallback chain. The injected fact carries only the active route.
    const primary = `@fixture/runtime-topology-${randomUUID().toLowerCase()}`;
    const fallback = `@fixture/runtime-topology-spare-${randomUUID().toLowerCase()}`;
    let fact = "";
    const project = await fixture([
      {
        name: primary,
        kind: "runtime",
        controller: runtimeController((request) => {
          fact = routeFact(request);
          return completed("ok");
        }),
      },
      { name: fallback, kind: "runtime", controller: runtimeController(() => completed("unused")) },
    ]);
    await project.writeConfig({
      ...minimalConfig(primary),
      runtimes: { main: { $use: primary }, spare: { $use: fallback } },
      routing: {
        primary: { runtime: "main", model: "fixture:model" },
        fallbacks: [{ runtime: "spare", model: "fixture:secret-fallback-model" }],
      },
    } as AgentConfig);

    const host = await createAgentHost(project.configPath);
    await host.submit({ conversationId: "topology", text: "hello" });
    await host.stop();

    expect(fact).toContain("- model: fixture:model");
    expect(fact).not.toContain("fixture:secret-fallback-model");
    expect(fact).not.toContain("spare");
  });
});
