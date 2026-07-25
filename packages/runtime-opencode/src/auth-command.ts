// SPDX-License-Identifier: MIT
import type { ModuleCommand } from "@mono-agent/module-sdk";

import type { RuntimeOpenCodeConfig } from "./config.js";

type AuthAction = "status" | "models" | "login";

const ACTIONS = Object.freeze<AuthAction[]>(["status", "models", "login"]);
const INPUT_ERROR = "runtime-opencode auth input must contain only action: status, models, or login";

const inputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    action: Object.freeze({
      type: "string",
      enum: ACTIONS,
      default: "status",
    }),
  }),
});

function actionOf(input: unknown): AuthAction {
  if (input === undefined) return "status";
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(INPUT_ERROR);
  }
  let keys: readonly PropertyKey[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(input);
    descriptor = Object.getOwnPropertyDescriptor(input, "action");
  } catch {
    throw new TypeError(INPUT_ERROR);
  }
  if (keys.length === 0) return "status";
  if (
    keys.length !== 1
    || keys[0] !== "action"
    || descriptor === undefined
    || !("value" in descriptor)
    || !ACTIONS.includes(descriptor.value as AuthAction)
  ) {
    throw new TypeError(INPUT_ERROR);
  }
  return descriptor.value as AuthAction;
}

function unsupported(action: Exclude<AuthAction, "status">) {
  return Object.freeze({
    provider: "opencode",
    action,
    status: "unsupported",
    code: action === "models"
      ? "model_discovery_unavailable"
      : "interactive_login_unavailable",
    message: action === "models"
      ? "OpenCode model discovery requires a running authenticated server and is unavailable to this non-serving command."
      : "Interactive OpenCode login is not available through a non-serving module command.",
  });
}

export function openCodeAuthCommands(config: RuntimeOpenCodeConfig): readonly ModuleCommand[] {
  const configuredEntries = Object.keys(config.environment).length;
  const authentication = Object.freeze({
    state: configuredEntries === 0 ? "not-configured" : "configured-unverified",
    source: configuredEntries === 0 ? "none" : "module-config-environment",
    method: configuredEntries === 0 ? "none" : "provider-environment",
    configuredEntries,
    verified: false,
  });
  return Object.freeze([Object.freeze({
    name: "opencode:auth",
    kind: "authentication",
    description: "Report selected OpenCode authentication configuration without exposing credentials.",
    inputSchema,
    run(input, context) {
      if (context.signal.aborted) {
        throw new DOMException("runtime-opencode auth command aborted", "AbortError");
      }
      const action = actionOf(input);
      if (action !== "status") return unsupported(action);
      return Object.freeze({
        provider: "opencode",
        action,
        status: "ok",
        authentication,
      });
    },
  } satisfies ModuleCommand)]);
}
