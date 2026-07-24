import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("packed assistant-ui PWA contract", () => {
  it("composes messages, activity, quotes, threads, and mobile navigation from the native primitives", async () => {
    const messages = await readFile(new URL("./components/Messages.tsx", import.meta.url), "utf8");
    const activity = await readFile(new URL("./components/Activity.tsx", import.meta.url), "utf8");
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const agentRail = await readFile(new URL("./components/AgentRail.tsx", import.meta.url), "utf8");
    const threadSidebar = await readFile(new URL("./components/ThreadSidebar.tsx", import.meta.url), "utf8");
    const quote = await readFile(new URL("./components/assistant-ui/Quote.tsx", import.meta.url), "utf8");

    expect(messages).toContain("MessagePrimitive.GroupedParts");
    expect(quote).toContain("SelectionToolbarPrimitive.Quote");
    expect(messages).toContain("ACTIVITY_GROUP_BY");
    expect(messages).not.toContain("thoughtText");
    expect(quote).toContain("ComposerPrimitive.QuoteText");
    expect(quote).toContain("ComposerPrimitive.QuoteDismiss");
    expect(activity).toContain("groupPartByType");
    expect(activity).toContain("ActivityDisclosure");
    expect(activity).toContain("data-streaming");
    expect(activity).toContain("CompactionActivity");
    expect(activity).toContain("OrphanResultActivity");

    expect(threadSidebar).toContain("ThreadListPrimitive.Root");
    expect(threadSidebar).toContain("ThreadListPrimitive.Items");
    expect(threadSidebar).toContain("ThreadListPrimitive.New");
    expect(threadSidebar).toContain("ThreadListItemPrimitive.Trigger");
    expect(threadSidebar).toContain("ThreadListItemPrimitive.Archive");
    expect(threadSidebar).toContain("ThreadListItemPrimitive.Unarchive");
    expect(agentRail).toContain("Collapse agent rail");
    expect(agentRail).toContain("Expand agent rail");
    expect(app).toContain("mobile-navigation");
    expect(app).toContain("mobile-drawer");
    expect(app).toContain("aria-modal=\"true\"");
    expect(app).toContain("useModalFocus");
    expect(app).not.toMatch(/drag|resize/iu);
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
