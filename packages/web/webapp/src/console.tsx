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

import {
  readAgentRailExpandedPreference,
  writeAgentRailExpandedPreference,
} from "./agent-rail-layout";
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

interface Selection {
  readonly agentId?: string;
  readonly threadId?: string;
  readonly detail?: ThreadDetail;
}

export interface ConversationNavigationBlocker {
  hasPending(): boolean;
  /** Stable identity for the current pending work, used to scope one approval. */
  pendingKey(): string;
  discard(): void | Promise<void>;
}

interface NavigationApproval {
  readonly blockers: ReadonlyMap<ConversationNavigationBlocker, string>;
  readonly pendingAskKey?: string;
}

interface ActiveDeletionApproval {
  approval: NavigationApproval;
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
  readonly threadId?: string;
}

interface CreateThreadIntent {
  readonly epoch: number;
  readonly agentId?: string;
  readonly threadId?: string;
}

type LoadResult = "applied" | "blocked" | "superseded";

type ConsoleConnection = "connecting" | "connected" | "reconnecting" | "offline";

interface ConsoleState {
  readonly authenticated: boolean;
  readonly tokenAuthentication: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  /** Browser-to-console event-stream connectivity, independent of agent availability. */
  readonly connection: ConsoleConnection;
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
  const [connection, setConnection] = useState<ConsoleConnection>(
    navigator.onLine === false ? "offline" : "connecting",
  );
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
  const [railExpanded, setRailExpandedState] = useState(() =>
    readAgentRailExpandedPreference(window.localStorage)
  );
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
  const createThreadOperationsRef = useRef(new Map<string, Promise<void>>());
  const deletionApprovalsRef = useRef(new Map<string, ActiveDeletionApproval>());

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

