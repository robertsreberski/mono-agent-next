import { describe, expect, it, vi } from "vitest";

describe("runtime-pi module import", () => {
  it("does not access the network or process environment while importing the definition", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access during import"));
    const module = await import("../index.js");
    expect(module.monoAgentModule.manifest).toMatchObject({
      packageName: "@mono-agent/runtime-pi",
      apiVersion: 1,
      kind: "runtime",
      capabilities: [],
    });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
