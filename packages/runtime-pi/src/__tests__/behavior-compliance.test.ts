// SPDX-License-Identifier: MIT
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  assertRuntimeBehaviorCompliance,
  type RuntimeBehaviorScenario,
} from "@mono-agent/module-sdk/testing";
import { describe, expect, it } from "vitest";

import { parseRuntimePiConfig } from "../config.js";
import { createRuntimePi } from "../runtime.js";

const MODEL = "faux:faux-model";
const SECRET = "runtime-pi-behavior-secret";

function waitForActive(
  active: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(
      signal.reason
        ?? new DOMException("Runtime behavior wait aborted", "AbortError"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([active, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

describe("runtime-pi behavior compliance", () => {
  it("satisfies the shared in-process runtime behavior contract", async () => {
    await expect(assertRuntimeBehaviorCompliance({
      profile: "in-process",
      secrets: [SECRET],
      timeoutMs: 5_000,
      async create(
        scenario: RuntimeBehaviorScenario,
        signal: AbortSignal,
      ) {
        signal.throwIfAborted();
        const root = await mkdtemp(join(tmpdir(), "runtime-pi-behavior-"));
        const configDirectory = join(root, "config");
        const workspaceDirectory = join(root, "workspace");
        const sessionsRoot = join(configDirectory, "sessions");
        const authPath = join(configDirectory, "auth.json");

        try {
          await Promise.all([
            mkdir(configDirectory, { mode: 0o700 }),
            mkdir(workspaceDirectory, { mode: 0o700 }),
          ]);
          await chmod(configDirectory, 0o700);
          await chmod(workspaceDirectory, 0o700);
          await mkdir(sessionsRoot, { mode: 0o700 });
          await chmod(sessionsRoot, 0o700);
          await writeFile(
            authPath,
            `${JSON.stringify({
              faux: { type: "api_key", key: SECRET },
            })}\n`,
            { mode: 0o600 },
          );
          await chmod(authPath, 0o600);

          let resolveActive!: () => void;
          const active = new Promise<void>((resolve) => {
            resolveActive = resolve;
          });
          const faux = fauxProvider({
            provider: "faux",
            models: [{ id: "faux-model", input: ["text"] }],
          });
          if (scenario.kind === "completed") {
            faux.setResponses([
              () => {
                resolveActive();
                return fauxAssistantMessage([
                  fauxToolCall("RuntimeComplianceTool", {}, {
                    id: "runtime-compliance-call",
                  }),
                ]);
              },
              fauxAssistantMessage([fauxText(scenario.marker)]),
            ]);
          } else if (scenario.kind === "cancelled") {
            faux.setResponses([
              (_context, streamOptions) => {
                resolveActive();
                return new Promise((resolve) => {
                  const settleAborted = () => {
                    resolve(fauxAssistantMessage([], {
                      stopReason: "aborted",
                      errorMessage: "runtime behavior request aborted",
                    }));
                  };
                  if (streamOptions?.signal?.aborted === true) {
                    settleAborted();
                  } else {
                    streamOptions?.signal?.addEventListener(
                      "abort",
                      settleAborted,
                      { once: true },
                    );
                  }
                });
              },
            ]);
          } else {
            throw new Error(
              `runtime-pi cannot exercise process scenario ${scenario.kind}`,
            );
          }

          const models = createModels();
          models.setProvider(faux.provider);
          const runtime = createRuntimePi({
            config: parseRuntimePiConfig({
              auth: { path: authPath },
              sessions: { root: sessionsRoot },
            }),
            instanceId: `runtime-pi-behavior-${scenario.kind}`,
            configDirectory,
            workspaceDirectory,
            models,
          });

          return {
            instance: runtime,
            model: MODEL,
            waitUntilActive(waitSignal: AbortSignal) {
              return waitForActive(active, waitSignal);
            },
            async observe(observeSignal: AbortSignal) {
              observeSignal.throwIfAborted();
              const health = await runtime.health?.({
                signal: observeSignal,
              });
              const activeTurns = health?.details?.activeTurns;
              if (typeof activeTurns !== "number") {
                throw new Error(
                  "runtime-pi behavior health omitted numeric activeTurns",
                );
              }
              return { activeProviderOperations: activeTurns };
            },
            async dispose() {
              try {
                await runtime.stop?.({
                  signal: AbortSignal.timeout(1_000),
                  reason: "shutdown",
                });
              } catch {
                // The compliance helper owns lifecycle assertions. Disposal
                // still removes private test state after a failed assertion.
              }
              await rm(root, { recursive: true, force: true });
            },
          };
        } catch (error) {
          await rm(root, { recursive: true, force: true });
          throw error;
        }
      },
    })).resolves.toBeUndefined();
  });
});
