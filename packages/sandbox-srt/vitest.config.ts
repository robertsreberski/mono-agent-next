// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These cases spawn and reap real SRT processes -- one of them ten times in
    // sequence -- so they run in seconds, not milliseconds. Against Vitest's
    // 5s per-test default that left no margin: the suite completes in ~7.8s on
    // an idle runner but ~11.5s under the contention `pnpm run test` produces
    // across the whole workspace, and whichever case happened to be slowest
    // then blew the default and failed. The bound still exists and is still
    // enforced; it is now sized to what the tests actually do.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