  const confirmNavigation = useCallback(async (
    priorApproval?: NavigationApproval,
  ): Promise<NavigationApproval | undefined> => {
    const detail = matchingDetail(selectionRef.current);
    const pendingAsk = detail?.thread.pendingAsk;
    const pendingAskKey = detail === undefined || pendingAsk === undefined
      ? undefined
      : `${detail.thread.id}\u0000${pendingAsk.interactionId}`;
    const blockers = [...navigationBlockersRef.current].filter((blocker) =>
      blocker.hasPending()
      && (
        !priorApproval?.blockers.has(blocker)
        || priorApproval.blockers.get(blocker) !== blocker.pendingKey()
      )
    );
    const hasUnapprovedAsk =
      pendingAsk !== undefined
      && priorApproval?.pendingAskKey !== pendingAskKey;
    if (blockers.length === 0 && !hasUnapprovedAsk) {
      return priorApproval ?? { blockers: new Map() };
    }
    if (!window.confirm("Discard the unsent message or pending response input for this conversation?")) {
      return undefined;
    }
    const approvedBlockers = new Map(priorApproval?.blockers);
    for (const blocker of blockers) approvedBlockers.set(blocker, blocker.pendingKey());
    try {
      for (const blocker of blockers) await blocker.discard();
      return {
        blockers: approvedBlockers,
        ...(pendingAskKey === undefined
          ? priorApproval?.pendingAskKey === undefined
            ? {}
            : { pendingAskKey: priorApproval.pendingAskKey }
          : { pendingAskKey }),
      };
    } catch (cause) {
      reportError(errorMessage(cause, "Could not discard the current draft."));
      return undefined;
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
    selectionScope?: SelectionScope,
    navigationApproval?: NavigationApproval,
  ): Promise<LoadResult> => {
    const loadRequest = loadRequestRef.current + 1;
    loadRequestRef.current = loadRequest;
    const loadOrigin = selectionRef.current;
    const loadOriginEpoch = selectionEpochRef.current;
    const loadOriginApproval = deletionApprovalsRef.current.get(
      selectionOperationKey(loadOriginEpoch, loadOrigin.agentId, loadOrigin.threadId),
    );
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
      if (loadRequestRef.current !== loadRequest) return "superseded";
      if (initial) setError(undefined);
      const current = selectionRef.current;
      const currentEpoch = selectionEpochRef.current;
      const preservedIdentity =
        selectionScope !== undefined
        && selectionMatches(
          selectionScope.epoch,
          selectionEpochRef.current,
          selectionScope.threadId,
          selectionScope.agentId,
          current,
        )
        && next.agents.some((agent) => agent.id === selectionScope.agentId)
        && (
          selectionScope.threadId === undefined
          || next.threads.some((thread) =>
            thread.id === selectionScope.threadId
            && thread.agentId === selectionScope.agentId
          )
        )
          ? selectionIdentity(selectionScope.agentId, selectionScope.threadId)
          : undefined;
      const nextIdentity = preservedIdentity ?? chooseSelection(next);
      const identityChanged =
        current.agentId !== nextIdentity.agentId
        || current.threadId !== nextIdentity.threadId;
      if (identityChanged) {
        const approvalKey = selectionOperationKey(
          currentEpoch,
          current.agentId,
          current.threadId,
        );
        const originStillMatches = selectionMatches(
            loadOriginEpoch,
            currentEpoch,
            loadOrigin.threadId,
            loadOrigin.agentId,
            current,
          );
        const activeApproval =
          deletionApprovalsRef.current.get(approvalKey)
          ?? (originStillMatches ? loadOriginApproval : undefined);
        const enrichedApproval = await confirmNavigation(
          navigationApproval ?? activeApproval?.approval,
        );
        if (enrichedApproval === undefined) return "blocked";
        if (
          activeApproval !== undefined
          && deletionApprovalsRef.current.get(approvalKey) === activeApproval
        ) {
          activeApproval.approval = enrichedApproval;
        }
        if (
          loadRequestRef.current !== loadRequest
          || !selectionMatches(
            currentEpoch,
            selectionEpochRef.current,
            current.threadId,
            current.agentId,
            selectionRef.current,
          )
        ) {
          return "superseded";
        }
      }
      for (const payload of responseNotifications(bootstrapRef.current?.threads ?? [], next)) {
        void showBackgroundNotification(payload);
      }
      const nextAgent = next.agents.find((agent) => agent.id === nextIdentity.agentId);
      const reconciledOverrides = current.agentId === nextIdentity.agentId
        ? sanitizeRunOverrides(runOverridesRef.current, nextAgent)
        : EMPTY_RUN_OVERRIDES;
      if (!sameRunOverrides(runOverridesRef.current, reconciledOverrides)) {
        commitRunOverrides(reconciledOverrides);
      }
      bootstrapRef.current = next;
      setBootstrap(next);
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
      return loadRequestRef.current === loadRequest ? "applied" : "superseded";
    } catch (loadError) {
      if (loadRequestRef.current !== loadRequest) return "superseded";
      if (loadError instanceof ApiError && loadError.status === 401) {
        const attemptedTokenAuthentication = readToken().length > 0;
        saveToken("");
        setAuthenticated(false);
        setTokenAuthentication(true);
        setBootstrap(undefined);
        beginSelection(undefined, undefined);
        setError(attemptedTokenAuthentication ? loadError.message : undefined);
      } else if (
        selectionScope === undefined
        || selectionMatches(
          selectionScope.epoch,
          selectionEpochRef.current,
          selectionScope.threadId,
          selectionScope.agentId,
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
    confirmNavigation,
    requestDetail,
  ]);

  useEffect(() => {
    if (!authenticated) return;
    let streamController: AbortController | undefined;
    let retryTimer: number | undefined;
    let onlineWaiter: (() => void) | undefined;
    let stopped = false;
    let hasAttemptedConnection = false;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== undefined) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = undefined;
        void load().catch(() => undefined);
      }, 60);
    };
    const handleOffline = () => {
      if (stopped) return;
      setConnection("offline");
      streamController?.abort();
    };
    const handleOnline = () => {
      if (stopped) return;
      setConnection(hasAttemptedConnection ? "reconnecting" : "connecting");
      onlineWaiter?.();
      onlineWaiter = undefined;
    };
    const waitUntilOnline = async (): Promise<void> => {
      if (navigator.onLine !== false || stopped) return;
      await new Promise<void>((resolve) => {
        onlineWaiter = resolve;
      });
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    const run = async () => {
      try {
        await load(true);
      } catch (loadError) {
        if (loadError instanceof ApiError && loadError.status === 401) return;
      }
      while (!stopped) {
        if (navigator.onLine === false) {
          setConnection("offline");
          await waitUntilOnline();
          if (stopped) return;
        }
        setConnection(hasAttemptedConnection ? "reconnecting" : "connecting");
        hasAttemptedConnection = true;
        const attemptController = new AbortController();
        streamController = attemptController;
        try {
          await subscribeEvents(
            bootstrapRef.current?.revision,
            (event) => {
              if (
                streamController !== attemptController
                || attemptController.signal.aborted
                || stopped
                || navigator.onLine === false
              ) {
                return;
              }
              // A resumed stream may begin with replayed invalidations or a
              // reset rather than a ready control frame. Receiving any valid
              // frame proves this specific stream attempt is live.
              setConnection("connected");
              if (event.type === "ready") {
                return;
              }
              if (bootstrapRef.current !== undefined) {
                bootstrapRef.current = { ...bootstrapRef.current, revision: event.revision };
              }
              scheduleRefresh();
            },
            attemptController.signal,
          );
        } catch (streamError) {
          if (stopped) return;
          if (streamError instanceof ApiError && streamError.status === 401) {
            saveToken("");
            setAuthenticated(false);
            setTokenAuthentication(true);
            setError(streamError.message);
            return;
          }
        } finally {
          if (streamController === attemptController) streamController = undefined;
        }
        if (stopped) return;
        if (navigator.onLine === false) continue;
        setConnection("reconnecting");
        await new Promise<void>((resolve) => {
          retryTimer = window.setTimeout(resolve, 1_000);
        });
      }
    };
    void run();
    return () => {
      stopped = true;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      streamController?.abort();
      onlineWaiter?.();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
    };
  }, [authenticated, load]);

