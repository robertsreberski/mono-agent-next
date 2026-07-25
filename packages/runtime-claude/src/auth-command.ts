// SPDX-License-Identifier: MIT
import type { ModuleCommand } from "@mono-agent/module-sdk";

import type { RuntimeClaudeConfig } from "./config.js";

type AuthAction = "status" | "models" | "login";

const ACTIONS = Object.freeze<AuthAction[]>(["status", "models", "login"]);
const INPUT_ERROR = "runtime-claude auth input must contain only action: status, models, or login";

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
    provider: "claude",
    action,
    status: "unsupported",
    code: action === "models"
      ? "model_discovery_unavailable"
      : "interactive_login_unavailable",
    message: action === "models"
      ? "Claude exposes no bounded noninteractive native model catalog."
      : "Interactive Claude login is not available through a non-serving module command.",
  });
}

export function claudeAuthCommands(config: RuntimeClaudeConfig): readonly ModuleCommand[] {
  const authentication = config.auth === undefined
    ? Object.freeze({
        state: "ambient-unverified",
        source: "native-credential-store",
        method: "native",
        verified: false,
      })
    : Object.freeze({
        state: "configured-unverified",
        source: "module-config",
        method: config.auth.method,
        verified: false,
      });
  return Object.freeze([Object.freeze({
    name: "claude:auth",
    kind: "authentication",
    description: "Report selected Claude authentication configuration without exposing credentials.",
    inputSchema,
    run(input, context) {
      if (context.signal.aborted) {
        throw new DOMException("runtime-claude auth command aborted", "AbortError");
      }
      const action = actionOf(input);
      if (action !== "status") return unsupported(action);
      return Object.freeze({
        provider: "claude",
        action,
        status: "ok",
        authentication,
      });
    },
  } satisfies ModuleCommand)]);
}
