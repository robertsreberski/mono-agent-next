// SPDX-License-Identifier: MIT
import { isProxy } from "node:util/types";

import type { JsonValue, ModuleCommand } from "@mono-agent/module-sdk";

import { SlackInbox } from "./inbox.js";
import { validateEnvelopeId } from "./inbox-values.js";

const INSPECT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({}),
});

const REQUEUE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    envelopeId: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: 512,
    }),
    confirm: Object.freeze({ const: true }),
  }),
  required: Object.freeze(["envelopeId", "confirm"]),
});

export interface SlackInboxCommandAccess {
  withInbox<T>(
    signal: AbortSignal,
    operation: (inbox: SlackInbox | undefined) => Promise<T> | T,
  ): Promise<T>;
}

export function createSlackInboxCommands(
  access: SlackInboxCommandAccess,
): readonly ModuleCommand[] {
  return Object.freeze([
    {
      name: "channel-slack:inbox-inspect",
      kind: "maintenance",
      description:
        "Inspect bounded Slack durable inbox metadata without exposing event payloads or starting the channel.",
      inputSchema: INSPECT_INPUT_SCHEMA,
      async run(input, context): Promise<JsonValue> {
        ownInput(input, [], true, "Slack inbox inspect command input");
        return await access.withInbox(context.signal, (inbox) => ({
          entries: (inbox?.inspectEntries() ?? []).map((entry) => ({
            envelopeId: entry.envelopeId,
            status: entry.status,
            ...(entry.lane === undefined ? {} : { lane: entry.lane }),
            admittedAt: entry.admittedAt,
          })),
        }));
      },
    },
    {
      name: "channel-slack:inbox-requeue",
      kind: "maintenance",
      description:
        "Requeue one exact processing Slack envelope after explicit operator confirmation.",
      inputSchema: REQUEUE_INPUT_SCHEMA,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(
          input,
          ["envelopeId", "confirm"],
          false,
          "Slack inbox requeue command input",
        );
        if (parsed.confirm !== true) {
          throw new TypeError("Slack inbox requeue requires explicit confirm: true.");
        }
        if (typeof parsed.envelopeId !== "string") {
          throw new TypeError("Slack inbox requeue envelopeId must be a string.");
        }
        const envelopeId = parsed.envelopeId;
        validateEnvelopeId(envelopeId);
        return await access.withInbox(context.signal, async (inbox) => {
          const entry = inbox?.inspectEntries().find(
            (candidate) => candidate.envelopeId === envelopeId,
          );
          if (inbox === undefined || entry?.status !== "processing") {
            throw new TypeError(
              "Slack inbox requeue requires an exact processing envelopeId.",
            );
          }
          await inbox.release(envelopeId, context.signal);
          return {
            envelopeId,
            previousStatus: "processing",
            ...(entry.lane === undefined ? {} : { previousLane: entry.lane }),
            status: "pending",
            requeued: true,
          };
        });
      },
    },
  ] satisfies readonly ModuleCommand[]);
}

function ownInput(
  value: unknown,
  allowed: readonly string[],
  allowUndefined: boolean,
  label: string,
): Record<string, unknown> {
  const input = value === undefined && allowUndefined ? {} : value;
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || isProxy(input)
    || (
      Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null
    )
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field.`);
  }
  const parsed: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property.`);
    }
    parsed[key] = descriptor.value;
  }
  return parsed;
}