  const login = useCallback(async (token: string) => {
    saveToken(token);
    setTokenAuthentication(true);
    setAuthenticated(true);
    setLoading(true);
    setConnection(navigator.onLine === false ? "offline" : "connecting");
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
    const originEpoch = selectionEpochRef.current;
    if (await confirmNavigation() === undefined) return;
    if (!selectionMatches(
      originEpoch,
      selectionEpochRef.current,
      current.threadId,
      current.agentId,
      selectionRef.current,
    )) {
      return;
    }
    const currentThread = bootstrapRef.current?.threads.find((candidate) =>
      candidate.id === threadId && candidate.agentId === thread.agentId
    );
    if (currentThread === undefined) return;
    setError(undefined);
    const epoch = beginSelection(currentThread.agentId, threadId);
    await requestDetail(threadId, epoch);
  }, [beginSelection, confirmNavigation, requestDetail]);

  const selectAgent = useCallback(async (agentId: string) => {
    const current = selectionRef.current;
    const originEpoch = selectionEpochRef.current;
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
    if (await confirmNavigation() === undefined) return;
    if (!selectionMatches(
      originEpoch,
      selectionEpochRef.current,
      current.threadId,
      current.agentId,
      selectionRef.current,
    )) {
      return;
    }
    if (!bootstrapRef.current?.agents.some((agent) => agent.id === agentId)) return;
    const latestCurrentThread = bootstrapRef.current?.threads.find((candidate) =>
      candidate.id === current.threadId && candidate.agentId === agentId
    );
    const latestThread = latestCurrentThread ?? bootstrapRef.current?.threads.find((candidate) =>
      candidate.agentId === agentId && candidate.archivedAt === undefined
    );
    setError(undefined);
    if (latestThread !== undefined) {
      const epoch = beginSelection(agentId, latestThread.id);
      await requestDetail(latestThread.id, epoch);
    } else {
      beginSelection(agentId, undefined);
    }
  }, [beginSelection, confirmNavigation, requestDetail]);

