import { isProxy } from "node:util/types";

import type {
  JsonValue,
  ModuleCommand,
} from "@mono-agent/module-sdk";

interface SandboxSrtStatusBase {
  readonly mode: "native";
  readonly activeCommands: number;
  readonly executableSha256: string;
  readonly settingsSha256: string;
}

export type SandboxSrtStatus = Readonly<Record<string, JsonValue>> & (
  | (SandboxSrtStatusBase & {
    readonly status: "ready";
    readonly integrity: "verified";
    readonly networkAvailability: "settings-controlled";
  })
  | (SandboxSrtStatusBase & {
    readonly status: "degraded";
    readonly integrity: "unverified";
    readonly networkAvailability: "unavailable";
    readonly code: "sandbox_integrity_unverified";
    readonly message: string;
  })
  | (SandboxSrtStatusBase & {
    readonly status: "closed";
    readonly integrity: "closed";
    readonly networkAvailability: "unavailable";
    readonly code: "sandbox_closed";
    readonly message: string;
  })
);

export const sandboxSrtStatusCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export function createSandboxSrtStatusCommands(
  inspect: (signal: AbortSignal) => Promise<SandboxSrtStatus>,
): readonly ModuleCommand[] {
  return Object.freeze([{
    name: "sandbox-srt:status",
    kind: "maintenance",
    description:
      "Re-prove the selected SRT files and report bounded integrity and network-policy availability.",
    inputSchema: sandboxSrtStatusCommandInputSchema,
    async run(input, context): Promise<JsonValue> {
      parseEmptyInput(input);
      throwIfAborted(context.signal);
      return await inspect(context.signal);
    },
  }] satisfies readonly ModuleCommand[]);
}

function parseEmptyInput(value: unknown): void {
  const input = value === undefined ? {} : value;
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
    throw new TypeError("Sandbox status command input must be a plain object.");
  }
  if (Reflect.ownKeys(input).length > 0) {
    throw new TypeError("Sandbox status command input contains an unknown field.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
