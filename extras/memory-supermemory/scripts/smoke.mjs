#!/usr/bin/env node

import { createSupermemoryStore } from "../dist/index.js";

const baseUrl = process.env.MONO_AGENT_TEST_SUPERMEMORY_BASE_URL;
if (baseUrl === undefined || baseUrl.trim().length === 0) {
  console.error(
    "Set MONO_AGENT_TEST_SUPERMEMORY_BASE_URL to the local or hosted Supermemory service to run this data-writing smoke test.",
  );
  process.exitCode = 2;
} else {
  await smoke(baseUrl);
}

async function smoke(serviceUrl) {
  const marker = `mono-agent-plugin-smoke-${Date.now()}-${process.pid}`;
  const store = createSupermemoryStore({
    baseUrl: serviceUrl,
    container: marker,
    ...(process.env.MONO_AGENT_TEST_SUPERMEMORY_API_KEY === undefined
      ? {}
      : { apiKey: process.env.MONO_AGENT_TEST_SUPERMEMORY_API_KEY }),
  });
  try {
    store.scheduleCapture("smoke", `The unique verification marker is ${marker}.`);
    await store.flush();

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const hits = await store.recall(marker, { topK: 3 });
      if (hits.some((hit) => hit.record.text.includes(marker))) {
        console.log(`Supermemory plugin smoke passed for ${serviceUrl}.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("captured marker was not recallable within 60 seconds");
  } finally {
    await store.close();
  }
}