  const createThreadOnce = useCallback(async (intent: CreateThreadIntent) => {
    const agentId = intent.agentId;
    if (agentId === undefined) {
      reportError("Select an agent first.");
      return;
    }
    const creationEpoch = intent.epoch;
    const creationThreadId = intent.threadId;
    const matchesCreation = () => selectionMatches(
      creationEpoch,
      selectionEpochRef.current,
      creationThreadId,
      agentId,
      selectionRef.current,
    );
    if (await confirmNavigation() === undefined) return;
    if (!matchesCreation()) return;
    setError(undefined);
    try {
      const thread = await api.createThread(agentId);
      if (!matchesCreation()) return;
      const creationScope: SelectionScope = {
        epoch: creationEpoch,
        agentId,
        ...(creationThreadId === undefined ? {} : { threadId: creationThreadId }),
      };
      let catalogThread = bootstrapRef.current?.threads.find((candidate) =>
        candidate.id === thread.id && candidate.agentId === agentId
      );
      for (
        let refreshAttempt = 0;
        catalogThread === undefined && refreshAttempt < 2;
        refreshAttempt += 1
      ) {
        const loadResult = await load(false, creationScope);
        if (!matchesCreation() || loadResult === "blocked") return;
        catalogThread = bootstrapRef.current?.threads.find((candidate) =>
          candidate.id === thread.id && candidate.agentId === agentId
        );
        // A superseding refresh may still be in flight. The next bounded load
        // either consumes its applied catalog above or becomes the winning
        // refresh itself; the already-created thread is never created twice.
      }
      if (catalogThread === undefined) {
        reportError("The new conversation was created but is not available yet.");
        return;
      }
      if (
        await confirmNavigation() === undefined
        || !matchesCreation()
      ) {
        return;
      }
      const epoch = beginSelection(agentId, thread.id);
      await requestDetail(thread.id, epoch);
    } catch (cause) {
      if (matchesCreation()) {
        reportError(errorMessage(cause, "Could not create the conversation."));
      }
    }
  }, [beginSelection, confirmNavigation, load, reportError, requestDetail]);

  const createThread = useCallback((): Promise<void> => {
    const current = selectionRef.current;
    const intent: CreateThreadIntent = {
      epoch: selectionEpochRef.current,
      ...(current.agentId === undefined ? {} : { agentId: current.agentId }),
      ...(current.threadId === undefined ? {} : { threadId: current.threadId }),
    };
    const operationKey = JSON.stringify([
      intent.epoch,
      intent.agentId ?? null,
      intent.threadId ?? null,
    ]);
    const activeOperation = createThreadOperationsRef.current.get(operationKey);
    if (activeOperation !== undefined) return activeOperation;
    const operation = createThreadOnce(intent);
    createThreadOperationsRef.current.set(operationKey, operation);
    void operation.finally(() => {
      if (createThreadOperationsRef.current.get(operationKey) === operation) {
        createThreadOperationsRef.current.delete(operationKey);
      }
    }).catch(() => undefined);
    return operation;
  }, [createThreadOnce]);

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
    const current = selectionRef.current;
    const deletingSelection = current.threadId === threadId;
    const deletionEpoch = selectionEpochRef.current;
    let navigationApproval: NavigationApproval | undefined;
    let approvalKey: string | undefined;
    let activeApproval: ActiveDeletionApproval | undefined;
    if (deletingSelection) {
      navigationApproval = await confirmNavigation();
      if (navigationApproval === undefined) return;
      if (!selectionMatches(
        deletionEpoch,
        selectionEpochRef.current,
        threadId,
        current.agentId,
        selectionRef.current,
      )) {
        return;
      }
      approvalKey = selectionOperationKey(
        deletionEpoch,
        current.agentId,
        threadId,
      );
      activeApproval = { approval: navigationApproval };
      deletionApprovalsRef.current.set(approvalKey, activeApproval);
    }
    setError(undefined);
    try {
      await api.deleteThread(threadId);
      // Keep the originating identity mounted until the refreshed catalog is
      // ready. The generic load path can then detect any draft created while
      // deletion was in flight and authorize the actual fallback selection.
      await load();
    } catch (cause) {
      reportError(errorMessage(cause, "Could not delete the conversation."));
    } finally {
      if (
        approvalKey !== undefined
        && activeApproval !== undefined
        && deletionApprovalsRef.current.get(approvalKey) === activeApproval
      ) {
        deletionApprovalsRef.current.delete(approvalKey);
      }
    }
  }, [confirmNavigation, load, reportError]);

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
    writeAgentRailExpandedPreference(window.localStorage, value);
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
    setError(undefined);
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
    connection,
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
    authenticated, tokenAuthentication, loading, refreshing, connection, submitting, sending, error, bootstrap, detail, selectedAgentId,
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
  threadId: string | undefined,
  agentId: string | undefined,
  selection: Selection,
): boolean {
  return (
    expectedEpoch === currentEpoch
    && selection.threadId === threadId
    && selection.agentId === agentId
  );
}

function selectionOperationKey(
  epoch: number,
  agentId: string | undefined,
  threadId: string | undefined,
): string {
  return JSON.stringify([epoch, agentId ?? null, threadId ?? null]);
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
