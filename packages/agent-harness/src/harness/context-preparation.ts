import { assertAgentContinuationOriginContext } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";

import { loadContextFromFiles, loadSkillIndexFromDirectory } from "../context/index.js";
import type {
  BuiltAgentContext,
  ContextBlockInput,
  HistoryMessage,
  SkillIndexEntry,
} from "../context/index.js";
import type { AgentHarnessOptions, AgentHarnessRequest } from "../types.js";
import type { SkillsCache } from "../skills/index.js";
import { AgentHarnessError } from "./error.js";
import { sessionContextBlock } from "./session-context.js";
import { errorMessageText } from "./value-utils.js";

export async function prepareHarnessContext(
  options: AgentHarnessOptions,
  skillsCache: SkillsCache,
  request: AgentHarnessRequest,
  contextOptions: {
    readonly historyMode: "prompt" | "messages" | "omitted";
    readonly turnId: string;
  },
  emit?: (event: RuntimeEventLike) => void,
): Promise<{
  readonly context: BuiltAgentContext;
  readonly memory: ContextBlockInput | undefined;
  readonly skillDisclosureNames: readonly string[];
  readonly history: readonly HistoryMessage[];
  readonly historyOmitted: boolean;
  readonly historyAsMessages: boolean;
}> {
    const history = contextOptions.historyMode === "omitted"
      ? []
      : await loadHarnessHistory(options, request.conversationId, request.continuation);
    // Recalled memory deliberately does NOT go into the system prompt. It rides on
    // the per-turn USER MESSAGE instead (see runRuntime): the user message is the
    // one field every runtime re-sends verbatim each turn, so memory survives
    // session resume even on runtimes that drop the system prompt on a resumed
    // turn (e.g. codex-app sends developerInstructions only on a fresh thread).
    // Keeping it out of the system prompt also leaves that prompt stable across a
    // session, which is better for provider prompt caching.
    const memory = request.continuation === undefined
      ? await loadHarnessMemory(options, request.conversationId, request.userMessage, contextOptions.turnId, emit)
      : undefined;
    const selectedSkills = await loadHarnessSkills(options, skillsCache);
    const context = await loadContextFromFiles({
      identityPath: options.identityPath,
      userMessage: request.userMessage,
      session: sessionContextBlock(request, options.memory !== undefined),
      ...(options.soulPath === undefined ? {} : { soulPath: options.soulPath }),
      ...(history.length === 0 || contextOptions.historyMode !== "prompt" ? {} : { history }),
      ...(options.skillsRoot !== undefined
        ? { skillsRoot: options.skillsRoot }
        : selectedSkills.index.length > 0
          ? { skills: selectedSkills.index }
          : {}),
      ...(options.skillDisclosure === undefined ? {} : { skillDisclosure: options.skillDisclosure }),
      ...(selectedSkills.instructions.length === 0 ? {} : { skillInstructions: selectedSkills.instructions }),
    });
    // Progressive skill disclosure (index mode, opt-in): the index is in the
    // prompt but the bodies are not — so expose a `ReadSkill` tool whose enum is
    // the discovered skill names, letting the agent pull a full body on demand.
    // 'full' mode (the default) keeps today's behavior (selectedSkills bodies
    // inlined up front) and does NOT add ReadSkill. Names load only when a
    // skillsRoot is set.
    const skillDisclosureNames = await loadSkillDisclosureNames(options);
    return {
      context,
      memory,
      skillDisclosureNames,
      history,
      historyOmitted: contextOptions.historyMode === "omitted",
      historyAsMessages: contextOptions.historyMode === "messages",
    };
}

/**
 * Discovers the skill names the ReadSkill tool may load for progressive
 * disclosure. Full disclosure and absent roots deliberately expose no tool.
 */
async function loadSkillDisclosureNames(options: AgentHarnessOptions): Promise<readonly string[]> {
    if ((options.skillDisclosure ?? "full") !== "index" || options.skillsRoot === undefined) {
      return [];
    }
    const entries = await loadSkillIndexFromDirectory(options.skillsRoot);
    return entries.map((entry) => entry.name);
}

export async function loadHarnessHistory(
  options: AgentHarnessOptions,
  conversationId: string,
  continuation?: AgentHarnessRequest["continuation"],
): Promise<readonly HistoryMessage[]> {
    if (continuation?.originContext !== undefined) {
      const snapshot = continuation.originContext;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== conversationId
        || snapshot.originRunId !== continuation.originRunId
        || snapshot.historyBoundary !== continuation.historyBoundary) {
        throw new AgentHarnessError(
          "origin_context_binding_mismatch",
          "The pinned continuation origin context does not match this synthesis turn.",
          { continuationId: continuation.continuationId },
        );
      }
      return snapshot.messages.map((message) => ({ ...message }));
    }
    const history = await options.historyStore?.load(conversationId) ?? [];
    if (continuation === undefined) {
      return history;
    }
    const boundary = continuation.historyBoundary;
    if (boundary === undefined) {
      return history;
    }
    let boundaryIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.runId === boundary) {
        boundaryIndex = index;
        break;
      }
    }
    if (boundaryIndex < 0) {
      throw new AgentHarnessError(
        "history_boundary_not_found",
        "The continuation history boundary is no longer available.",
        { continuationId: continuation.continuationId, historyBoundary: boundary },
      );
    }
    return history.slice(0, boundaryIndex + 1);
}

async function loadHarnessMemory(
  options: AgentHarnessOptions,
  conversationId: string,
  query: string,
  turnId: string,
  emit?: (event: RuntimeEventLike) => void,
): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await options.memory?.load(conversationId, query, { turnId });
    } catch (error) {
      // A slow or failing memory backend (e.g. embeddings timeout / circuit
      // breaker open) must never block or fail the turn — degrade to empty
      // memory and surface a warning so the turn proceeds.
      emit?.({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: `Memory recall failed; continuing without memory. ${errorMessageText(error)}`,
      });
      return undefined;
    }
    if (block === undefined) {
      return undefined;
    }
    // Memory leaves the system-prompt trace once it moves onto the user message, so
    // emit a lightweight diagnostic (source + byte size, not the content) to keep
    // the fact that recall fired — and how much it surfaced — visible in run traces.
    emit?.({
      type: "memory_recalled",
      ...(block.source === undefined ? {} : { source: block.source }),
      bytes: Buffer.byteLength(block.content, "utf8"),
    });
    return {
      kind: "markdown",
      content: block.content,
      source: block.source,
    };
}

async function loadHarnessSkills(
  options: AgentHarnessOptions,
  skillsCache: SkillsCache,
): Promise<{
  readonly index: readonly SkillIndexEntry[];
  readonly instructions: readonly ContextBlockInput[];
}> {
    if (options.selectedSkills === undefined || options.selectedSkills.length === 0) {
      return { index: [], instructions: [] };
    }
    if (options.skillsRoot === undefined) {
      throw new AgentHarnessError("invalid_skill_selection", "selectedSkills requires skillsRoot.");
    }
    return await skillsCache.loadSelectedSkillsCached({
      skillsRoot: options.skillsRoot,
      names: options.selectedSkills,
      ...(options.skillMaxBytes === undefined ? {} : { maxBytes: options.skillMaxBytes }),
    });
}
