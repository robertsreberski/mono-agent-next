import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  StartTurnInput,
  ThreadDetail,
  ThreadSummary,
  WebEvent,
} from "./types";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface ConsoleStoreValue {
  readonly bootstrap: Bootstrap | null;
  readonly agents: readonly AgentSummary[];
  readonly visibleAgents: readonly AgentSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly visibleThreads: readonly ThreadSummary[];
  readonly selectedAgent: AgentSummary | null;
  readonly selectedThread: ThreadSummary | null;
  readonly detail: ThreadDetail | null;
  readonly selectedAgentId: string | null;
  readonly selectedThreadId: string | null;
  readonly loading: boolean;
  readonly detailLoading: boolean;
  readonly error: string | null;
  readonly actionError: string | null;
  readonly connection: ConnectionState;
  readonly showArchived: boolean;
  readonly showOfflineAgents: boolean;
  readonly hiddenOfflineAgentCount: number;
  readonly model: string;
  readonly effort: string;
  readonly modelOptions: readonly string[];
  readonly effortOptions: readonly string[];
  readonly selectAgent: (sourceId: string) => void;
  readonly setAgentPinned: (sourceId: string, pinned: boolean) => Promise<void>;
  readonly selectThread: (threadId: string) => void;
  readonly createThread: () => Promise<ThreadSummary>;
  readonly renameThread: (threadId: string, title: string) => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<void>;
  readonly unarchiveThread: (threadId: string) => Promise<void>;
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly sendTurn: (
    input: StartTurnInput,
    onThreadResolved?: (threadId: string) => void,
  ) => Promise<void>;
  readonly sendLiveInput: (text: string) => Promise<void>;
  readonly cancelTurn: () => Promise<void>;
  readonly setShowArchived: (show: boolean) => void;
  readonly setShowOfflineAgents: (show: boolean) => void;
  readonly setModel: (model: string) => void;
  readonly setEffort: (effort: string) => void;
  readonly retry: () => void;
  readonly clearActionError: () => void;
}

const ConsoleStore = createContext<ConsoleStoreValue | null>(null);

const byMostRecent = (a: ThreadSummary, b: ThreadSummary) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

export const SELECTED_AGENT_STORAGE_KEY = "mono-agent.web.selected-agent";
export const SELECTED_THREADS_STORAGE_KEY = "mono-agent.web.selected-threads";
export const RUN_PREFERENCES_STORAGE_KEY = "mono-agent.web.run-preferences";
export const preferenceKeyForThread = (sourceId: string, threadId: string | null): string =>
  JSON.stringify([sourceId, threadId ?? "new"]);

export interface StoredRunPreference {
  readonly model: string;
  readonly effort: string;
}

const asciiNoCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );

export const sortAgentsPinnedFirst = (
  agents: readonly AgentSummary[],
): readonly AgentSummary[] => [...agents].sort((left, right) => {
  const pinOrder = Number(right.pinned) - Number(left.pinned);
  if (pinOrder !== 0) return pinOrder;
  // SQLite NOCASE folds ASCII only. Keep optimistic ordering identical to the
  // authoritative store so a refresh never makes international labels jump.
  const leftLabel = asciiNoCase(left.label);
  const rightLabel = asciiNoCase(right.label);
  if (leftLabel < rightLabel) return -1;
  if (leftLabel > rightLabel) return 1;
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
});

export const agentVisibility = (
  agents: readonly AgentSummary[],
  selectedAgentId: string | null,
  showOfflineAgents: boolean,
): {
  readonly visibleAgents: readonly AgentSummary[];
  readonly hiddenOfflineAgentCount: number;
} => {
  const hiddenIds = new Set(agents.flatMap((agent) =>
    agent.status === "offline" && !agent.pinned && agent.sourceId !== selectedAgentId
      ? [agent.sourceId]
      : [],
  ));
  return {
    visibleAgents: showOfflineAgents
      ? agents
      : agents.filter((agent) => !hiddenIds.has(agent.sourceId)),
    hiddenOfflineAgentCount: hiddenIds.size,
  };
};

