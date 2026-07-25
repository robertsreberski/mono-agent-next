// SPDX-License-Identifier: MIT
import type {
  SandboxModuleCreateContext,
  SandboxModuleDefinition,
} from "@mono-agent/module-sdk/internal";

import { parseSandboxSrtConfig, sandboxSrtJsonSchema, type SandboxSrtConfig } from "./config.js";
import { openSandboxSrt, type SandboxSrt } from "./sandbox.js";

export {
  parseSandboxSrtConfig,
  sandboxSrtJsonSchema,
  type SandboxSrtConfig,
  type SandboxSrtEnvironmentConfig,
  type SandboxSrtFileConfig,
  type SandboxSrtLimitsConfig,
} from "./config.js";
export { SandboxSrtError, type SandboxSrtErrorCode } from "./errors.js";
export {
  SandboxSrt,
  openSandboxSrt,
  type OpenSandboxSrtOptions,
} from "./sandbox.js";
export { type TrustedFile } from "./security.js";

export const monoAgentModule = Object.freeze({
  manifest: Object.freeze({
    packageName: "@mono-agent/sandbox-srt",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "sandbox",
    responsibility: "Executes selected commands through a fingerprinted fail-closed Sandbox Runtime Tool boundary.",
    capabilities: Object.freeze(["sandbox.execute.srt.v1"]),
  }),
  schema: {
    jsonSchema: sandboxSrtJsonSchema,
    parse: parseSandboxSrtConfig,
  },
  create(context: SandboxModuleCreateContext<SandboxSrtConfig>) {
    return openSandboxSrt({ config: context.config });
  },
}) satisfies SandboxModuleDefinition<SandboxSrtConfig, SandboxSrt>;

export default monoAgentModule;
