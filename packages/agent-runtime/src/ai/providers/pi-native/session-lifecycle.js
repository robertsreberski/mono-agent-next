// @ts-check
// Session lifecycle for the pi-native bridge.
//
// Pure moves out of pi-native.js: the durable-repo resolve/reopen, the safe-id
// gate (R4), the resume / create-on-miss / claim flow (I1/I2/I3/I4/I5, R8/F4),
// the keep-alive commit + rollback + drop paths, and sessionUnavailableResult.
// The process-level session storage (the registry + repos) legitimately stays
// module-level here (it must persist across runs); per-RUN state lives on the
// caller-owned runState. Concurrency claims go through the synchronous
// createSessionLiveness primitives so the await-free spans are enforced by
// construction rather than by inline sequencing.

import { InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSessionRegistry } from "../../runtime/sessions.js";
import { createSessionLiveness } from "../../runtime/session-liveness.js";

async function syncPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDurableTranscript(entry) {
  if (!entry.durable) return;
  const path = entry.metadata?.path;
  if (typeof path !== "string" || !path) {
    throw new Error("Durable Pi session metadata is missing its JSONL path");
  }
  // pi-core appends through short-lived file descriptors. Re-open the live
  // JSONL and fsync it, then fsync its containing directory so both transcript
  // bytes and the directory entry are stable before host history commits.
  await syncPath(path);
  await syncPath(dirname(path));
}

async function invalidateNativeSession(entry) {
  await entry.repo.delete(entry.metadata);
  if (entry.durable) {
    const path = entry.metadata?.path;
    if (typeof path !== "string" || !path) {
      throw new Error("Durable Pi session metadata is missing its JSONL path");
    }
    // Make the unlink durable before the registry forgets the busy marker.
    await syncPath(dirname(path));
  }
}

// Live pi-native sessions, keyed by provider session id. Entries are
// { session, metadata, repo, durable, busy } — identical shape and lifecycle
// policy to the (now-retired) pi-sdk bridge: in-memory transcripts are freed
// when the registry evicts them; durable (jsonl) transcripts survive eviction
// so a later resume can reopen them from disk. Registering here gives
// runtime.disposeSession / disposeProviderSession + idle-TTL eviction the same
// reach over native pi sessions that the legacy bridge had.
const nativeSessionRepo = new InMemorySessionRepo();
const nativeSessions = createSessionRegistry({
  isBusy: (entry) => entry.busy === true,
  onSync: syncDurableTranscript,
  onEvict: async (entry, reason) => {
    // Ordinary disposal/TTL only drops the live handle so durable sessions can
    // reopen after restart. Explicit invalidation means the host rejected the
    // turn before canonical history commit; that poisoned transcript must be
    // deleted too or it could silently reappear on the next stable-id resume.
    if (reason === "invalidated") {
      // Destructive invalidation is an honest API: deletion (and, for JSONL,
      // parent-directory fsync) must finish before registry removal, and any
      // failure must reach the caller so it cannot assume cleanup succeeded.
      await invalidateNativeSession(entry);
      return;
    }
    if (entry.durable) return;
    await entry.repo.delete(entry.metadata);
  },
});
const liveness = createSessionLiveness(nativeSessions);

const durableNativeSessionRepos = new Map();

export function resolveDurableNativeSessionRepo(piSessionsRoot) {
  if (typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) return null;
  const root = piSessionsRoot.trim();
  let repo = durableNativeSessionRepos.get(root);
  if (!repo) {
    repo = new JsonlSessionRepo({
      fs: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessionsRoot: root,
    });
    durableNativeSessionRepos.set(root, repo);
  }
  return repo;
}

/**
 * Permanently retire every durable Pi transcript with this exact logical id.
 * This is intentionally stronger than live-session invalidation: history
 * rotation and retention can retire an epoch after its registry entry was
 * already evicted or after a process restart. Absence is success; any cleanup
 * or verification uncertainty rejects so canonical history remains reachable.
 */
