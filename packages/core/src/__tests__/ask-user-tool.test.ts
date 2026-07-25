// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import type {
  AgentInteractionHandler,
  AskUserRequest,
  RuntimeToolResult,
  RuntimeTurnContext,
  RuntimeTurnRequest,
} from "@mono-agent/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentHost } from "../host.js";
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

describe("AskUser Core tool", () => {
  it("is available only with an interaction bridge and obeys global and request tool policy", async () => {
    const cases = [
      {
        label: "bridge-absent",
        policy: {
          tools: { default: "allow", deny: [] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
        bridge: false,
        expected: [],
      },
      {
        label: "global-deny",
        policy: {
          tools: { default: "deny", allow: [] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
        bridge: true,
        expected: [],
      },
      {
        label: "global-allow",
        policy: {
          tools: { default: "deny", allow: ["AskUser"] },
          approvals: { default: "deny" },
          sandbox: { mode: "off" },
        },
        bridge: true,
        expected: ["AskUser"],
      },
      {
        label: "request-deny",
        policy: {
          tools: { default: "allow", deny: [] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
        bridge: true,
        toolPolicy: { deny: ["AskUser"] },
        expected: [],
      },
      {
        label: "request-narrow",
        policy: {
          tools: { default: "allow", deny: [] },
          approvals: { default: "allow" },
          sandbox: { mode: "off" },
        },
        bridge: true,
        toolPolicy: { allow: ["MemoryRecall"] },
        expected: [],
      },
    ] as const;
    for (const testCase of cases) {
      const runtimeName = `@fixture/runtime-ask-policy-${randomUUID().toLowerCase()}`;
      let names: string[] = [];
      const project = await createFixtureProject([{
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController((rawRequest) => {
          names = (rawRequest as RuntimeTurnRequest).tools.map((tool) => tool.name);
          return completed(testCase.label);
        }),
      }]);
      projects.push(project);
      await project.writeConfig(minimalConfig(runtimeName, { policy: testCase.policy }));
      const host = await createAgentHost(project.configPath);
      const interactionHandler: AgentInteractionHandler = {
        askUser: async () => { throw new Error("AskUser is not expected"); },
        requestApproval: async () => { throw new Error("approval is not expected"); },
      };
      try {
        await host.submit({
          requestId: testCase.label,
          conversationId: testCase.label,
          text: testCase.label,
          ...(testCase.bridge ? { interactionHandler } : {}),
          ...("toolPolicy" in testCase ? { toolPolicy: testCase.toolPolicy } : {}),
        });
      } finally {
        await host.stop();
      }
      expect(names).toEqual(testCase.expected);
    }
  });

  it("validates canonical questions, blocks on Core, and returns a structured answer without approval", async () => {
    const runtimeName = `@fixture/runtime-ask-execute-${randomUUID().toLowerCase()}`;
    let askTool: RuntimeTurnRequest["tools"][number] | undefined;
    let invalidResult: RuntimeToolResult | undefined;
    let answerResult: RuntimeToolResult | undefined;
    const project = await createFixtureProject([{
      name: runtimeName,
      kind: "runtime",
      controller: runtimeController(async (rawRequest, rawContext) => {
        const request = rawRequest as RuntimeTurnRequest;
        const context = rawContext as RuntimeTurnContext;
        askTool = request.tools.find((tool) => tool.name === "AskUser");
        if (askTool === undefined) throw new Error("AskUser tool is unavailable");
        const question = {
          id: "q",
          prompt: "Choose",
          allowFreeText: true,
          multiple: false,
        };
        invalidResult = await context.executeTool({
          id: "ask-invalid",
          name: "AskUser",
          input: { questions: [question, { ...question, id: "q2" }, { ...question, id: "q3" }, { ...question, id: "q4" }] },
        }, request.signal);
        answerResult = await context.executeTool({
          id: "ask-valid",
          name: "AskUser",
          input: {
            questions: [{
              id: "tone",
              prompt: "Which tone should I use?",
              choices: [
                { value: "concise", label: "Concise", description: "Keep it short." },
                { value: "detailed", label: "Detailed" },
              ],
              allowFreeText: false,
              multiple: false,
            }, {
              id: "notes",
              prompt: "Any other constraints?",
              allowFreeText: true,
              multiple: false,
            }],
          },
        }, request.signal);
        return completed("answered");
      }),
    }]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      policy: {
        tools: { default: "deny", allow: ["AskUser"] },
        approvals: { default: "ask" },
        sandbox: { mode: "off" },
      },
    }));
    const asked: AskUserRequest[] = [];
    const requestApproval = vi.fn<AgentInteractionHandler["requestApproval"]>(
      async () => { throw new Error("AskUser must not request approval"); },
    );
    const host = await createAgentHost(project.configPath);
    try {
      await expect(host.submit({
        requestId: "ask-core-tool",
        conversationId: "ask-core-tool",
        text: "ask me",
        interactionHandler: {
          async askUser(request) {
            asked.push(request);
            return {
              interactionId: request.interactionId,
              answers: { tone: ["concise"], notes: ["No jargon."] },
              answeredAt: new Date().toISOString(),
            };
          },
          requestApproval,
        },
      })).resolves.toMatchObject({ status: "completed", text: "answered" });
    } finally {
      await host.stop();
    }

    expect(askTool).toMatchObject({
      name: "AskUser",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { questions: { minItems: 1, maxItems: 3 } },
      },
    });
    expect(invalidResult).toMatchObject({
      callId: "ask-invalid",
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/between 1 and 3/u) }],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      interactionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      requestedAt: expect.stringMatching(/Z$/u),
      questions: [{
        id: "tone",
        prompt: "Which tone should I use?",
        choices: [
          { value: "concise", label: "Concise", description: "Keep it short." },
          { value: "detailed", label: "Detailed" },
        ],
        allowFreeText: false,
        multiple: false,
      }, {
        id: "notes",
        prompt: "Any other constraints?",
        allowFreeText: true,
        multiple: false,
      }],
    });
    expect(answerResult).toMatchObject({
      callId: "ask-valid",
      content: [{
        type: "json",
        value: {
          interactionId: asked[0]!.interactionId,
          answers: { tone: ["concise"], notes: ["No jargon."] },
          answeredAt: expect.stringMatching(/Z$/u),
        },
      }],
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
