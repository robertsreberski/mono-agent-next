import { describe, expect, it } from "vitest";

import { sanitizeInboundHttpHeaders } from "../index.js";

describe("sanitizeInboundHttpHeaders", () => {
  it("removes every shared sensitive header case-insensitively and preserves safe headers", () => {
    const headers = {
      Authorization: "Bearer fixture-auth-secret",
      COOKIE: "session=fixture-cookie-secret",
      "Set-Cookie": ["session=fixture-response-cookie-secret"],
      "Proxy-Authorization": "Bearer fixture-proxy-secret",
      "X-Api-Key": "fixture-api-key-secret",
      "content-type": "application/json",
      "x-request-id": "safe-request-id",
    };

    expect(sanitizeInboundHttpHeaders(headers)).toEqual({
      "content-type": "application/json",
      "x-request-id": "safe-request-id",
    });
    expect(headers).toHaveProperty("Authorization", "Bearer fixture-auth-secret");
  });
});
