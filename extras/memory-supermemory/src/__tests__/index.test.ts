import { describe, expect, it } from "vitest";

import { createSupermemoryStore, validateSupermemoryConfig } from "../index.js";

describe("Supermemory plugin configuration", () => {
  it("accepts a keyless local service", () => {
    expect(validateSupermemoryConfig({
      baseUrl: "http://127.0.0.1:6767",
      container: "example-agent",
    })).toEqual({ valid: true, errors: [] });
  });

  it("owns deterministic validation before constructing a store", () => {
    const config = {
      baseUrl: "file:///tmp/memory",
      apiKey: "",
      container: " ",
      timeoutMs: 0,
      searchLimit: 1.5,
      threshold: 2,
    } as const;

    expect(validateSupermemoryConfig(config)).toEqual({
      valid: false,
      errors: [
        "baseUrl must use http or https.",
        "container must not be empty.",
        "apiKey must be omitted rather than set to an empty value.",
        "timeoutMs must be greater than zero.",
        "searchLimit must be a positive integer.",
        "threshold must be between 0 and 1.",
      ],
    });
    expect(() => createSupermemoryStore(config)).toThrow(
      /Invalid Supermemory configuration/u,
    );
  });
});
