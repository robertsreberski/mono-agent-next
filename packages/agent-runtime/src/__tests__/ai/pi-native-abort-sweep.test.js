// Pi-native abort-at-every-await-point sweep.
//
// Fires an external cancel so it lands at each stage of the session lifecycle —
// for BOTH a resumed turn and a create-on-miss (durable first) turn — and asserts
// the three leak invariants after every stage:
//   I2  no leaked durable JSONL (a cancelled turn never commits a second on-disk
//       transcript, and a create-on-miss session is dropped on cancel);
//   I4  no committed cancelled turn (a later resume never sees the cancelled turn);
//   I10 no leaked busy/reserved liveness entry (a subsequent resume of the same id
//       is never wedged as `session_busy`).
//
// The await points enumerated in generatePiNativeResponse + session-lifecycle +
// turn-runner, in execution order, with the cleanup FUNNEL an abort landing at /
// around each collapses into:
//   AP1  resolveSession → repo.list()            (resume cold reopen)   → guard
//   AP2  resolveSession → repo.open()            (resume cold reopen)   → guard
//   AP3  resolveSession → durableRepo.create()   (create-on-miss)       → guard / throw-cleanup
//   AP4  resolveSession → fresh repo.create()    (fresh run)            → guard
//   AP5  buildTurnTools → initPiMcpTools()       (MCP init)             → guard
//   AP6  session.buildContext()                  (baseline count)       → guard
//   AP7  harness.appendMessage() loop            (seeding)              → guard
//   AP8  session.getLeafId()                     (resume baseline)      → guard
//   AP9  discardUncommittedSession()             (pre-run abort guard)  → THE guard funnel
//   AP10 runProactiveCompaction()                (proactive)            → commitSession rollback/drop
//   AP11 harness.prompt()/waitForIdle()          (the provider request) → commitSession rollback/drop
//   AP12 liveInput.stop()                        (teardown)             → commitSession rollback/drop
//   AP13 captureState → session.buildContext()   (state capture)        → commitSession rollback/drop
//   AP14 runStructuredOutputFinalizationRetry()  (conditional)          → commitSession rollback/drop
//   AP15 runReactiveCompaction()                 (conditional)          → commitSession rollback/drop
//   AP16 commitSession()                         (lifecycle commit)     → rollback (resume) / drop (fresh)
//   AP17 rollbackAbortedTurn()                   (I10 final guard)      → THE I10 funnel
//   AP18 closePiMcpClients() (finally)           (MCP teardown)         → always runs
//
// The abort HANDLER is installed only at buildTurnHarness (after AP1-AP5), so an
// abort dispatched during any PRE-prompt await up through AP8 is not observed
// until the pre-run guard (AP9) — that guard is the single funnel for AP1-AP8,
// which is why the sweep drives it via a read-tripped signal rather than trying
// to land inside each internal pi await (those repos/harness awaits are
// pi-owned; instrumenting them would require a production hook, which this
// sweep deliberately avoids — it uses only the abort signal + faux provider +
// onEvent, the same test-side seams the acceptance suite uses). AP10 runs
// AFTER that guard checkpoint has already passed, with the abort handler
// already live, so an abort landing there is handled the same way as AP11
// (real handler-driven abort) and collapses into the commitSession
// rollback/drop funnel, not the AP9 guard.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

let faux = null;
let fauxModels = null;

function setup() {
  faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning: false }],
    tokensPerSecond: undefined,
  });
  fauxModels = createModels();
  fauxModels.setProvider(faux.provider);
  return faux.getModel();
}

beforeEach(() => { faux = null; fauxModels = null; });
afterEach(() => { faux = null; fauxModels = null; });

