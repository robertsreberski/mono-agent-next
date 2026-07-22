/**
 * Gated real-instance e2e. SKIPPED unless `MONO_AGENT_TEST_SUPERMEMORY_BASE_URL` points at a running
 * Supermemory instance (local `supermemory-server` or cloud). With the binary on
 * http://127.0.0.1:6767 and its printed key:
 *
 *   MONO_AGENT_TEST_SUPERMEMORY_BASE_URL=http://127.0.0.1:6767 \
 *   MONO_AGENT_TEST_SUPERMEMORY_API_KEY=sm_... \
 *   pnpm --filter @mono-agent/memory-supermemory test
 *
 * Mirrors the real-Ollama gating convention: CI without an instance skips this entirely.
 */
import { describe, expect, it } from "vitest";

import { createSupermemoryStore } from "../index.js";

const baseUrl = process.env.MONO_AGENT_TEST_SUPERMEMORY_BASE_URL;
const apiKey = process.env.MONO_AGENT_TEST_SUPERMEMORY_API_KEY;
// Ingestion is async (status "queued"); allow generous time for the fact to become searchable.
const INGEST_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!baseUrl)("supermemory live round-trip", () => {
  it("captures a turn and recalls it via search", async () => {
    // Unique container per run so repeated runs don't accrue noise; vary by a fixed marker + index.
    const container = `mono-agent-e2e-${process.pid}`;
    const store = createSupermemoryStore({
      baseUrl: baseUrl as string,
      container,
      ...(apiKey === undefined ? {} : { apiKey }),
      maxBytes: 8_000,
    });

    const marker = `blue-green-${process.pid}`;
    store.scheduleCapture("e2e-conv", `The deploy pipeline uses ${marker} releases on Fridays.`);
    await store.flush();

    const deadline = Date.now() + INGEST_DEADLINE_MS;
    let found = false;
    while (Date.now() < deadline) {
      const block = await store.load("e2e-conv", "deploy pipeline release strategy");
      if (block?.content.includes(marker) === true) {
        found = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    expect(found, `expected the captured fact (${marker}) to be recallable within ${INGEST_DEADLINE_MS}ms`).toBe(true);
    await store.close();
  }, INGEST_DEADLINE_MS + 10_000);
});
