import type { ModuleCommand } from "@mono-agent/module-sdk";

import type { RuntimeCodexConfig } from "./config.js";

type AuthAction = "status" | "models" | "login";

const ACTIONS = Object.freeze<AuthAction[]>(["status", "models", "login"]);
const INPUT_ERROR = "runtime-codex auth input must contain only action: status, models, or login";

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
    provider: "codex",
    action,
    status: "unsupported",
    code: action === "models"
      ? "model_discovery_unavailable"
      : "interactive_login_unavailable",
    message: action === "models"
      ? "Codex exposes no bounded non-serving native model catalog."
      : "Interactive Codex login is not available through a non-serving module command.",
  });
}

export function codexAuthCommands(config: RuntimeCodexConfig): readonly ModuleCommand[] {
  const authentication = config.auth === undefined
    ? Object.freeze({
        state: "ambient-unverified",
        source: "native-credential-store",
        method: "native-login",
        verified: false,
      })
    : Object.freeze({
        state: "configured-unverified",
        source: "module-config",
        method: "api-key",
        verified: false,
      });
  return Object.freeze([Object.freeze({
    name: "codex:auth",
    kind: "authentication",
    description: "Report selected Codex authentication configuration without exposing credentials.",
    inputSchema,
    run(input, context) {
      if (context.signal.aborted) {
        throw new DOMException("runtime-codex auth command aborted", "AbortError");
      }
      const action = actionOf(input);
      if (action !== "status") return unsupported(action);
      return Object.freeze({
        provider: "codex",
        action,
        status: "ok",
        authentication,
      });
    },
  } satisfies ModuleCommand)]);
}
