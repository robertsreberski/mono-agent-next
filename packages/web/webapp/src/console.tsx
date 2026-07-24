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

import { api, ApiError, readToken, saveToken, streamTurn, subscribeEvents } from "./api";
import { responseNotifications, showBackgroundNotification } from "./notifications";
import type {
  Agent,
  Attachment,
  Bootstrap,
  Quote,
  StartTurnInput,
  Thread,
  ThreadDetail,
} from "./types";

const OFFLINE_KEY = "mono-agent-web-show-offline";
const ARCHIVE_KEY = "mono-agent-web-show-archived";
const RAIL_KEY = "mono-agent-web-agent-rail";

interface ConsoleState {
  readonly authenticated: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error?: string;
  readonly bootstrap?: Bootstrap;
  readonly detail?: ThreadDetail;
  readonly selectedAgentId?: string;
  readonly selectedThreadId?: string;
  readonly selectedAgent?: Agent;
  readonly selectedThread?: Thread;
  readonly visibleAgents: readonly Agent[];
  readonly visibleThreads: readonly Thread[];
  readonly hiddenOfflineCount: number;
  readonly showOffline: boolean;
  readonly showArchived: boolean;
  readonly railExpanded: boolean;
  readonly pendingFiles: readonly File[];
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  login(token: string): Promise<void>;
  logout(): void;
  retry(): Promise<void>;
  selectAgent(agentId: string): void;
  selectThread(threadId: string): void;
  createThread(): Promise<void>;
  patchAgent(agentId: string, pinned: boolean): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  archiveThread(threadId: string, archived: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  cancel(): Promise<void>;
  answerAsk(answers: Readonly<Record<string, readonly string[]>>): Promise<void>;
  send(input: Omit<StartTurnInput, "attachments" | "quote">, quote?: Quote): Promise<void>;
  setShowOffline(value: boolean): void;
  setShowArchived(value: boolean): void;
  setRailExpanded(value: boolean): void;
  addFiles(files: FileList | readonly File[]): void;
  removeFile(index: number): void;
  setRuntime(value: string): void;
  setModel(value: string): void;
  setEffort(value: string): void;
}

const ConsoleContext = createContext<ConsoleState | undefined>(undefined);

export function ConsoleProvider({ children }: { readonly children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(readToken().length > 0);
  const [loading, setLoading] = useState(readToken().length > 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [detail, setDetail] = useState<ThreadDetail>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [showOffline, setShowOfflineState] = useState(window.localStorage.getItem(OFFLINE_KEY) === "true");
  const [showArchived, setShowArchivedState] = useState(window.localStorage.getItem(ARCHIVE_KEY) === "true");
  const [railExpanded, setRailExpandedState] = useState(window.localStorage.getItem(RAIL_KEY) === "expanded");
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([]);
  const [runtime, setRuntime] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const bootstrapRef = useRef<Bootstrap | undefined>(undefined);
  const selectedAgentRef = useRef<string | undefined>(undefined);
  const selectedThreadRef = useRef<string | undefined>(undefined);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const pendingFilesRef = useRef<readonly File[]>(pendingFiles);

  bootstrapRef.current = bootstrap;
  selectedAgentRef.current = selectedAgentId;
  selectedThreadRef.current = selectedThreadId;
  pendingFilesRef.current = pendingFiles;

  const chooseSelection = useCallback((next: Bootstrap): {
    readonly agentId?: string;
    readonly threadId?: string;
  } => {
    const requested = new URLSearchParams(window.location.search).get("thread") ?? undefined;
    const existingThread = next.threads.find((thread) =>
      thread.id === (requested ?? selectedThreadRef.current)
    );
    const currentAgent = next.agents.find((agent) => agent.id === selectedAgentRef.current);
    const agentId = existingThread?.agentId
      ?? currentAgent?.id
      ?? next.agents.find((agent) => agent.online || agent.pinned)?.id
      ?? next.agents[0]?.id;
    const threadId = existingThread?.id
      ?? next.threads.find((thread) =>
        thread.agentId === agentId && thread.archivedAt === undefined
      )?.id;
    return { ...(agentId === undefined ? {} : { agentId }), ...(threadId === undefined ? {} : { threadId }) };
  }, []);

  const load = useCallback(async (initial = false): Promise<void> => {
    if (!readToken()) return;
    if (!initial) setRefreshing(true);
    try {
      const next = await api.bootstrap();
      for (const payload of responseNotifications(bootstrapRef.current?.threads ?? [], next)) {
        void showBackgroundNotification(payload);
      }
      const selection = chooseSelection(next);
      const nextDetail = selection.threadId === undefined
        ? undefined
        : await api.thread(selection.threadId);
      bootstrapRef.current = next;
      selectedAgentRef.current = selection.agentId;
      selectedThreadRef.current = selection.threadId;
      setBootstrap(next);
      setSelectedAgentId(selection.agentId);
      setSelectedThreadId(selection.threadId);
      setDetail(nextDetail);
      const browserUrl = new URL(window.location.href);
      if (selection.threadId === undefined) browserUrl.searchParams.delete("thread");
      else browserUrl.searchParams.set("thread", selection.threadId);
      history.replaceState(null, "", browserUrl);
      setRuntime(next.agents.find((agent) => agent.id === selection.agentId)?.defaults?.runtime ?? "");
      setModel((current) => current || next.agents.find((agent) => agent.id === selection.agentId)?.defaults?.model || "");
      setEffort((current) => current || next.agents.find((agent) => agent.id === selection.agentId)?.defaults?.effort || "");
      setError(undefined);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        saveToken("");
        setAuthenticated(false);
        setBootstrap(undefined);
        setDetail(undefined);
      }
      setError(loadError instanceof Error ? loadError.message : "Could not load the console.");
      throw loadError;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [chooseSelection]);

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let stopped = false;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== undefined) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = undefined;
        void load().catch(() => undefined);
      }, 60);
    };
    const run = async () => {
      try {
        await load(true);
      } catch {
        if (!readToken()) return;
      }
      while (!stopped && readToken()) {
        try {
          await subscribeEvents(
            bootstrapRef.current?.revision,
            (event) => {
              if (event.type === "ready") return;
              if (bootstrapRef.current !== undefined) {
                bootstrapRef.current = { ...bootstrapRef.current, revision: event.revision };
              }
              scheduleRefresh();
            },
            controller.signal,
          );
        } catch (streamError) {
          if (controller.signal.aborted) return;
          if (streamError instanceof ApiError && streamError.status === 401) {
            saveToken("");
            setAuthenticated(false);
            return;
          }
        }
        await new Promise<void>((resolve) => {
          retryTimer = window.setTimeout(resolve, 1_000);
        });
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
    };
  }, [authenticated, load]);

  const login = useCallback(async (token: string) => {
    saveToken(token);
    setAuthenticated(true);
    setLoading(true);
  }, []);

  const logout = useCallback(() => {
    if (
      pendingFilesRef.current.length > 0
      && !window.confirm("Discard the files staged for this conversation?")
    ) {
      return;
    }
    saveToken("");
    setAuthenticated(false);
    setBootstrap(undefined);
    setDetail(undefined);
    setError(undefined);
  }, []);

  const selectThread = useCallback((threadId: string) => {
    const thread = bootstrapRef.current?.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) return;
    if (
      selectedThreadRef.current !== threadId
      && pendingFilesRef.current.length > 0
      && !window.confirm("Discard the files staged for this conversation?")
    ) {
      return;
    }
    selectedAgentRef.current = thread.agentId;
    selectedThreadRef.current = threadId;
    setSelectedAgentId(thread.agentId);
    setSelectedThreadId(threadId);
    setPendingFiles([]);
    const url = new URL(window.location.href);
    url.searchParams.set("thread", threadId);
    history.replaceState(null, "", url);
    void api.thread(threadId).then(setDetail, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load the conversation.");
    });
  }, []);

  const selectAgent = useCallback((agentId: string) => {
    if (
      selectedAgentRef.current !== agentId
      && pendingFilesRef.current.length > 0
      && !window.confirm("Discard the files staged for this conversation?")
    ) {
      return;
    }
    selectedAgentRef.current = agentId;
    setSelectedAgentId(agentId);
    const thread = bootstrapRef.current?.threads.find((candidate) =>
      candidate.agentId === agentId && candidate.archivedAt === undefined
    );
    if (thread !== undefined) selectThread(thread.id);
    else {
      selectedThreadRef.current = undefined;
      setSelectedThreadId(undefined);
      setDetail(undefined);
      setPendingFiles([]);
      const url = new URL(window.location.href);
      url.searchParams.delete("thread");
      history.replaceState(null, "", url);
    }
    const agent = bootstrapRef.current?.agents.find((candidate) => candidate.id === agentId);
    setRuntime(agent?.defaults?.runtime ?? "");
    setModel(agent?.defaults?.model ?? "");
    setEffort(agent?.defaults?.effort ?? "");
  }, [selectThread]);

  const createThread = useCallback(async () => {
    const agentId = selectedAgentRef.current;
    if (agentId === undefined) throw new Error("Select an agent first.");
    const thread = await api.createThread(agentId);
    await load();
    selectThread(thread.id);
  }, [load, selectThread]);

  const patchAgent = useCallback(async (agentId: string, pinned: boolean) => {
    await api.patchAgent(agentId, pinned);
    await load();
  }, [load]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    await api.patchThread(threadId, { title });
    await load();
  }, [load]);

  const archiveThread = useCallback(async (threadId: string, archived: boolean) => {
    await api.patchThread(threadId, { archived });
    await load();
  }, [load]);

  const deleteThread = useCallback(async (threadId: string) => {
    await api.deleteThread(threadId);
    selectedThreadRef.current = undefined;
    await load();
  }, [load]);

  const cancel = useCallback(async () => {
    const threadId = selectedThreadRef.current;
    if (threadId === undefined) return;
    setDetail(await api.cancel(threadId));
    await load();
  }, [load]);

  const answerAsk = useCallback(async (answers: Readonly<Record<string, readonly string[]>>) => {
    const thread = detail?.thread;
    if (thread?.pendingAsk === undefined) return;
    await api.answerAsk(thread.id, thread.pendingAsk.interactionId, answers);
    await load();
  }, [detail?.thread, load]);

  const send = useCallback(async (
    input: Omit<StartTurnInput, "attachments" | "quote">,
    quote?: Quote,
  ) => {
    const thread = detail?.thread;
    if (thread === undefined) throw new Error("Create a conversation first.");
    if (thread.status === "running") {
      if (pendingFiles.length > 0) throw new Error("Attachments cannot be added while steering a run.");
      await api.liveInput(thread.id, input.text);
      return;
    }
    const attachments = await Promise.all(pendingFiles.map(fileAttachment));
    setPendingFiles([]);
    try {
      await streamTurn(thread.id, {
        ...input,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(quote === undefined ? {} : { quote: { ...quote, conversationId: thread.operatorConversationId ?? `web:${thread.id}` } }),
      }, (frame) => {
        setDetail(frame.detail);
        if (frame.type === "error") setError(frame.error?.message ?? "The agent run failed.");
      });
    } catch (sendError) {
      setPendingFiles((current) => current.length > 0 ? current : pendingFiles);
      throw sendError;
    }
    await load();
  }, [detail?.thread, load, pendingFiles]);

  const setShowOffline = useCallback((value: boolean) => {
    window.localStorage.setItem(OFFLINE_KEY, String(value));
    setShowOfflineState(value);
  }, []);
  const setShowArchived = useCallback((value: boolean) => {
    window.localStorage.setItem(ARCHIVE_KEY, String(value));
    setShowArchivedState(value);
  }, []);
  const setRailExpanded = useCallback((value: boolean) => {
    window.localStorage.setItem(RAIL_KEY, value ? "expanded" : "collapsed");
    setRailExpandedState(value);
  }, []);
  const addFiles = useCallback((files: FileList | readonly File[]) => {
    const additions = Array.from(files);
    const invalid = additions.find((file) => file.size > 512 * 1_024);
    if (invalid !== undefined) {
      setError(`${invalid.name} exceeds the 512 KiB inline attachment limit.`);
      return;
    }
    setPendingFiles((current) => {
      const combined = [...current, ...additions].slice(0, 3);
      if (combined.reduce((sum, file) => sum + file.size, 0) > 700 * 1_024) {
        setError("Attachments exceed the safe inline request budget.");
        return current;
      }
      return combined;
    });
  }, []);
  const removeFile = useCallback((index: number) => {
    setPendingFiles((files) => files.filter((_file, candidate) => candidate !== index));
  }, []);

  const agents = bootstrap?.agents ?? [];
  const threads = bootstrap?.threads ?? [];
  const visibleAgents = agents.filter((agent) => showOffline || agent.online || agent.pinned);
  const hiddenOfflineCount = agents.filter((agent) => !agent.online && !agent.pinned).length;
  const visibleThreads = threads.filter((thread) =>
    thread.agentId === selectedAgentId
    && (showArchived ? thread.archivedAt !== undefined : thread.archivedAt === undefined)
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);

  const value = useMemo<ConsoleState>(() => ({
    authenticated,
    loading,
    refreshing,
    ...(error === undefined ? {} : { error }),
    ...(bootstrap === undefined ? {} : { bootstrap }),
    ...(detail === undefined ? {} : { detail }),
    ...(selectedAgentId === undefined ? {} : { selectedAgentId }),
    ...(selectedThreadId === undefined ? {} : { selectedThreadId }),
    ...(selectedAgent === undefined ? {} : { selectedAgent }),
    ...(selectedThread === undefined ? {} : { selectedThread }),
    visibleAgents,
    visibleThreads,
    hiddenOfflineCount,
    showOffline,
    showArchived,
    railExpanded,
    pendingFiles,
    runtime,
    model,
    effort,
    login,
    logout,
    retry: () => load(),
    selectAgent,
    selectThread,
    createThread,
    patchAgent,
    renameThread,
    archiveThread,
    deleteThread,
    cancel,
    answerAsk,
    send,
    setShowOffline,
    setShowArchived,
    setRailExpanded,
    addFiles,
    removeFile,
    setRuntime,
    setModel,
    setEffort,
  }), [
    authenticated, loading, refreshing, error, bootstrap, detail, selectedAgentId,
    selectedThreadId, selectedAgent, selectedThread, visibleAgents, visibleThreads,
    hiddenOfflineCount, showOffline, showArchived, railExpanded, pendingFiles,
    runtime, model, effort, login, logout, load, selectAgent, selectThread,
    createThread, patchAgent, renameThread, archiveThread, deleteThread, cancel,
    answerAsk, send, setShowOffline, setShowArchived, setRailExpanded, addFiles,
    removeFile,
  ]);

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleState {
  const value = useContext(ConsoleContext);
  if (value === undefined) throw new Error("useConsole must be used inside ConsoleProvider.");
  return value;
}

async function fileAttachment(file: File): Promise<Attachment> {
  const url = await new Promise<string>((resolveValue, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolveValue(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    url,
  };
}
