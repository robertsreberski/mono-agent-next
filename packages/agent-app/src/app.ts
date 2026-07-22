/**
 * Stable config-first host surface.
 *
 * The controller implementation lives in `app-controller.ts`; consumers keep
 * importing `./app.js` while lifecycle collaborators are extracted behind this
 * boundary in focused, behavior-preserving changes.
 */
export { startMonoAgentApp } from "./app-controller.js";
export type {
  ConfigApplyResult,
  ExporterStatus,
  MonoAgentApp,
  MonoAgentAppOptions,
  SandboxStatus,
  TraceabilityStatus,
} from "./app-controller.js";
