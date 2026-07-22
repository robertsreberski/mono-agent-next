import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveAppArtifactDir, resolveAppSessionsRoot } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";

export interface PurgeSessionsResult {
  /** The resolved sessions root, or undefined when sessions are in-memory only. */
  readonly root?: string;
  /** True when an on-disk sessions store existed and was removed. */
  readonly removed: boolean;
  /** Count of removed `*.jsonl` session files (best-effort; 0 when none/unknown). */
  readonly files: number;
}

export interface PurgeConversationHistoryResult {
  /** The durable conversation-history root beside the configured artifact directory. */
  readonly root: string;
  /** True when an on-disk history store existed and was removed. */
  readonly removed: boolean;
  /** Count of removed `*.history.json` conversation records. */
  readonly files: number;
}

export interface PurgeConversationStateResult {
  readonly sessions: PurgeSessionsResult;
  readonly history: PurgeConversationHistoryResult;
}

/**
 * Remove the durable pi-session store so the next start begins with fresh sessions
 * instead of resuming persisted transcripts. A no-op (`removed: false`) when no
 * on-disk store is configured (in-memory sessions) or the directory does not exist.
 *
 * The runtime recreates the directory on the next session, and the agent's durable
 * memory lives elsewhere (`memory.path`), so this drops only resumable conversation
 * transcripts — not the knowledge base. Stop the worker before calling this so it is
 * not writing sessions while they are deleted.
 */
export async function purgeSessions(input: MonoAgentAppConfigInput): Promise<PurgeSessionsResult> {
  const root = await resolveAppSessionsRoot(input);
  if (root === undefined) {
    return { removed: false, files: 0 };
  }

  let files = 0;
  try {
    files = await countSessionFiles(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      // The store may not exist yet; treat it as nothing to remove.
      return { root, removed: false, files: 0 };
    }
    throw error;
  }

  await rm(root, { recursive: true, force: true });
  return { root, removed: true, files };
}

/**
 * Remove the configured responder's canonical active-conversation history.
 * This root is separate from both run artifacts and `memory.path`; callers must
 * stop the worker first so no history transaction is active during deletion.
 */
export async function purgeConversationHistory(
  input: MonoAgentAppConfigInput,
): Promise<PurgeConversationHistoryResult> {
  const artifactDir = await resolveAppArtifactDir(input);
  const root = join(artifactDir, "..", "history");
  let files = 0;
  try {
    files = await countFilesWithSuffix(root, ".history.json");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { root, removed: false, files: 0 };
    throw error;
  }
  await rm(root, { recursive: true, force: true });
  return { root, removed: true, files };
}

/** Clear every persisted conversation-continuity store while preserving memory and run artifacts. */
export async function purgeConversationState(
  input: MonoAgentAppConfigInput,
): Promise<PurgeConversationStateResult> {
  const sessions = await purgeSessions(input);
  const history = await purgeConversationHistory(input);
  return { sessions, history };
}

/** Recursively count `*.jsonl` session files under a sessions root. */
async function countSessionFiles(dir: string): Promise<number> {
  return await countFilesWithSuffix(dir, ".jsonl");
}

async function countFilesWithSuffix(dir: string, suffix: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countFilesWithSuffix(full, suffix);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      total += 1;
    }
  }
  return total;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