export async function retireDurableNativeSession(providerSessionId, piSessionsRoot) {
  if (!isSafeSessionId(providerSessionId)) {
    throw new TypeError("providerSessionId must be a safe, non-empty session id");
  }
  if (typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) {
    throw new TypeError("piSessionsRoot must be a non-empty path");
  }

  // First guarantee this process cannot keep writing through a stale handle.
  // Other processes are serialized by the history coordinator and must pass
  // the same cold-refresh barrier before their next turn.
  await nativeSessions.refresh(providerSessionId);

  const repo = resolveDurableNativeSessionRepo(piSessionsRoot);
  if (!repo) throw new Error("Durable Pi session repository is unavailable");
  const matches = (await repo.list()).filter((entry) => entry?.id === providerSessionId);
  const changedDirectories = new Set();
  for (const metadata of matches) {
    if (typeof metadata?.path !== "string" || !metadata.path) {
      throw new Error(`Durable Pi session ${providerSessionId} has invalid metadata`);
    }
    await repo.delete(metadata);
    changedDirectories.add(dirname(metadata.path));
  }
  for (const directory of changedDirectories) await syncPath(directory);
  if (changedDirectories.size > 0) await syncPath(resolve(piSessionsRoot));

  const remaining = (await repo.list()).filter((entry) => entry?.id === providerSessionId);
  if (remaining.length > 0) {
    throw new Error(`Durable Pi session ${providerSessionId} could not be retired completely`);
  }
}

// Defense in depth (R4): create-on-miss passes the caller-controlled session id
// straight to durableRepo.create({ id }), and JsonlSessionRepo writes
// `${createdAt}_${id}.jsonl` — so an id like "../../../../tmp/pwn" would escape
// piSessionsRoot and name a file anywhere on disk. The harness-derived id is a
// sha256 hex (always safe), but the public runtime API is caller-controlled.
// Only an id that is a single safe filename component may CREATE a session;
// anything else falls through to the existing session_not_found fast-fail, so a
// malicious id can never name a file. (A genuinely on-disk session reopened by
// reopenDurableNativeSession is matched by `.id`, never used to build a path, so
// this gate is confined to the create path.)
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeSessionId(id) {
  return typeof id === "string"
    && SAFE_SESSION_ID.test(id)
    && !id.includes("..")
    && !id.includes("/")
    && !id.includes("\\");
}

async function reopenDurableNativeSession(repo, sessionId) {
  try {
    const metadata = (await repo.list()).find((entry) => entry?.id === sessionId);
    if (!metadata) return null;
    const session = await repo.open(metadata);
    return { session, metadata, repo, durable: true, busy: false };
  } catch {
    return null;
  }
}

function sessionUnavailableResult({
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  sessionId,
  errorMessage,
  failureKind,
  piErrorCode,
  piTransport,
}) {
  return {
    text: null,
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || resolved?.model || null,
    effort: options.effort || null,
    sdk: resolved?.sdk || "pi",
    cancelled: false,
    error: errorMessage,
    failureKind,
    providerSessionId: sessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: sessionId,
      pi_error_code: piErrorCode,
      pi_engine: "native",
      pi_transport_requested: piTransport,
    },
  };
}

/**
 * Resolve the session for this run: warm registry hit, durable cold reopen,
 * create-on-miss (durable resume only), or fresh create. Mutates runState
 * (session / sessionEntry / createdOnMiss / reservation). Returns
 * `{ done: true, result }` for a fast-fail early return (session_not_found /
 * session_busy), else `{ done: false }` to proceed.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{done: true, result: any} | {done: false}>}
 */