export const readStoredRunPreferences = (): Record<string, StoredRunPreference> => {
  try {
    const stored = JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const candidate = value as { model?: unknown; effort?: unknown };
        if (typeof candidate.model !== "string" || typeof candidate.effort !== "string") return [];
        return [[key, { model: candidate.model, effort: candidate.effort }]];
      }),
    );
  } catch {
    return {};
  }
};

const readPersistedThreadIds = (): Record<string, string> => {
  try {
    const stored = JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

const persistThreadId = (sourceId: string, threadId: string | null): void => {
  const selections = readPersistedThreadIds();
  if (threadId) selections[sourceId] = threadId;
  else delete selections[sourceId];
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify(selections));
};

export const resolveBootstrapSelection = (
  next: Bootstrap,
  selectedAgentId: string | null,
  selectedThreadId: string | null,
  persistedThreadIds: Readonly<Record<string, string>> = {},
): { readonly agentId: string | null; readonly threadId: string | null } => {
  const currentAgent = next.agents.find((agent) => agent.sourceId === selectedAgentId);
  const agentId =
    currentAgent?.sourceId ??
    next.agents.find((agent) => agent.status !== "offline")?.sourceId ??
    next.agents[0]?.sourceId ??
    null;
  const currentThread = next.threads.find(
    (thread) => thread.id === selectedThreadId && thread.sourceId === agentId,
  );
  const persistedThread = next.threads.find(
    (thread) =>
      thread.id === persistedThreadIds[agentId ?? ""] &&
      thread.sourceId === agentId &&
      !thread.archivedAt,
  );
  const thread =
    currentThread ??
    persistedThread ??
    [...next.threads]
      .filter((candidate) => candidate.sourceId === agentId && !candidate.archivedAt)
      .sort(byMostRecent)[0];
  return { agentId, threadId: thread?.id ?? null };
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The web console request failed.";

export const GLOBAL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const effortLevelsForAgentModel = (
  agent: AgentSummary | null,
  model: string,
): readonly string[] => {
  if (!agent) return [];
  const option = agent.modelOptions?.[model];
  if (!option) return agent.efforts ?? [];
  if (
    option.reasoning === false ||
    option.reasoningMode === "none" ||
    option.effortLevels?.length === 0
  ) {
    return [];
  }
  if (option.reasoningMode === "toggle") return ["high", "none"];
  return option.effortLevels ?? GLOBAL_EFFORT_LEVELS;
};

export const validateRunPreference = (
  agent: AgentSummary | null,
  preference: StoredRunPreference,
): StoredRunPreference => {
  if (!agent) return { model: "", effort: "" };
  const model = preference.model && agent.models?.includes(preference.model)
    ? preference.model
    : "";
  const effectiveModel = model || agent.defaultModel || agent.models?.[0] || "";
  const efforts = effortLevelsForAgentModel(agent, effectiveModel);
  return {
    model,
    effort: preference.effort && efforts.includes(preference.effort)
      ? preference.effort
      : "",
  };
};

export function ConsoleStoreProvider({ children }: { readonly children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_AGENT_STORAGE_KEY),
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [showArchived, setShowArchived] = useState(false);
  const [showOfflineAgents, setShowOfflineAgents] = useState(false);
  const [modelByContext, setModelByContext] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(readStoredRunPreferences()).map(([key, value]) => [key, value.model]),
    ),
  );
  const [effortByContext, setEffortByContext] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(readStoredRunPreferences()).map(([key, value]) => [key, value.effort]),
    ),
  );
  const selectedThreadRef = useRef<string | null>(null);
  const selectedAgentRef = useRef<string | null>(selectedAgentId);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const queueRefreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const keys = new Set([...Object.keys(modelByContext), ...Object.keys(effortByContext)]);
    const stored = Object.fromEntries(
      [...keys].flatMap((key) => {
        const preference = {
          model: modelByContext[key] ?? "",
          effort: effortByContext[key] ?? "",
        };
        return preference.model || preference.effort ? [[key, preference]] : [];
      }),
    );
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
  }, [effortByContext, modelByContext]);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgentId;
  }, [selectedAgentId]);

  const applyBootstrap = useCallback((next: Bootstrap) => {
    setBootstrap(next);
    setError(null);
    setLoading(false);
    const selection = resolveBootstrapSelection(
      next,
      selectedAgentRef.current,
      selectedThreadRef.current,
      readPersistedThreadIds(),
    );
    selectedAgentRef.current = selection.agentId;
    selectedThreadRef.current = selection.threadId;
    setSelectedAgentId(selection.agentId);
    setSelectedThreadId(selection.threadId);
    if (selection.agentId) {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, selection.agentId);
      const selected = next.threads.find((thread) => thread.id === selection.threadId);
      persistThreadId(
        selection.agentId,
        selected && !selected.archivedAt ? selected.id : null,
      );
    }
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      const next = await api.bootstrap();
      applyBootstrap(next);
      setConnection("live");
    } catch (loadError) {
      setError(errorMessage(loadError));
      setLoading(false);
      setConnection(navigator.onLine ? "reconnecting" : "offline");
    }
  }, [applyBootstrap]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const loadThread = useCallback(async (threadId: string, signal: AbortSignal) => {
    setDetailLoading(true);
    try {
      const next = await api.thread(threadId, signal);
      if (selectedThreadRef.current === threadId) setDetail(next);
    } catch (loadError) {
      if (!signal.aborted) setActionError(errorMessage(loadError));
    } finally {
      if (selectedThreadRef.current === threadId) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail((current) => (current?.thread.id === selectedThreadId ? current : null));
    const controller = new AbortController();
    void loadThread(selectedThreadId, controller.signal);
    return () => controller.abort();
  }, [loadThread, selectedThreadId]);

  const refreshNow = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const [nextBootstrap, nextDetail] = await Promise.all([
        api.bootstrap(),
        selectedThreadRef.current ? api.thread(selectedThreadRef.current) : Promise.resolve(null),
      ]);
      applyBootstrap(nextBootstrap);
      if (nextDetail && selectedThreadRef.current === nextDetail.thread.id) setDetail(nextDetail);
    } catch (refreshError) {
      setActionError(errorMessage(refreshError));
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        queueRefreshRef.current();
      }
    }
  }, [applyBootstrap]);

  const queueRefresh = useCallback(() => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshNow();
    }, 300);
  }, [refreshNow]);
  queueRefreshRef.current = queueRefresh;

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    const handleEvent = (event: Event) => {
      try {
        const webEvent = JSON.parse((event as MessageEvent<string>).data) as WebEvent;
        if (webEvent.version !== 1) return;
      } catch {
        // A ready ping without JSON still proves the stream is alive.
      }
      setConnection("live");
      queueRefresh();
    };
    const eventTypes: WebEvent["type"][] = [
      "ready",
      "agents.changed",
      "threads.changed",
      "thread.changed",
      "message.changed",
      "turn.changed",
      "attachment.changed",
    ];
    events.onopen = () => setConnection("live");
    events.onmessage = handleEvent;
    for (const type of eventTypes) events.addEventListener(type, handleEvent);
    events.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    const onOnline = () => {
      setConnection("reconnecting");
      queueRefresh();
    };
    const onOffline = () => setConnection("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      events.close();
      for (const type of eventTypes) events.removeEventListener(type, handleEvent);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, [queueRefresh]);

  const agents = useMemo(
    () => sortAgentsPinnedFirst(bootstrap?.agents ?? []),
    [bootstrap?.agents],
  );
  const threads = bootstrap?.threads ?? [];
  const selectedAgent =
    agents.find((agent) => agent.sourceId === selectedAgentId) ?? null;
  const { visibleAgents, hiddenOfflineAgentCount } = useMemo(
    () => agentVisibility(agents, selectedAgentId, showOfflineAgents),
    [agents, selectedAgentId, showOfflineAgents],
  );
  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? detail?.thread ?? null;
  const visibleThreads = useMemo(
    () =>
      [...threads]
        .filter(
          (thread) =>
            thread.sourceId === selectedAgentId && Boolean(thread.archivedAt) === showArchived,
        )
        .sort(byMostRecent),
    [selectedAgentId, showArchived, threads],
  );

  const selectAgent = useCallback(
    (sourceId: string) => {
      selectedAgentRef.current = sourceId;
      setSelectedAgentId(sourceId);
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, sourceId);
      const persistedId = readPersistedThreadIds()[sourceId];
      const persisted = threads.find(
        (thread) =>
          thread.id === persistedId && thread.sourceId === sourceId && !thread.archivedAt,
      );
      const recent = persisted ?? [...threads]
        .filter((thread) => thread.sourceId === sourceId && !thread.archivedAt)
        .sort(byMostRecent)[0];
      selectedThreadRef.current = recent?.id ?? null;
      setSelectedThreadId(recent?.id ?? null);
      persistThreadId(sourceId, recent?.id ?? null);
      setShowArchived(false);
      setActionError(null);
    },
    [threads],
  );

  const setAgentPinned = useCallback(async (sourceId: string, pinned: boolean) => {
    try {
      const agent = await api.patchAgent(sourceId, pinned);
      setBootstrap((current) => current
        ? {
            ...current,
            agents: sortAgentsPinnedFirst(
              current.agents.map((item) => item.sourceId === sourceId
                ? { ...item, pinned: agent.pinned }
                : item),
            ),
          }
        : current);
      setActionError(null);
      queueRefresh();
    } catch (pinError) {
      setActionError(errorMessage(pinError));
      throw pinError;
    }
  }, [queueRefresh]);

  const selectThread = useCallback(
    (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        selectedAgentRef.current = thread.sourceId;
        setSelectedAgentId(thread.sourceId);
        localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, thread.sourceId);
        if (!thread.archivedAt) persistThreadId(thread.sourceId, thread.id);
      }
      selectedThreadRef.current = threadId;
      setSelectedThreadId(threadId);
      setActionError(null);
    },
    [threads],
  );

  const createThread = useCallback(async () => {
    if (!selectedAgentId) throw new Error("Select an agent before starting a conversation.");
    try {
      const thread = await api.createThread(selectedAgentId);
      const draftPreferenceKey = preferenceKeyForThread(selectedAgentId, null);
      const threadPreferenceKey = preferenceKeyForThread(selectedAgentId, thread.id);
      setModelByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current, [threadPreferenceKey]: current[draftPreferenceKey] ?? "" };
        delete next[draftPreferenceKey];
        return next;
      });
      setEffortByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current, [threadPreferenceKey]: current[draftPreferenceKey] ?? "" };
        delete next[draftPreferenceKey];
        return next;
      });
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(selectedAgentId, thread.id);
      setShowArchived(false);
      setBootstrap((current) =>
        current ? { ...current, threads: [thread, ...current.threads] } : current,
      );
      setDetail({ thread, messages: [] });
      setActionError(null);
      return thread;
    } catch (createError) {
      setActionError(errorMessage(createError));
      throw createError;
    }
  }, [selectedAgentId]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const thread = await api.patchThread(threadId, { title: trimmed });
      setBootstrap((current) =>
        current
          ? {
              ...current,
              threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
            }
          : current,
      );
      setDetail((current) =>
        current?.thread.id === thread.id ? { ...current, thread } : current,
      );
    } catch (renameError) {
      setActionError(errorMessage(renameError));
      throw renameError;
    }
  }, []);

  const archiveThread = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.patchThread(threadId, { archived: true });
        setBootstrap((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
              }
            : current,
        );
        if (selectedThreadRef.current === threadId) {
          const replacement = visibleThreads.find((item) => item.id !== threadId);
          selectedThreadRef.current = replacement?.id ?? null;
          setSelectedThreadId(replacement?.id ?? null);
          persistThreadId(thread.sourceId, replacement?.id ?? null);
        } else if (readPersistedThreadIds()[thread.sourceId] === threadId) {
          persistThreadId(thread.sourceId, null);
        }
      } catch (archiveError) {
        setActionError(errorMessage(archiveError));
        throw archiveError;
      }
    },
    [visibleThreads],
  );

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      const thread = await api.patchThread(threadId, { archived: false });
      setBootstrap((current) =>
        current
          ? {
              ...current,
              threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
            }
          : current,
      );
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(thread.sourceId, thread.id);
      setShowArchived(false);
    } catch (unarchiveError) {
      setActionError(errorMessage(unarchiveError));
      throw unarchiveError;
    }
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    try {
      await api.deleteThread(threadId);
      const preferenceKey = preferenceKeyForThread(thread.sourceId, threadId);
      setModelByContext((current) => {
        const next = { ...current };
        delete next[preferenceKey];
        return next;
      });
      setEffortByContext((current) => {
        const next = { ...current };
        delete next[preferenceKey];
        return next;
      });
      setBootstrap((current) => current
        ? { ...current, threads: current.threads.filter((item) => item.id !== threadId) }
        : current);
      if (selectedThreadRef.current === threadId) {
        const replacement = visibleThreads.find((item) => item.id !== threadId);
        selectedThreadRef.current = replacement?.id ?? null;
        setSelectedThreadId(replacement?.id ?? null);
        setDetail(null);
      }
      if (readPersistedThreadIds()[thread.sourceId] === threadId) {
        persistThreadId(thread.sourceId, null);
      }
      setActionError(null);
    } catch (deleteError) {
      setActionError(errorMessage(deleteError));
      throw deleteError;
    }
  }, [threads, visibleThreads]);

  const modelOptions = selectedAgent?.models ?? [];
  const preferenceKey = selectedAgentId
    ? preferenceKeyForThread(selectedAgentId, selectedThreadId)
    : "";
  const storedPreference = {
    model: modelByContext[preferenceKey] ?? "",
    effort: effortByContext[preferenceKey] ?? "",
  };
  const validatedPreference = validateRunPreference(selectedAgent, storedPreference);
  const model = validatedPreference.model;
  const effectiveModel = selectedAgent
    ? model || selectedAgent.defaultModel || modelOptions[0] || ""
    : "";
  const effortOptions = effortLevelsForAgentModel(selectedAgent, effectiveModel);
  const effort = validatedPreference.effort;

  useEffect(() => {
    if (!preferenceKey) return;
    if (storedPreference.model !== validatedPreference.model) {
      setModelByContext((current) => ({
        ...current,
        [preferenceKey]: validatedPreference.model,
      }));
    }
    if (storedPreference.effort !== validatedPreference.effort) {
      setEffortByContext((current) => ({
        ...current,
        [preferenceKey]: validatedPreference.effort,
      }));
    }
  }, [
    preferenceKey,
    storedPreference.effort,
    storedPreference.model,
    validatedPreference.effort,
    validatedPreference.model,
  ]);

  const setModel = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      setModelByContext((current) => ({ ...current, [preferenceKey]: next }));
      const nextEffectiveModel =
        next || selectedAgent?.defaultModel || selectedAgent?.models?.[0] || "";
      const nextEfforts = effortLevelsForAgentModel(selectedAgent, nextEffectiveModel);
      setEffortByContext((current) => ({
        ...current,
        [preferenceKey]: nextEfforts.includes(current[preferenceKey] ?? "")
          ? (current[preferenceKey] ?? "")
          : "",
      }));
    },
    [preferenceKey, selectedAgent, selectedAgentId],
  );

  const setEffort = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      setEffortByContext((current) => ({ ...current, [preferenceKey]: next }));
    },
    [preferenceKey, selectedAgentId],
  );

  const sendTurn = useCallback(
    async (input: StartTurnInput, onThreadResolved?: (threadId: string) => void) => {
      let thread = selectedThread;
      if (!thread) thread = await createThread();
      if (thread.archivedAt) throw new Error("Unarchive this conversation before sending.");
      onThreadResolved?.(thread.id);
      try {
        const result = await api.startTurn(thread.id, {
          ...input,
        });
        setBootstrap((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((item) =>
                  item.id === result.thread.id ? result.thread : item,
                ),
              }
            : current,
        );
        setDetail((current) =>
          current?.thread.id === result.thread.id
            ? { ...current, thread: result.thread }
            : current,
        );
        setActionError(null);
        queueRefresh();
      } catch (turnError) {
        setActionError(errorMessage(turnError));
        throw turnError;
      }
    },
    [createThread, queueRefresh, selectedThread],
  );

  const cancelTurn = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      const result = await api.cancelTurn(selectedThreadId);
      setDetail((current) =>
        current?.thread.id === result.thread.id ? { ...current, thread: result.thread } : current,
      );
      queueRefresh();
    } catch (cancelError) {
      setActionError(errorMessage(cancelError));
      throw cancelError;
    }
  }, [queueRefresh, selectedThreadId]);

  const sendLiveInput = useCallback(async (text: string) => {
    if (!selectedThreadId) throw new Error("Select a conversation before sending a follow-up.");
    try {
      const receipt = await api.liveInput(selectedThreadId, text);
      setDetail((current) => {
        if (current?.thread.id !== selectedThreadId) return current;
        const exists = current.messages.some((message) => message.id === receipt.message.id);
        return {
          ...current,
          messages: exists
            ? current.messages.map((message) => message.id === receipt.message.id ? receipt.message : message)
            : [...current.messages, receipt.message],
        };
      });
      setActionError(null);
      queueRefresh();
    } catch (liveInputError) {
      setActionError(errorMessage(liveInputError));
      throw liveInputError;
    }
  }, [queueRefresh, selectedThreadId]);

  const value = useMemo<ConsoleStoreValue>(
    () => ({
      bootstrap,
      agents,
      visibleAgents,
      threads,
      visibleThreads,
      selectedAgent,
      selectedThread,
      detail,
      selectedAgentId,
      selectedThreadId,
      loading,
      detailLoading,
      error,
      actionError,
      connection,
      showArchived,
      showOfflineAgents,
      hiddenOfflineAgentCount,
      model,
      effort,
      modelOptions,
      effortOptions,
      selectAgent,
      setAgentPinned,
      selectThread,
      createThread,
      renameThread,
      archiveThread,
      unarchiveThread,
      deleteThread,
      sendTurn,
      sendLiveInput,
      cancelTurn,
      setShowArchived,
      setShowOfflineAgents,
      setModel,
      setEffort,
      retry: () => {
        setLoading(true);
        setError(null);
        void loadBootstrap();
      },
      clearActionError: () => setActionError(null),
    }),
    [
      actionError,
      agents,
      archiveThread,
      bootstrap,
      cancelTurn,
      connection,
      createThread,
      detail,
      detailLoading,
      deleteThread,
      effort,
      effortOptions,
      error,
      hiddenOfflineAgentCount,
      loadBootstrap,
      loading,
      model,
      modelOptions,
      renameThread,
      selectAgent,
      selectThread,
      selectedAgent,
      selectedAgentId,
      selectedThread,
      selectedThreadId,
      sendTurn,
      sendLiveInput,
      setEffort,
      setAgentPinned,
      setModel,
      showArchived,
      showOfflineAgents,
      threads,
      unarchiveThread,
      visibleAgents,
      visibleThreads,
    ],
  );

  return <ConsoleStore.Provider value={value}>{children}</ConsoleStore.Provider>;
}

export function useConsoleStore(): ConsoleStoreValue {
  const value = useContext(ConsoleStore);
  if (!value) throw new Error("useConsoleStore must be used inside ConsoleStoreProvider.");
  return value;
}

export const useUploadLimits = () =>
  useConsoleStore().bootstrap?.limits ?? DEFAULT_UPLOAD_LIMITS;