function runOptions(model, overrides = {}) {
  return {
    model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
    piResolvedModel: model,
    piResolvedModels: fauxModels,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

function transcriptOf(context) {
  return (context?.messages || [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string"
        ? message.content
        : (message.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");
      return `${message.role}:${text}`;
    });
}

function countJsonlFiles(root) {
  let count = 0;
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, dirent.name);
    if (dirent.isDirectory()) count += countJsonlFiles(full);
    else if (dirent.name.endsWith(".jsonl")) count += 1;
  }
  return count;
}

// A programmable AbortSignal-like object.
//   - `.aborted` getter counts reads and can be armed to flip true at read N
//     (models "the flag was set during the Nth-observed setup await");
//   - `fire()` performs a real abort() — sets the flag AND dispatches the
//     registered handler (models a cancel racing an active run);
//   - handler capture lets the sweep confirm the harness wired its abort handler.
function makeSignal() {
  let aborted = false;
  let reads = 0;
  let tripAtRead = Infinity;
  let addCount = 0; // total handler registrations (never decremented on remove)
  const handlers = new Set();
  return {
    signal: {
      get aborted() {
        reads += 1;
        if (reads >= tripAtRead) aborted = true;
        return aborted;
      },
      reason: undefined,
      addEventListener(type, handler) { if (type === "abort") { handlers.add(handler); addCount += 1; } },
      removeEventListener(type, handler) { handlers.delete(handler); },
    },
    fire() { aborted = true; for (const handler of [...handlers]) handler(); },
    tripAt(n) { tripAtRead = n; },
    abortNow() { aborted = true; },
    get reads() { return reads; },
    // Total registrations seen (the finally removes the handler, so `handlers`
    // is empty post-run — this proves the harness DID wire one).
    get addCount() { return addCount; },
  };
}

// Establish a durable keep-alive session (turn-1, no abort) under `root`, then
// return its id so a later turn-2 can resume it.
async function establishResumeSession(model, root) {
  faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
  const first = await generatePiNativeResponse("system", runOptions(model, {
    messages: [{ role: "user", content: "turn-1" }],
    sessionKeepAlive: true,
    piSessionsRoot: root,
  }));
  expect(first.error).toBeNull();
  expect(countJsonlFiles(root)).toBe(1);
  return first.providerSessionId;
}

// Assert a resumed session survived a cancelled turn-2: exactly one durable
// transcript (no leak), no busy wedge, and a clean turn-3 resume that does NOT
// replay the cancelled turn-2.
async function assertResumeUnwedgedAndClean(model, root, sessionId) {
  expect(countJsonlFiles(root)).toBe(1);
  let retryContext = null;
  faux.setResponses([
    (context) => { retryContext = context; return fauxAssistantMessage([fauxText("reply-3")]); },
  ]);
  const third = await generatePiNativeResponse("system", runOptions(model, {
    messages: [{ role: "user", content: "turn-3" }],
    sessionKeepAlive: true,
    sessionId,
    piSessionsRoot: root,
  }));
  expect(third.error).toBeNull();
  expect(third.failureKind).not.toBe("session_busy");
  expect(third.diagnostics?.pi_error_code).not.toBe("pi_session_busy");
  // The cancelled turn-2 (and any reply-2) must be absent — only turn-1 + turn-3.
  expect(transcriptOf(retryContext)).toEqual(["user:turn-1", "assistant:reply-1", "user:turn-3"]);
}

// Assert a create-on-miss id is not wedged after a cancelled first turn: no
// leaked jsonl, and a fresh (non-aborted) first turn create-on-misses again and
// sees ONLY its own turn — never the cancelled turn's transcript.
async function assertCreateOnMissUnwedged(model, root, derivedId) {
  expect(countJsonlFiles(root)).toBe(0);
  let nextContext = null;
  faux.setResponses([
    (context) => { nextContext = context; return fauxAssistantMessage([fauxText("reply-after")]); },
  ]);
  const next = await generatePiNativeResponse("system", runOptions(model, {
    messages: [{ role: "user", content: "turn-after" }],
    sessionKeepAlive: true,
    sessionId: derivedId,
    piSessionsRoot: root,
  }));
  expect(next.error).toBeNull();
  expect(next.text).toBe("reply-after");
  expect(next.diagnostics?.pi_error_code).not.toBe("pi_session_busy");
  expect(transcriptOf(nextContext)).toEqual(["user:turn-after"]);
  expect(countJsonlFiles(root)).toBe(1);
}

function withRoot(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("pi-native abort sweep — entry (OP0, before any session work)", () => {
  it("resume: an already-aborted signal returns cancelled with no provider call and no session touch", async () => {
    const model = setup();
    await withRoot("pi-abort-entry-resume-", async (root) => {
      const sessionId = await establishResumeSession(model, root);
      const sig = makeSignal();
      sig.abortNow();
      let invoked = false;
      faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId,
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      expect(invoked).toBe(false);
      await assertResumeUnwedgedAndClean(model, root, sessionId);
    });
  });

  it("create-on-miss: an already-aborted signal creates nothing and does not wedge the id", async () => {
    const model = setup();
    await withRoot("pi-abort-entry-onmiss-", async (root) => {
      const sig = makeSignal();
      sig.abortNow();
      let invoked = false;
      faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-entry-id",
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      expect(invoked).toBe(false);
      expect(countJsonlFiles(root)).toBe(0);
      await assertCreateOnMissUnwedged(model, root, "onmiss-entry-id");
    });
  });
});

describe("pi-native abort sweep — pre-run guard (AP9, funnels AP1-AP8)", () => {
  // The signal reads false at the entry check (OP0, read #1) and true at the
  // pre-run guard (read #2) — modeling an abort that fired during any pre-prompt
  // await, observed at the single guard funnel.
  it("resume: guard aborts before the provider call; the resumed session is preserved and unwedged", async () => {
    const model = setup();
    await withRoot("pi-abort-guard-resume-", async (root) => {
      const sessionId = await establishResumeSession(model, root);
      const sig = makeSignal();
      sig.tripAt(2);
      let invoked = false;
      faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId,
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      expect(invoked).toBe(false);
      expect(sig.addCount).toBe(1); // the harness DID wire its abort handler (removed in finally)
      await assertResumeUnwedgedAndClean(model, root, sessionId);
    });
  });

  it("create-on-miss: guard drops the fresh durable session AND releases the busy reservation (no wedge, no jsonl)", async () => {
    const model = setup();
    await withRoot("pi-abort-guard-onmiss-", async (root) => {
      const sig = makeSignal();
      sig.tripAt(2);
      let invoked = false;
      faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-guard-id",
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      expect(invoked).toBe(false);
      await assertCreateOnMissUnwedged(model, root, "onmiss-guard-id");
    });
  });
});

describe("pi-native abort sweep — during the provider request (AP11, handler-driven)", () => {
  // The faux provider fires a real abort() mid-request (sets the flag + dispatches
  // the harness's abort handler). The run completes, then commitSession takes the
  // rollback (resume) / drop (create-on-miss) path.
  it("resume: a cancel during the request rolls the resumed turn back to its pre-turn leaf", async () => {
    const model = setup();
    await withRoot("pi-abort-prompt-resume-", async (root) => {
      const sessionId = await establishResumeSession(model, root);
      const sig = makeSignal();
      faux.setResponses([() => { sig.fire(); return fauxAssistantMessage([fauxText("reply-2")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId,
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      await assertResumeUnwedgedAndClean(model, root, sessionId);
    });
  });

  it("create-on-miss: a cancel during the request drops the fresh session and its reservation", async () => {
    const model = setup();
    await withRoot("pi-abort-prompt-onmiss-", async (root) => {
      const sig = makeSignal();
      faux.setResponses([() => { sig.fire(); return fauxAssistantMessage([fauxText("reply-1")]); }]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-prompt-id",
        piSessionsRoot: root,
        abortSignal: sig.signal,
      }));
      expect(aborted.cancelled).toBe(true);
      await assertCreateOnMissUnwedged(model, root, "onmiss-prompt-id");
    });
  });
});

describe("pi-native abort sweep — post-run TOCTOU (OP3, commitSession decision)", () => {
  // The cancel lands at run-end (flipped on capabilities_resolved, which fires
  // immediately before the session-lifecycle commit): commitSession must take the
  // rollback/drop path instead of committing the cancelled turn.
  it("resume: cancel at commit-decision rolls back (no committed cancelled turn)", async () => {
    const model = setup();
    await withRoot("pi-abort-toctou-resume-", async (root) => {
      const sessionId = await establishResumeSession(model, root);
      const sig = makeSignal();
      faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId,
        piSessionsRoot: root,
        abortSignal: sig.signal,
        onEvent: (event) => { if (event?.type === "capabilities_resolved") sig.fire(); },
      }));
      expect(aborted.cancelled).toBe(true);
      expect(aborted.error).toBeNull();
      await assertResumeUnwedgedAndClean(model, root, sessionId);
    });
  });

  it("create-on-miss: cancel at commit-decision drops the fresh session (no leak, no wedge)", async () => {
    const model = setup();
    await withRoot("pi-abort-toctou-onmiss-", async (root) => {
      const sig = makeSignal();
      faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
      const aborted = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-toctou-id",
        piSessionsRoot: root,
        abortSignal: sig.signal,
        onEvent: (event) => { if (event?.type === "capabilities_resolved") sig.fire(); },
      }));
      expect(aborted.cancelled).toBe(true);
      await assertCreateOnMissUnwedged(model, root, "onmiss-toctou-id");
    });
  });
});

