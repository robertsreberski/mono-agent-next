import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("packed assistant-ui PWA contract", () => {
  it("composes messages, activity, quotes, threads, and mobile navigation from the native primitives", async () => {
    const messages = await readFile(new URL("./components/Messages.tsx", import.meta.url), "utf8");
    const composer = await readFile(new URL("./components/Composer.tsx", import.meta.url), "utf8");
    const activity = await readFile(new URL("./components/Activity.tsx", import.meta.url), "utf8");
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

    expect(messages).toContain("MessagePrimitive.GroupedParts");
    expect(messages).toContain("SelectionToolbarPrimitive.Quote");
    expect(messages).toContain("ACTIVITY_GROUP_BY");
    expect(messages).not.toContain("thoughtText");
    expect(composer).toContain("ComposerPrimitive.QuoteText");
    expect(composer).toContain("ComposerPrimitive.QuoteDismiss");
    expect(activity).toContain("groupPartByType");
    expect(activity).toContain("ActivityDisclosure");
    expect(activity).toContain("data-streaming");
    expect(activity).toContain("CompactionActivity");
    expect(activity).toContain("OrphanResultActivity");

    expect(app).toContain("ThreadListPrimitive.Root");
    expect(app).toContain("ThreadListPrimitive.Items");
    expect(app).toContain("ThreadListPrimitive.New");
    expect(app).toContain("ThreadListItemPrimitive.Trigger");
    expect(app).toContain("ThreadListItemPrimitive.Archive");
    expect(app).toContain("ThreadListItemPrimitive.Unarchive");
    expect(app).toContain("Collapse agent rail");
    expect(app).toContain("Expand agent rail");
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
