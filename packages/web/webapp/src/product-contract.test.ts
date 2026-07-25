// SPDX-License-Identifier: MIT
import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("packed assistant-ui PWA contract", () => {
  it("uses assistant-ui native quote primitives and toggle-only rail state", async () => {
    const chat = await readFile(new URL("./chat.tsx", import.meta.url), "utf8");
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const rail = await readFile(new URL("./components/AgentRail.tsx", import.meta.url), "utf8");
    const runtime = await readFile(new URL("./runtime.tsx", import.meta.url), "utf8");
    expect(chat).toContain("SelectionToolbarPrimitive.Quote");
    expect(chat).toContain("ComposerPrimitive.QuoteText");
    expect(chat).toContain("ComposerPrimitive.QuoteDismiss");
    expect(chat).not.toContain("thoughtText");
    // Operator activities are projected onto assistant-ui's own part
    // vocabulary and rendered by registered part components, rather than read
    // back out of message metadata by a bespoke feed.
    expect(runtime).toContain("type: \"reasoning\"");
    expect(runtime).toContain("type: \"tool-call\"");
    expect(chat).toMatch(/Reasoning,\s*\n\s*ToolCall,/u);
    expect(chat).not.toContain("metadata.custom?.activities");
    // The rail expands by discrete toggle only; a drag handle would make the
    // layout width a continuously persisted preference.
    expect(rail).toContain("Collapse agent sidebar");
    expect(rail).toContain("Expand agent sidebar");
    for (const source of [app, rail]) expect(source).not.toMatch(/drag|resize/iu);
  });

  it("packs prebuilt assets and precaches assets without API or health responses", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly files: readonly string[] };
    expect(manifest.files).toContain("webapp/dist");
    const index = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    const worker = await readFile(new URL("../dist/sw.js", import.meta.url), "utf8");
    expect(index).toMatch(/assets\/index-[^"]+\.js/u);
    expect(worker).toContain("precacheAndRoute");
    expect(worker).toContain("denylist:[/^\\/api");
    expect(worker).toContain("/^\\/healthz$/");
    expect(worker).not.toContain('url:"api');
    expect(worker).not.toContain('url:"/api');
    await expect(stat(new URL("../dist/manifest.webmanifest", import.meta.url))).resolves.toMatchObject({
      size: expect.any(Number),
    });
  });
});