describe("pi-native abort sweep — final abort guard (AP17, I10)", () => {
  // The cancel lands AFTER commitSession already committed the keep-alive session
  // but BEFORE the return — the exact I10 window. Driven by tripping the signal at
  // the LAST `.aborted` read (learned from a clean dry run of the same shape), so
  // the guard (`!externalAbort && aborted`) fires and rollbackAbortedTurn undoes
  // the just-committed turn. Asserts the robust I2/I4/I10 invariants (no jsonl
  // leak, no busy wedge, treated as cancelled) without depending on cold-reopen
  // leaf semantics.
  it("resume: a cancel in the post-commit window rolls back via the I10 guard", async () => {
    const model = setup();
    await withRoot("pi-abort-i10-resume-", async (root) => {
      // Dry run (never trips) to learn the clean `.aborted` read count; the last
      // read on the success path is the I10 guard.
      const probeId = await establishResumeSession(model, root);
      const probe = makeSignal();
      faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
      await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId: probeId,
        piSessionsRoot: root,
        abortSignal: probe.signal,
      }));
      const lastRead = probe.reads;
      expect(lastRead).toBeGreaterThanOrEqual(3);

      // Real run against a FRESH durable session; trip exactly at the last read.
      await withRoot("pi-abort-i10-resume-real-", async (realRoot) => {
        const sessionId = await establishResumeSession(model, realRoot);
        const sig = makeSignal();
        sig.tripAt(lastRead);
        faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
        const aborted = await generatePiNativeResponse("system", runOptions(model, {
          messages: [{ role: "user", content: "turn-2" }],
          sessionKeepAlive: true,
          sessionId,
          piSessionsRoot: realRoot,
          abortSignal: sig.signal,
        }));
        expect(aborted.cancelled).toBe(true);
        // No SECOND transcript leaked, and the id is not wedged busy.
        expect(countJsonlFiles(realRoot)).toBe(1);
        faux.setResponses([fauxAssistantMessage([fauxText("reply-3")])]);
        const third = await generatePiNativeResponse("system", runOptions(model, {
          messages: [{ role: "user", content: "turn-3" }],
          sessionKeepAlive: true,
          sessionId,
          piSessionsRoot: realRoot,
        }));
        expect(third.diagnostics?.pi_error_code).not.toBe("pi_session_busy");
      });
    });
  });

  it("create-on-miss: a cancel in the post-commit window drops the committed fresh session via the I10 guard", async () => {
    const model = setup();
    await withRoot("pi-abort-i10-onmiss-probe-", async (probeRoot) => {
      // Learn the clean read count on a create-on-miss success path.
      const probe = makeSignal();
      faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
      await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-i10-probe",
        piSessionsRoot: probeRoot,
        abortSignal: probe.signal,
      }));
      const lastRead = probe.reads;

      await withRoot("pi-abort-i10-onmiss-real-", async (realRoot) => {
        const sig = makeSignal();
        sig.tripAt(lastRead);
        faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
        const aborted = await generatePiNativeResponse("system", runOptions(model, {
          messages: [{ role: "user", content: "turn-1" }],
          sessionKeepAlive: true,
          sessionId: "onmiss-i10-real",
          piSessionsRoot: realRoot,
          abortSignal: sig.signal,
        }));
        expect(aborted.cancelled).toBe(true);
        await assertCreateOnMissUnwedged(model, realRoot, "onmiss-i10-real");
      });
    });
  });
});