export async function resolveSession(runState, {
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  cwd,
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  piTransport,
}) {
  // Resume check first: a session miss must stay cheap (no tool/MCP/harness
  // init). This mirrors the legacy bridge's fail-fast contract.
  if (requestedSessionId) {
    let entry = liveness.adoptIfPresent(requestedSessionId);
    if (!entry && durableRepo) {
      entry = await reopenDurableNativeSession(durableRepo, requestedSessionId);
      if (entry) {
        // TOCTOU guard: the reopen above is an AWAIT, so a second concurrent
        // cold resume could have reopened+inserted its own entry in this
        // window. Re-read the registry and adopt any entry already present so
        // the busy-claim below collapses back to the warm path's synchronous
        // semantics (the loser sees the winner's shared entry with busy===true
        // and returns session_busy). The discarded reopen is just an in-memory
        // jsonl handle (no subprocess/socket), so dropping it is safe.
        const concurrent = liveness.adoptIfPresent(requestedSessionId);
        if (concurrent) {
          entry = concurrent;
        } else {
          nativeSessions.set(requestedSessionId, entry, { idleTimeoutMs: sessionTtlMs });
        }
      }
    }
    if (!entry) {
      if (durableRepo && isSafeSessionId(providerSessionId)) {
        // Create-on-miss (durable resume only): the requested id has no live
        // registry entry AND no JSONL on disk under piSessionsRoot. This is
        // the cross-restart resume case — the harness derives a stable id from
        // the conversationId and passes it before any session exists on a
        // fresh process. Rather than fail with session_not_found (which would
        // make the harness re-send full history into yet another fresh,
        // randomly-named session and orphan future resumes), create a durable
        // session UNDER the requested id so this and every later turn for the
        // conversation resolve to the same on-disk transcript. sessionEntry
        // stays null so this proceeds exactly like a fresh run (prior messages
        // are seeded, the keep-alive success path registers + persists it).
        // The IN-MEMORY resume miss (no durableRepo) — and a create-on-miss
        // with an UNSAFE id (R4) — keep fast-failing below, preserving the
        // existing per-process session_not_found contract.
        //
        // Concurrent-first-turn race (R8): two concurrent first turns for the
        // same durable id would BOTH miss here and BOTH create, producing two
        // transcripts for one logical id (JsonlSessionRepo names files by
        // `${createdAt}_${id}`, so there is no fs-level dedup). Mirror the
        // cold-reopen-race defense: synchronously (NO await) re-check the
        // registry, then reserve the id with a BUSY placeholder before the
        // create await. The get→check→set span MUST stay await-free, so the
        // loser observes the busy placeholder and returns session_busy via the
        // same busy-claim path below — exactly one create per durable id.
        const reservation = liveness.reserve(requestedSessionId, {
          session: null,
          metadata: null,
          repo: durableRepo,
          durable: true,
          busy: true,
        }, sessionTtlMs);
        if (!reservation.ok) {
          // A concurrent caller already reserved/created this id in the window
          // since the miss above. Adopt its entry and fall into the busy-claim
          // logic (session_busy if its turn is in flight, else resume). Cast:
          // @ts-check does not narrow the ReserveResult typedef union on
          // `!reservation.ok`, though the loser branch always carries `entry`.
          entry = /** @type {{entry: any}} */ (reservation).entry;
        } else {
          // Reserved the id with a busy placeholder BEFORE the create await so a
          // second concurrent first turn observes busy and returns session_busy.
          // The keep-alive success path (reservation.commit with busy:false)
          // overwrites this placeholder on success; the drop/abort/catch paths
          // release it. Keyed by requestedSessionId === providerSessionId.
          runState.reservation = reservation;
          runState.session = await durableRepo.create({ id: providerSessionId, cwd: cwd || process.cwd() });
          runState.createdOnMiss = true;
        }
      } else {
        return {
          done: true,
          result: sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: `Pi session ${requestedSessionId} is not live`,
            failureKind: "session_not_found",
            piErrorCode: "pi_session_not_found",
            piTransport,
          }),
        };
      }
    }
    if (entry && !runState.createdOnMiss) {
      // The busy claim MUST stay await-free between the registry adoption
      // above and `entry.busy = true` inside claim(): adopt/reserve/set + this
      // claim are all synchronous, which is what makes the cold-resume race
      // (F4) safe. Do not introduce any await in this span or the TOCTOU window
      // reopens. `claim` re-reads the same registry entry and sets busy in one
      // await-free step; a busy entry loses and returns session_busy.
      const claimed = liveness.claim(requestedSessionId);
      if (!claimed.ok) {
        // claim() can lose two ways: "busy" (the entry adopted above is
        // mid-turn) or "missing" (no live entry). "missing" is UNREACHABLE on
        // this path today — the entry was adopted/reserved synchronously in the
        // await-free span just above, so it is always present here — but branch
        // on it anyway so a future refactor that could drop the entry in this
        // window self-defends with session_not_found instead of a misleading
        // "busy" message. The busy branch is byte-identical to before. Cast:
        // @ts-check does not narrow the ClaimResult union on `!claimed.ok`,
        // though the loser branch always carries `reason`.
        const missing = /** @type {{reason: string}} */ (claimed).reason === "missing";
        return {
          done: true,
          result: sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: missing
              ? `Pi session ${requestedSessionId} is not live`
              : `Pi session ${requestedSessionId} is busy with another turn`,
            failureKind: missing ? "session_not_found" : "session_busy",
            piErrorCode: missing ? "pi_session_not_found" : "pi_session_busy",
            piTransport,
          }),
        };
      }
      runState.sessionEntry = claimed.entry;
      runState.session = claimed.entry.session;
    }
  } else {
    // Fresh runs persist into the durable jsonl repo when piSessionsRoot is
    // set, so a kept-alive session can be reopened from disk after the live
    // entry is evicted; otherwise the in-memory repo is used.
    runState.session = await (durableRepo || nativeSessionRepo)
      .create({ id: providerSessionId, cwd: cwd || process.cwd() });
  }
  return { done: false };
}

