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

interface Selection {
  readonly agentId?: string;
  readonly threadId?: string;
  readonly detail?: ThreadDetail;
}

export interface ConversationNavigationBlocker {
  hasPending(): boolean;
  discard(): void | Promise<void>;
}

interface RunOverrides {
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
}

interface PendingContextBaseline {
  readonly turnId?: string;
  readonly assistantMessageId?: string;
}

interface SelectionScope {
  readonly epoch: number;
  readonly agentId: string;
  readonly threadId: string;
}

interface ConsoleState {
  readonly authenticated: boolean;
  readonly tokenAuthentication: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  /** True while the selected conversation's message request is in flight. */
  readonly submitting: boolean;
  /** True until the selected conversation reports trustworthy current-turn context. */
  readonly sending: boolean;
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
  /** Authored overrides only. Empty means follow the selected agent default. */
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  login(token: string): Promise<void>;
  logout(): void;
  retry(): Promise<void>;
  selectAgent(agentId: string): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  createThread(): Promise<void>;
  patchAgent(agentId: string, pinned: boolean): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  archiveThread(threadId: string, archived: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  cancel(): Promise<void>;
  answerAsk(answers: Readonly<Record<string, readonly string[]>>): Promise<boolean>;
  send(
    input: Omit<StartTurnInput, "attachments" | "quote">,
    attachments: readonly Attachment[],
    quote?: Quote,
  ): Promise<boolean>;
  reportError(message: string): void;
  setShowOffline(value: boolean): void;
  setShowArchived(value: boolean): void;
  setRailExpanded(value: boolean): void;
  setRuntime(value: string): void;
  setModel(value: string): void;
  setEffort(value: string): void;
  registerNavigationBlocker(blocker: ConversationNavigationBlocker): () => void;
}

const ConsoleContext = createContext<ConsoleState | undefined>(undefined);

export function ConsoleProvider({ children }: { readonly children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(true);
  const [tokenAuthentication, setTokenAuthentication] = useState(readToken().length > 0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [selection, setSelection] = useState<Selection>({});
  const [submittingThreadIds, setSubmittingThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingContextThreadIds, setPendingContextThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showOffline, setShowOfflineState] = useState(window.localStorage.getItem(OFFLINE_KEY) === "true");
  const [showArchived, setShowArchivedState] = useState(window.localStorage.getItem(ARCHIVE_KEY) === "true");
  const [railExpanded, setRailExpandedState] = useState(window.localStorage.getItem(RAIL_KEY) === "expanded");
  const [runOverrides, setRunOverridesState] = useState<RunOverrides>(EMPTY_RUN_OVERRIDES);
  const bootstrapRef = useRef<Bootstrap | undefined>(undefined);
  const selectionRef = useRef<Selection>({});
  const runOverridesRef = useRef<RunOverrides>(EMPTY_RUN_OVERRIDES);
  const submittingThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingContextsRef = useRef<ReadonlyMap<string, PendingContextBaseline>>(new Map());
  const navigationBlockersRef = useRef<ReadonlySet<ConversationNavigationBlocker>>(new Set());
  const selectionEpochRef = useRef(0);
  const detailRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const refreshTimerRef = useRef<number | undefined>(undefined);

  bootstrapRef.current = bootstrap;
  selectionRef.current = selection;
  runOverridesRef.current = runOverrides;

  const commitSelection = useCallback((next: Selection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const commitRunOverrides = useCallback((next: RunOverrides) => {
    runOverridesRef.current = next;
    setRunOverridesState(next);
  }, []);

  const clearRunOverrides = useCallback(() => {
    commitRunOverrides(EMPTY_RUN_OVERRIDES);
  }, [commitRunOverrides]);

  const beginSelection = useCallback((
    agentId: string | undefined,
    threadId: string | undefined,
  ): number => {
    if (selectionRef.current.agentId !== agentId) clearRunOverrides();
    const epoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = epoch;
    detailRequestRef.current += 1;
    commitSelection(selectionIdentity(agentId, threadId));
    updateThreadUrl(threadId);
    return epoch;
  }, [clearRunOverrides, commitSelection]);

  const reportError = useCallback((message: string) => {
    setError(message);
  }, []);

  const setSubmitting = useCallback((threadId: string, value: boolean) => {
    const next = new Set(submittingThreadIdsRef.current);
    if (value) next.add(threadId);
    else next.delete(threadId);
    submittingThreadIdsRef.current = next;
    setSubmittingThreadIds(next);
  }, []);

  const markContextPending = useCallback((threadId: string, detail: ThreadDetail) => {
    const latestAssistant = detail.messages.findLast((message) => message.role === "assistant");
    const turnId = detail.thread.activeTurnId ?? detail.thread.lastTurnId;
    const next = new Map(pendingContextsRef.current);
    next.set(threadId, {
      ...(turnId === undefined ? {} : { turnId }),
      ...(latestAssistant === undefined ? {} : { assistantMessageId: latestAssistant.id }),
    });
    pendingContextsRef.current = next;
    setPendingContextThreadIds(new Set(next.keys()));
  }, []);

  const clearContextPending = useCallback((threadId: string) => {
    if (!pendingContextsRef.current.has(threadId)) return;
    const next = new Map(pendingContextsRef.current);
    next.delete(threadId);
    pendingContextsRef.current = next;
    setPendingContextThreadIds(new Set(next.keys()));
  }, []);

  const reconcileContextPending = useCallback((detail: ThreadDetail) => {
    const baseline = pendingContextsRef.current.get(detail.thread.id);
    if (
      baseline !== undefined
      && (
        hasTrustworthyCurrentContext(detail, baseline)
        || (
          isTerminalTurnStatus(detail.thread.status)
          && hasCurrentTurnAdvanced(detail, baseline)
        )
      )
    ) {
      clearContextPending(detail.thread.id);
    }
  }, [clearContextPending]);

  const registerNavigationBlocker = useCallback((blocker: ConversationNavigationBlocker) => {
    const next = new Set(navigationBlockersRef.current);
    next.add(blocker);
    navigationBlockersRef.current = next;
    return () => {
      if (!navigationBlockersRef.current.has(blocker)) return;
      const remaining = new Set(navigationBlockersRef.current);
      remaining.delete(blocker);
      navigationBlockersRef.current = remaining;
    };
  }, []);

  const confirmNavigation = useCallback(async (): Promise<boolean> => {
    const blockers = [...navigationBlockersRef.current].filter((blocker) => blocker.hasPending());
    const hasPendingAsk = matchingDetail(selectionRef.current)?.thread.pendingAsk !== undefined;
    if (blockers.length === 0 && !hasPendingAsk) return true;
    if (!window.confirm("Discard the unsent message or pending response input for this conversation?")) {
      return false;
    }
    try {
      for (const blocker of blockers) await blocker.discard();
      return true;
    } catch (cause) {
      reportError(errorMessage(cause, "Could not discard the current draft."));
      return false;
    }
  }, [reportError]);

  const requestDetail = useCallback(async (
    threadId: string,
    epoch: number,
  ): Promise<void> => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    try {
      const nextDetail = await api.thread(threadId);
      const current = selectionRef.current;
      if (
        detailRequestRef.current !== requestId
        || selectionEpochRef.current !== epoch
        || current.threadId !== threadId
        || nextDetail.thread.id !== threadId
        || nextDetail.thread.agentId !== current.agentId
      ) {
        return;
      }
      reconcileContextPending(nextDetail);
      commitSelection({ ...current, detail: nextDetail });
    } catch (cause) {
      if (
        detailRequestRef.current === requestId
        && selectionEpochRef.current === epoch
        && selectionRef.current.threadId === threadId
      ) {
        reportError(errorMessage(cause, "Could not load the conversation."));
      }
    }
  }, [commitSelection, reconcileContextPending, reportError]);

  const chooseSelection = useCallback((next: Bootstrap): {
    readonly agentId?: string;
    readonly threadId?: string;
  } => {
    const requested = new URLSearchParams(window.location.search).get("thread") ?? undefined;
    const existingThread = next.threads.find((thread) =>
      thread.id === (requested ?? selectionRef.current.threadId)
    );
    const currentAgent = next.agents.find((agent) => agent.id === selectionRef.current.agentId);
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

  const load = useCallback(async (
    initial = false,
    errorScope?: SelectionScope,
  ): Promise<void> => {
    const loadRequest = loadRequestRef.current + 1;
    loadRequestRef.current = loadRequest;
    if (!initial) setRefreshing(true);
    try {
      let next: Bootstrap;
      if (initial) {
        try {
          next = await api.probeBootstrap();
          saveToken("");
          setTokenAuthentication(false);
        } catch (probeError) {
          if (
            !(probeError instanceof ApiError)
            || probeError.status !== 401
            || readToken().length === 0
          ) {
            throw probeError;
          }
          next = await api.bootstrap();
          setTokenAuthentication(true);
        }
      } else {
        next = await api.bootstrap();
        setTokenAuthentication(readToken().length > 0);
      }
      if (loadRequestRef.current !== loadRequest) return;
      if (initial) setError(undefined);
      for (const payload of responseNotifications(bootstrapRef.current?.threads ?? [], next)) {
        void showBackgroundNotification(payload);
      }
      const nextIdentity = chooseSelection(next);
      const current = selectionRef.current;
      const nextAgent = next.agents.find((agent) => agent.id === nextIdentity.agentId);
      const reconciledOverrides = current.agentId === nextIdentity.agentId
        ? sanitizeRunOverrides(runOverridesRef.current, nextAgent)
        : EMPTY_RUN_OVERRIDES;
      if (!sameRunOverrides(runOverridesRef.current, reconciledOverrides)) {
        commitRunOverrides(reconciledOverrides);
      }
      bootstrapRef.current = next;
      setBootstrap(next);
      const identityChanged =
        current.agentId !== nextIdentity.agentId
        || current.threadId !== nextIdentity.threadId;
      const epoch = identityChanged
        ? beginSelection(nextIdentity.agentId, nextIdentity.threadId)
        : selectionEpochRef.current;
      updateThreadUrl(nextIdentity.threadId);
      if (nextIdentity.threadId === undefined) {
        if (!identityChanged && current.detail !== undefined) {
          commitSelection(selectionIdentity(nextIdentity.agentId, undefined));
        }
      } else {
        await requestDetail(nextIdentity.threadId, epoch);
      }
    } catch (loadError) {
      if (loadRequestRef.current !== loadRequest) return;
      if (loadError instanceof ApiError && loadError.status === 401) {
        const attemptedTokenAuthentication = readToken().length > 0;
        saveToken("");
        setAuthenticated(false);
        setTokenAuthentication(true);
        setBootstrap(undefined);
        beginSelection(undefined, undefined);
        setError(attemptedTokenAuthentication ? loadError.message : undefined);
      } else if (
        errorScope === undefined
        || selectionMatches(
          errorScope.epoch,
          selectionEpochRef.current,
          errorScope.threadId,
          errorScope.agentId,
          selectionRef.current,
        )
      ) {
        setError(errorMessage(loadError, "Could not load the console."));
      }
      throw loadError;
    } finally {
      if (loadRequestRef.current === loadRequest) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    beginSelection,
    chooseSelection,
    commitRunOverrides,
    commitSelection,
    requestDetail,
  ]);

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
      } catch (loadError) {
        if (loadError instanceof ApiError && loadError.status === 401) return;
      }
      while (!stopped) {
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
            setTokenAuthentication(true);
            setError(streamError.message);
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
    setTokenAuthentication(true);
    setAuthenticated(true);
    setLoading(true);
  }, []);

  const logout = useCallback(() => {
    saveToken("");
    setAuthenticated(false);
    setBootstrap(undefined);
    beginSelection(undefined, undefined);
    clearRunOverrides();
    submittingThreadIdsRef.current = new Set();
    pendingContextsRef.current = new Map();
    setSubmittingThreadIds(new Set());
    setPendingContextThreadIds(new Set());
    setError(undefined);
  }, [beginSelection, clearRunOverrides]);

  const selectThread = useCallback(async (threadId: string) => {
    const thread = bootstrapRef.current?.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) return;
    const current = selectionRef.current;
    if (current.threadId === threadId && current.agentId === thread.agentId) return;
    if (!await confirmNavigation()) return;
    setError(undefined);
    const epoch = beginSelection(thread.agentId, threadId);
    await requestDetail(threadId, epoch);
  }, [beginSelection, confirmNavigation, requestDetail]);

  const selectAgent = useCallback(async (agentId: string) => {
    const current = selectionRef.current;
    const currentThread = bootstrapRef.current?.threads.find((candidate) =>
      candidate.id === current.threadId && candidate.agentId === agentId
    );
    const thread = currentThread ?? bootstrapRef.current?.threads.find((candidate) =>
      candidate.agentId === agentId && candidate.archivedAt === undefined
    );
    if (
      current.agentId === agentId
      && current.threadId === thread?.id
    ) {
      return;
    }
    if (!await confirmNavigation()) return;
    setError(undefined);
    if (thread !== undefined) {
      const epoch = beginSelection(agentId, thread.id);
      await requestDetail(thread.id, epoch);
    } else {
      beginSelection(agentId, undefined);
    }
  }, [beginSelection, confirmNavigation, requestDetail]);

  const createThread = useCallback(async () => {
    const agentId = selectionRef.current.agentId;
    if (agentId === undefined) {
      reportError("Select an agent first.");
      return;
    }
    if (!await confirmNavigation()) return;
    setError(undefined);
    try {
      const thread = await api.createThread(agentId);
      await load();
      const catalogThread = bootstrapRef.current?.threads.find((candidate) =>
        candidate.id === thread.id && candidate.agentId === agentId
      );
      if (catalogThread === undefined) {
        reportError("The new conversation was created but is not available yet.");
        return;
      }
      const epoch = beginSelection(agentId, thread.id);
      await requestDetail(thread.id, epoch);
    } catch (cause) {
      reportError(errorMessage(cause, "Could not create the conversation."));
    }
  }, [beginSelection, confirmNavigation, load, reportError, requestDetail]);

  const patchAgent = useCallback(async (agentId: string, pinned: boolean) => {
    setError(undefined);
    try {
      await api.patchAgent(agentId, pinned);
      await load();
    } catch (cause) {
      reportError(errorMessage(cause, "Could not update the agent."));
    }
  }, [load, reportError]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    setError(undefined);
    try {
      await api.patchThread(threadId, { title });
      await load();
    } catch (cause) {
      reportError(errorMessage(cause, "Could not rename the conversation."));
    }
  }, [load, reportError]);

  const archiveThread = useCallback(async (threadId: string, archived: boolean) => {
    setError(undefined);
    try {
      await api.patchThread(threadId, { archived });
      await load();
    } catch (cause) {
      reportError(errorMessage(
        cause,
        archived ? "Could not archive the conversation." : "Could not restore the conversation.",
      ));
    }
  }, [load, reportError]);

  const deleteThread = useCallback(async (threadId: string) => {
    setError(undefined);
    try {
      await api.deleteThread(threadId);
      if (selectionRef.current.threadId === threadId) {
        beginSelection(selectionRef.current.agentId, undefined);
      }
      await load();
    } catch (cause) {
      reportError(errorMessage(cause, "Could not delete the conversation."));
    }
  }, [beginSelection, load, reportError]);

  const cancel = useCallback(async () => {
    const { agentId, threadId } = selectionRef.current;
    if (agentId === undefined || threadId === undefined) return;
    const epoch = selectionEpochRef.current;
    setError(undefined);
    try {
      const cancelled = await api.cancel(threadId);
      const current = selectionRef.current;
      if (
        selectionEpochRef.current === epoch
        && current.threadId === threadId
        && cancelled.thread.id === threadId
        && cancelled.thread.agentId === current.agentId
      ) {
        commitSelection({ ...current, detail: cancelled });
      }
      await load(false, { epoch, agentId, threadId });
    } catch (cause) {
      if (selectionMatches(epoch, selectionEpochRef.current, threadId, agentId, selectionRef.current)) {
        reportError(errorMessage(cause, "Could not stop the response."));
      }
    }
  }, [commitSelection, load, reportError]);

  const answerAsk = useCallback(async (answers: Readonly<Record<string, readonly string[]>>) => {
    const current = selectionRef.current;
    const thread = matchingDetail(current)?.thread;
    if (thread?.pendingAsk === undefined) return false;
    const epoch = selectionEpochRef.current;
    const agentId = thread.agentId;
    const interactionId = thread.pendingAsk.interactionId;
    setError(undefined);
    try {
      await api.answerAsk(thread.id, interactionId, answers);
      await load(false, { epoch, agentId, threadId: thread.id });
      return true;
    } catch (cause) {
      if (selectionMatches(epoch, selectionEpochRef.current, thread.id, agentId, selectionRef.current)) {
        reportError(errorMessage(cause, "Could not submit the requested input."));
      }
      return false;
    }
  }, [load, reportError]);

  const send = useCallback(async (
    input: Omit<StartTurnInput, "attachments" | "quote">,
    attachments: readonly Attachment[],
    quote?: Quote,
  ): Promise<boolean> => {
    const current = selectionRef.current;
    const thread = matchingDetail(current)?.thread;
    const catalogThread = bootstrapRef.current?.threads.find((candidate) =>
      candidate.id === current.threadId && candidate.agentId === current.agentId
    );
    if (
      thread === undefined
      || catalogThread === undefined
      || thread.id !== catalogThread.id
      || thread.agentId !== catalogThread.agentId
    ) {
      reportError("Wait for the selected conversation to finish loading.");
      return false;
    }
    const epoch = selectionEpochRef.current;
    const agent = bootstrapRef.current?.agents.find((candidate) => candidate.id === thread.agentId);
    const safeOverrides = sanitizeRunOverrides({
      runtime: input.runtime ?? "",
      model: input.model ?? "",
      effort: input.effort ?? "",
    }, agent);
    if (!sameRunOverrides(runOverridesRef.current, safeOverrides)) {
      commitRunOverrides(safeOverrides);
    }
    setError(undefined);
    setSubmitting(thread.id, true);
    if (thread.status === "running") {
      if (attachments.length > 0) {
        reportError("Attachments cannot be added while steering a run.");
        setSubmitting(thread.id, false);
        return false;
      }
      try {
        await api.liveInput(thread.id, input.text);
        return true;
      } catch (cause) {
        if (selectionMatches(
          epoch,
          selectionEpochRef.current,
          thread.id,
          thread.agentId,
          selectionRef.current,
        )) {
          reportError(errorMessage(cause, "Could not send live input."));
        }
        return false;
      } finally {
        setSubmitting(thread.id, false);
      }
    }
    markContextPending(thread.id, current.detail!);
    detailRequestRef.current += 1;
    let streamError: string | undefined;
    try {
      await streamTurn(thread.id, {
        text: input.text,
        ...(safeOverrides.runtime ? { runtime: safeOverrides.runtime } : {}),
        ...(safeOverrides.model ? { model: safeOverrides.model } : {}),
        ...(safeOverrides.effort ? { effort: safeOverrides.effort } : {}),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(quote === undefined ? {} : { quote: { ...quote, conversationId: thread.operatorConversationId ?? `web:${thread.id}` } }),
      }, (frame) => {
        if (frame.type === "error") {
          streamError = frame.error?.message ?? "The agent run failed.";
        }
        const frameMatchesThread =
          frame.detail.thread.id === thread.id
          && frame.detail.thread.agentId === thread.agentId;
        if (frameMatchesThread) {
          reconcileContextPending(frame.detail);
          const baseline = pendingContextsRef.current.get(thread.id);
          if (
            frame.type !== "state"
            || (
              baseline !== undefined
              && isTerminalTurnStatus(frame.detail.thread.status)
              && hasCurrentTurnAdvanced(frame.detail, baseline)
            )
          ) {
            clearContextPending(thread.id);
          }
        }
        const selected = selectionRef.current;
        if (
          !selectionMatches(
            epoch,
            selectionEpochRef.current,
            thread.id,
            thread.agentId,
            selected,
          )
          || !frameMatchesThread
        ) {
          return;
        }
        commitSelection({ ...selected, detail: frame.detail });
        if (streamError !== undefined) reportError(streamError);
      });
    } catch (cause) {
      clearContextPending(thread.id);
      if (selectionMatches(
        epoch,
        selectionEpochRef.current,
        thread.id,
        thread.agentId,
        selectionRef.current,
      )) {
        reportError(errorMessage(cause, "Could not send the message."));
      }
      return false;
    } finally {
      setSubmitting(thread.id, false);
    }
    try {
      await load(false, { epoch, agentId: thread.agentId, threadId: thread.id });
    } catch {
      // load() already surfaced the refresh failure; the submitted turn still
      // completed and must not be duplicated by restoring the composer.
    }
    return streamError === undefined;
  }, [
    clearContextPending,
    commitRunOverrides,
    commitSelection,
    load,
    markContextPending,
    reconcileContextPending,
    reportError,
    setSubmitting,
  ]);

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
  const setRuntime = useCallback((value: string) => {
    commitRunOverrides({
      ...runOverridesRef.current,
      runtime: value,
      ...(value ? {} : { model: "", effort: "" }),
    });
  }, [commitRunOverrides]);
  const setModel = useCallback((value: string) => {
    commitRunOverrides({
      ...runOverridesRef.current,
      model: value,
      ...(value ? {} : { runtime: "", effort: "" }),
    });
  }, [commitRunOverrides]);
  const setEffort = useCallback((value: string) => {
    commitRunOverrides({ ...runOverridesRef.current, effort: value });
  }, [commitRunOverrides]);

  const agents = bootstrap?.agents ?? [];
  const threads = bootstrap?.threads ?? [];
  const selectedAgentId = selection.agentId;
  const selectedThreadId = selection.threadId;
  const visibleAgents = agents.filter((agent) => showOffline || agent.online || agent.pinned);
  const hiddenOfflineCount = agents.filter((agent) => !agent.online && !agent.pinned).length;
  const visibleThreads = threads.filter((thread) =>
    thread.agentId === selectedAgentId
    && (showArchived ? thread.archivedAt !== undefined : thread.archivedAt === undefined)
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedThread = threads.find((thread) =>
    thread.id === selectedThreadId && thread.agentId === selectedAgentId
  );
  const detail = matchingDetail(selection);
  const submitting =
    selectedThreadId !== undefined && submittingThreadIds.has(selectedThreadId);
  const sending =
    selectedThreadId !== undefined && pendingContextThreadIds.has(selectedThreadId);
  const { runtime, model, effort } = runOverrides;
  const retry = useCallback(async () => {
    try {
      await load();
    } catch {
      // load() owns the user-visible error.
    }
  }, [load]);

  const value = useMemo<ConsoleState>(() => ({
    authenticated,
    tokenAuthentication,
    loading,
    refreshing,
    submitting,
    sending,
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
    runtime,
    model,
    effort,
    login,
    logout,
    retry,
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
    reportError,
    setShowOffline,
    setShowArchived,
    setRailExpanded,
    setRuntime,
    setModel,
    setEffort,
    registerNavigationBlocker,
  }), [
    authenticated, tokenAuthentication, loading, refreshing, submitting, sending, error, bootstrap, detail, selectedAgentId,
    selectedThreadId, selectedAgent, selectedThread, visibleAgents, visibleThreads,
    hiddenOfflineCount, showOffline, showArchived, railExpanded,
    runtime, model, effort, login, logout, retry, selectAgent, selectThread,
    createThread, patchAgent, renameThread, archiveThread, deleteThread, cancel,
    answerAsk, send, reportError, setShowOffline, setShowArchived, setRailExpanded,
    setRuntime, setModel, setEffort, registerNavigationBlocker,
  ]);

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleState {
  const value = useContext(ConsoleContext);
  if (value === undefined) throw new Error("useConsole must be used inside ConsoleProvider.");
  return value;
}

function matchingDetail(selection: Selection): ThreadDetail | undefined {
  const detail = selection.detail;
  return detail !== undefined
    && detail.thread.id === selection.threadId
    && detail.thread.agentId === selection.agentId
    ? detail
    : undefined;
}

function selectionIdentity(
  agentId: string | undefined,
  threadId: string | undefined,
): Selection {
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function updateThreadUrl(threadId: string | undefined): void {
  const browserUrl = new URL(window.location.href);
  if (threadId === undefined) browserUrl.searchParams.delete("thread");
  else browserUrl.searchParams.set("thread", threadId);
  history.replaceState(null, "", browserUrl);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

const EMPTY_RUN_OVERRIDES: RunOverrides = {
  runtime: "",
  model: "",
  effort: "",
};

function sanitizeRunOverrides(
  overrides: RunOverrides,
  agent: Agent | undefined,
): RunOverrides {
  if (agent?.capabilities.runtimeOverrides !== true) return EMPTY_RUN_OVERRIDES;

  const authoredRoute = overrides.runtime.length > 0 || overrides.model.length > 0;
  if (
    (overrides.runtime.length > 0) !== (overrides.model.length > 0)
  ) {
    return EMPTY_RUN_OVERRIDES;
  }

  const runtime = authoredRoute ? overrides.runtime : agent.defaults?.runtime;
  const model = authoredRoute ? overrides.model : agent.defaults?.model;
  const selectedModel = runtime === undefined || model === undefined
    ? undefined
    : agent.models?.find((candidate) =>
        candidate.runtime === runtime && candidate.id === model
      );

  if (authoredRoute && selectedModel === undefined) return EMPTY_RUN_OVERRIDES;
  if (
    overrides.effort
    && !selectedModel?.efforts?.includes(overrides.effort)
  ) {
    return { ...overrides, effort: "" };
  }
  return overrides;
}

function sameRunOverrides(left: RunOverrides, right: RunOverrides): boolean {
  return (
    left.runtime === right.runtime
    && left.model === right.model
    && left.effort === right.effort
  );
}

function selectionMatches(
  expectedEpoch: number,
  currentEpoch: number,
  threadId: string,
  agentId: string,
  selection: Selection,
): boolean {
  return (
    expectedEpoch === currentEpoch
    && selection.threadId === threadId
    && selection.agentId === agentId
  );
}

function hasTrustworthyCurrentContext(
  detail: ThreadDetail,
  baseline: PendingContextBaseline,
): boolean {
  const latestAssistant = detail.messages.findLast((message) => message.role === "assistant");
  if (latestAssistant?.telemetry?.contextUsed === undefined) return false;

  const currentTurnId = detail.thread.activeTurnId ?? detail.thread.lastTurnId;
  if (currentTurnId !== undefined) {
    if (currentTurnId === baseline.turnId) return false;
    if (
      latestAssistant.turnId !== undefined
      && latestAssistant.turnId !== currentTurnId
    ) {
      return false;
    }
    return latestAssistant.id !== baseline.assistantMessageId;
  }
  return latestAssistant.id !== baseline.assistantMessageId;
}

function hasCurrentTurnAdvanced(
  detail: ThreadDetail,
  baseline: PendingContextBaseline,
): boolean {
  const currentTurnId = detail.thread.activeTurnId ?? detail.thread.lastTurnId;
  if (currentTurnId !== undefined || baseline.turnId !== undefined) {
    return currentTurnId !== baseline.turnId;
  }
  const latestAssistant = detail.messages.findLast((message) => message.role === "assistant");
  return latestAssistant?.id !== baseline.assistantMessageId;
}

function isTerminalTurnStatus(status: Thread["status"]): boolean {
  return (
    status === "complete"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
  );
}
