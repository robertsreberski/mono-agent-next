import { describe, expect, it } from "vitest";

import { createInMemoryHistoryStore } from "../history.js";

describe("InMemoryConversationHistoryStore", () => {
  it("preserves the explicit public maxMessages zero semantics", async () => {
    const store = createInMemoryHistoryStore({ maxMessages: 0 });
    await store.append("conversation", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ]);

    await expect(store.load("conversation")).resolves.toEqual([]);
  });

  it("resets only the selected conversation", async () => {
    const store = createInMemoryHistoryStore();
    await store.append("first", [{ role: "user", content: "remove me" }]);
    await store.append("second", [{ role: "assistant", content: "keep me" }]);

    await store.reset("first");

    await expect(store.load("first")).resolves.toEqual([]);
    await expect(store.load("second")).resolves.toEqual([{ role: "assistant", content: "keep me" }]);
  });
});