/**
 * Drop an uncommitted fresh session (and any create-on-miss reservation) on the
 * pre-request abort path. A resumed (user-owned) session is NEVER deleted
 * (guarded `session && !sessionEntry`).
 * @param {any} runState
 * @param {{durableRepo: any}} params
 */
export async function discardUncommittedSession(runState, { durableRepo }) {
  // Drop a freshly-created non-keep-alive session so an aborted-before-run turn
  // does not leave an orphan jsonl on disk. Guarded `session && !sessionEntry`
  // so a resumed (user-owned) session is NEVER deleted. For a resume no
  // transcript was appended yet (prompt never ran), so the live session is
  // already at its pre-turn leaf and needs no rollback.
  if (runState.session && !runState.sessionEntry) {
    try { await (durableRepo || nativeSessionRepo).delete(await runState.session.getMetadata()); } catch { /* best-effort */ }
  }
  // Drop the create-on-miss BUSY reservation too, else the busy placeholder
  // leaks and every future resume of this conversation's stable id returns
  // session_busy forever (busy entries are never idle-evicted).
  if (runState.reservation) runState.reservation.release();
}

/**
 * Session lifecycle commit: keep-alive registration, resumed-turn rollback, or
 * fresh/non-keep-alive drop. The harness already durably persisted the
 * transcript; this tracks LIVENESS so disposeProviderSession / idle-TTL
 * eviction can reach native sessions, and rolls a failed/aborted resumed turn
 * back to its pre-turn leaf.
 * @param {any} runState
 * @param {any} params
 */
export async function commitSession(runState, {
  options,
  requestedSessionId,
  providerSessionId,
  durableRepo,
  sessionTtlMs,
  externalAbort,
  errorMessage,
  onEvent,
}) {
  const { session, sessionEntry, baselineLeafId, reservation } = runState;
  if (options.sessionKeepAlive === true && !externalAbort && !errorMessage) {
    try {
      if (sessionEntry) {
        // Resumed run: the harness appended this run's turns onto the live
        // session; just re-arm the idle window.
        nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
        // Surface a write failure the harness swallowed: a session that can
        // no longer persist must not pretend to be resumable.
        await session.buildContext();
      } else {
        const metadata = await session.getMetadata();
        const entry = {
          session,
          metadata,
          repo: durableRepo || nativeSessionRepo,
          durable: !!durableRepo,
          busy: false,
        };
        // A create-on-miss reservation is overwritten by its commit (same id);
        // a plain fresh keep-alive run registers directly.
        if (reservation) reservation.commit(entry);
        else nativeSessions.set(providerSessionId, entry, { idleTimeoutMs: sessionTtlMs });
      }
    } catch (err) {
      // Session persistence must never fail the run; drop the (now
      // inconsistent) session instead of resuming from a broken transcript.
      onEvent({
        type: "runtime_warning",
        warning_kind: "pi_session_persist_failed",
        message: err?.message || String(err),
      });
      nativeSessions.delete(providerSessionId);
      if (requestedSessionId) nativeSessions.delete(requestedSessionId);
      const broken = sessionEntry;
      if (broken) {
        try { await broken.repo.delete(broken.metadata); } catch { /* best-effort */ }
      }
    }
  } else if (sessionEntry) {
    // Resumed run that errored (or was aborted): roll the live session back to
    // the leaf captured before this turn so the failed turn never leaks into a
    // later resume. The next resume then sees the last good transcript. The
    // entry stays live (busy is cleared in finally) and its idle TTL re-arms.
    if (baselineLeafId && (errorMessage || externalAbort)) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
  } else {
    // Fresh, non-keep-alive (or failed first) run: never leave a live session
    // behind. A durable jsonl transcript on disk is dropped too, matching the
    // legacy default contract that a non-keep-alive run is not resumable.
    // A create-on-miss BUSY reservation (R8) is released here too so a
    // non-keep-alive / errored / aborted first turn never leaks a busy entry
    // (the success keep-alive path overwrites it with the finalized entry, so
    // it is only this drop branch that must clean it up).
    if (reservation) reservation.release();
    try {
      await (durableRepo || nativeSessionRepo).delete(await session.getMetadata());
    } catch { /* best-effort */ }
  }
}