describe("pi-native abort sweep — throw funnel (outer catch, cleanupSessionOnThrow)", () => {
  // A host-side throw (from onEvent on provider_request_started, before the inner
  // prompt try) lands in the outer catch; cleanupSessionOnThrow must drop a fresh
  // create-on-miss session + release its reservation, and roll a resumed session
  // back to its pre-turn leaf.
  it("create-on-miss: a throw during setup releases the reservation and leaves no jsonl", async () => {
    const model = setup();
    await withRoot("pi-throw-onmiss-", async (root) => {
      faux.setResponses([fauxAssistantMessage([fauxText("never reached")])]);
      const failed = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: "onmiss-throw-id",
        piSessionsRoot: root,
        onEvent: (event) => { if (event?.type === "provider_request_started") throw new Error("setup-boom"); },
      }));
      expect(failed.error).toBe("setup-boom");
      // The reservation + fresh durable session are cleaned up: no jsonl, no wedge.
      await assertCreateOnMissUnwedged(model, root, "onmiss-throw-id");
    });
  });

  it("resume: a throw after the provider succeeded rolls the resumed turn back (no committed failed turn)", async () => {
    const model = setup();
    await withRoot("pi-throw-resume-", async (root) => {
      const sessionId = await establishResumeSession(model, root);
      faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
      const failed = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId,
        piSessionsRoot: root,
        // Throws AFTER the prompt ran (estimateCost invokes resolveCustomPricing),
        // landing in the outer catch with the live session already mutated.
        resolveCustomPricing: () => { throw new Error("pricing-boom"); },
      }));
      expect(failed.error).toBeTruthy();
      expect(failed.cancelled).toBe(false);
      await assertResumeUnwedgedAndClean(model, root, sessionId);
    });
  });
});
