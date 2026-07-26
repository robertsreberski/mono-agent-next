// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { FetchOtlpTransport } from "../transport.js";
import { signal } from "./helpers.js";

describe("FetchOtlpTransport", () => {
  it("retains only redirect and retry scheduling response headers", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, {
      status: 503,
      headers: {
        location: "/next",
        "retry-after": "17",
        "set-cookie": "collector-secret=must-not-escape",
      },
    })));
    try {
      const response = await new FetchOtlpTransport().send({
        url: "https://collector.example/v1/traces",
        headers: { "content-type": "application/x-protobuf" },
        body: Uint8Array.of(1, 2, 3),
        signal,
      });
      expect(response).toEqual({
        status: 503,
        headers: {
          location: "/next",
          "retry-after": "17",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
