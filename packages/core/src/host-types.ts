// SPDX-License-Identifier: MIT
import type {
  Channel, ChannelSendTool, ModuleInstance, ModuleToolContribution,
} from "@mono-agent/module-sdk";
import type { CoreRuntimeTool } from "./mcp.js";
import type { AgentTranscriptContentPart, AgentTranscriptEntry, LoadedAgentModule } from "./types.js";
export const DEFAULT_INSTRUCTION_BYTES = 1_000_000, DEFAULT_MESSAGE_BYTES = 1_000_000;
export const DEFAULT_MAX_ATTACHMENTS = 10, DEFAULT_ATTACHMENT_BYTES = 25_000_000;
export const DEFAULT_TOTAL_ATTACHMENT_BYTES = 50_000_000;
export const SUBMIT_SNAPSHOT_MAX_ITEMS = 20_000, SUBMIT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SUBMIT_SNAPSHOT_MAX_DEPTH = 64;
export const CACHED_RESPONSE_MAX_BYTES = 8 * 1024 * 1024, MAX_TRANSCRIPT_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_CONFIGURED_SKILLS = 256, MAX_SKILL_ROOT_ENTRIES = 1_024;
export const ASK_USER_TOOL_NAME = "AskUser", MEMORY_RECALL_TOOL_NAME = "MemoryRecall";
export const MODULE_TOOL_CALL_TIMEOUT_MS = 120_000;
export type SessionDisposition = "retain" | "isolate" | "evict";
export interface RunningModule { readonly loaded: LoadedAgentModule; readonly instance: ModuleInstance }
export type VerbatimEntry = Extract<AgentTranscriptEntry, { readonly kind: "verbatim" }>;
export interface BoundChannelTool { readonly instanceId: string; readonly channel: Channel; readonly name: string; readonly tool: ChannelSendTool }
export interface BoundModuleTool {
  readonly loaded: LoadedAgentModule;
  readonly name: string;
  readonly tool: ModuleToolContribution;
}
export interface AmbiguousToolAlias {
  readonly alias: string;
  readonly canonicalNames: readonly string[];
}
export interface TranscriptArtifactDraft { readonly kind: "pending-artifact"; readonly slot: string; readonly name?: string }
export type TranscriptContentDraft = AgentTranscriptContentPart | TranscriptArtifactDraft;
export interface LoadedInstructions { readonly text: string; readonly tools: readonly CoreRuntimeTool[] }