/**
 * Final abort guard (durable cancel TOCTOU) rollback actions: a resumed session
 * moves to its baseline leaf and drops its live entry; a fresh durable session
 * deletes its jsonl. The orchestrator keeps the abort re-check + return inline
 * so no await sits between the re-check and the return (I10); this only runs the
 * rollback body when the guard fires.
 * @param {any} runState
 * @param {{requestedSessionId: string|null, providerSessionId: string, durableRepo: any}} params
 */
export async function rollbackAbortedTurn(runState, { requestedSessionId, providerSessionId, durableRepo }) {
  const { session, sessionEntry, baselineLeafId } = runState;
  if (sessionEntry) {
    if (baselineLeafId) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    nativeSessions.delete(requestedSessionId);
  } else {
    nativeSessions.delete(providerSessionId);
    try { await (durableRepo || nativeSessionRepo).delete(await session.getMetadata()); } catch { /* best-effort */ }
  }
}

/**
 * Outer-catch session cleanup: drop a just-created fresh durable session, drop a
 * create-on-miss reservation placeholder, and roll a resumed session back to its
 * pre-turn leaf for host/runtime-side throws that landed after the harness
 * already mutated the live session.
 * @param {any} runState
 * @param {{durableRepo: any}} params
 */
export async function cleanupSessionOnThrow(runState, { durableRepo }) {
  const { session, sessionEntry, reservation, baselineLeafId } = runState;
  // Drop a just-created FRESH durable session so a setup/run failure does not
  // leave a resumable orphan jsonl on disk (the success path drops it via the
  // fresh-run branch; the catch must mirror that). Guarded: `session &&
  // !sessionEntry` fires only for fresh runs that actually created a session —
  // NEVER for resumes (sessionEntry is non-null only on resume; deleting a
  // resumed user session here would be data loss) and never when the throw
  // preceded session create.
  if (session && !sessionEntry) {
    try { await (durableRepo || nativeSessionRepo).delete(await session.getMetadata()); } catch { /* best-effort */ }
  }
  // Drop a create-on-miss BUSY placeholder (R8) left in the registry by a throw
  // during/after the reservation — including a throw inside the create await
  // itself, where `session` is still null so the jsonl-delete above is skipped.
  // Never set on a resume (sessionEntry would be non-null), so this never
  // deletes a live user session.
  if (reservation && !sessionEntry) reservation.release();
  // Resumed-session rollback for host/runtime-side throws (e.g. a throwing
  // custom pricing resolver / bridge event callback) that land here AFTER the
  // harness already mutated the live session. Mirrors the success-path
  // rollback: move the live session back to the pre-turn leaf so the failed
  // turn never leaks into a later resume. Gated on `sessionEntry &&
  // baselineLeafId` so it only fires for resumes that captured a baseline.
  if (sessionEntry && baselineLeafId) {
    try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
  }
}
