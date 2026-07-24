import { expect, test, type Locator, type Page } from "@playwright/test";

import { openFixtureConsole } from "./fixtures/console-fixtures";

test.describe("assistant-ui console behavior contract", () => {
  test("header popovers are actionable, exclusive, and dismissible", async ({ page }) => {
    await openFixtureConsole(page, "settled");

    const contextTrigger = page.getByRole("button", { name: "Context usage" });
    const actionsTrigger = page.getByRole("button", { name: "Conversation actions" });

    await contextTrigger.click();
    const contextDialog = page.getByRole("dialog", { name: "Context usage" });
    await expect(contextDialog).toBeVisible();
    await expectReceivesPointerEvents(contextDialog);

    await actionsTrigger.click();
    await expect(contextDialog).toBeHidden();
    const actionsMenu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(actionsMenu).toBeVisible();
    const renameAction = actionsMenu.getByRole("menuitem", { name: "Rename" });
    const archiveAction = actionsMenu.getByRole("menuitem", { name: "Archive" });
    await expect(renameAction).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(archiveAction).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(renameAction).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(archiveAction).toBeFocused();
    await renameAction.click({ trial: true });
    await archiveAction.click({ trial: true });

    await page.keyboard.press("Tab");
    await expect(actionsMenu).toBeHidden();
    await expect(page.getByRole("button", { name: "Copy message" })).toBeFocused();

    await actionsTrigger.focus();
    await page.keyboard.press("ArrowUp");
    await expect(actionsMenu).toBeVisible();
    await expect(archiveAction).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actionsMenu).toBeHidden();
    await expect(actionsTrigger).toBeFocused();

    await contextTrigger.click();
    await expect(contextDialog).toBeVisible();
    await page.getByRole("heading", { name: "Beta architecture review" }).click();
    await expect(contextDialog).toBeHidden();
  });

  test("popover initial focus skips CSS-hidden descendants", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled");
    await page.addStyleTag({
      content: `
        .thread-menu-panel > [role="menuitem"]:first-child {
          display: none !important;
        }
      `,
    });

    await page.getByRole("button", { name: "Conversation actions" }).click();
    await expect(
      page.getByRole("menu", { name: "Conversation actions" })
        .getByRole("menuitem", { name: "Archive" }),
    ).toBeFocused();

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Run settings" }).click();
    await page.getByLabel("Model").selectOption({
      label: "Codex shared route — codex-app-server",
    });
    await page.keyboard.press("Escape");
    await page.addStyleTag({
      content: `
        .composer-settings-panel > label:first-child {
          visibility: hidden !important;
        }
      `,
    });
    await page.getByRole("button", { name: "Run settings" }).click();
    await expect(page.getByLabel("Reasoning effort")).toBeFocused();
  });

  test("run settings waits for the initial model control", async ({ page }, testInfo) => {
    test.skip(
      !["chromium-desktop", "chromium-mobile"].includes(testInfo.project.name),
      "Desktop and mobile exercise the initial console-refresh focus path.",
    );
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Run settings" }).click();
    await expect(page.getByLabel("Model")).toBeFocused();
  });

  test("run settings remain actionable without covering the latest response", async (
    { page },
    testInfo,
  ) => {
    test.skip(
      !["chromium-compact-desktop", "chromium-tablet"].includes(testInfo.project.name),
      "Compact-height and tablet lanes exercise collision handling.",
    );
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Run settings" }).click();
    const panel = page.getByRole("dialog", { name: "Run settings" });
    const lastResponse = page.locator(".message-assistant").last();
    await expect(panel).toBeVisible();
    await expect(lastResponse).toBeVisible();
    await expectReceivesPointerEvents(panel);
    await expectNoIntersection(panel, lastResponse);
    await expectInsideViewport(page, panel);
    await page.getByLabel("Model").click({ trial: true });
    await page.getByLabel("Reasoning effort").click({ trial: true });
  });

  test("model routes and effort choices submit as one atomic override", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const fixture = await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Run settings" }).click();
    const model = page.getByLabel("Model");
    const effort = page.getByLabel("Reasoning effort");

    await expect(model).toHaveValue("");
    await expect(effort).toHaveValue("");
    await expect(page.getByLabel("Runtime ID")).toHaveCount(0);
    await model.selectOption({ label: "Codex shared route — codex-app-server" });
    await expect(effort.locator("option")).toHaveText([
      "Default effort",
      "low",
      "medium",
      "high",
    ]);
    await effort.selectOption("high");

    await messageInput(page).fill("Use the selected route.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => fixture.turnRequests.length).toBe(1);
    expect(fixture.turnRequests[0]).toEqual({
      threadId: "thread-settled",
      input: {
        text: "Use the selected route.",
        runtime: "codex-app-server",
        model: "shared-model",
        effort: "high",
      },
    });
  });

  test("default run settings omit runtime, model, and effort overrides", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const fixture = await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Run settings" }).click();
    await expect(page.getByLabel("Model")).toHaveValue("");
    await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
    await messageInput(page).fill("Use configured defaults.");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect.poll(() => fixture.turnRequests.length).toBe(1);
    expect(fixture.turnRequests[0]).toEqual({
      threadId: "thread-settled",
      input: { text: "Use configured defaults." },
    });
  });

  test("missing effort metadata never becomes a free-form guessing field", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled", { effortMetadata: "missing" });

    await page.getByRole("button", { name: "Run settings" }).click();
    const effort = page.getByLabel("Reasoning effort");
    await expect(effort).toHaveCount(1);
    await expect(effort).toHaveJSProperty("tagName", "SELECT");
    await expect(effort.locator("option")).toHaveText(["Default effort"]);
    await expect(effort).toHaveValue("");
  });

  test("mobile navigation is first in keyboard order", async ({ page }, testInfo) => {
    test.skip(!isTouchLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Choose agent" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Open conversations" })).toBeFocused();
  });

  test("context usage uses authoritative telemetry rather than token arithmetic", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Context usage" }).click();
    const context = page.getByRole("dialog", { name: "Context usage" });
    await expect(context.getByText("7,944", { exact: true })).toBeVisible();
    await expect(context.getByText("511", { exact: true })).toBeVisible();
    await expect(context.getByText("61,337", { exact: true })).toBeVisible();
    await expect(context.getByText("272,000", { exact: true })).toBeVisible();
    await expect(context.getByText("8,455", { exact: true })).toHaveCount(0);
  });

  test("a running latest response does not present prior context as current", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "running", { priorCompletedTelemetry: true });

    const contextTrigger = page.getByRole("button", { name: "Context usage" });
    await expect(contextTrigger).toContainText("Context pending");
    await contextTrigger.click();
    const context = page.getByRole("dialog", { name: "Context usage" });
    await expect(context.getByText(/not available for the active response yet/iu)).toBeVisible();
    await expect(context.getByText("75,444", { exact: true })).toHaveCount(0);
  });

  test("Activity follows running-open and settled-collapsed state", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "running");
    const runningActivity = page.getByRole("button", { name: /^Activity/u }).last();
    await expect(runningActivity).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Reading the beta verification report")).toBeVisible();

    await openFixtureConsole(page, "settled");
    const settledActivity = page.getByRole("button", { name: /^Activity/u }).last();
    await expect(settledActivity).toHaveAttribute("aria-expanded", "false");
    await settledActivity.click();
    await expect(page.getByText("CheckArchitecture", { exact: true })).toBeVisible();
    await expect(page.getByText("Context compacted", { exact: true })).toBeVisible();
    await expect(page.getByText("18.4k → 7.2k tokens", { exact: true })).toBeVisible();
  });

  test("out-of-order thread loads cannot replace the current conversation", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled", {
      threadResponseDelays: { "thread-interactive": 300 },
    });

    await page.getByRole("button", { name: "Open Approve launch notes" }).click();
    await expect(page.getByRole("heading", { name: "Approve launch notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.getByRole("button", { name: "Open Beta architecture review" }).click();

    await expect(page.getByRole("heading", { name: "Beta architecture review" })).toBeVisible();
    await expect(page.getByText("23 publishable packages")).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.getByRole("heading", { name: "Beta architecture review" })).toBeVisible();
    await expect(page.getByText("23 publishable packages")).toBeVisible();
    await expect(page.getByText("The approved beta checklist is ready for review.")).toHaveCount(0);
  });

  test("a late stream frame cannot overwrite a newly selected thread", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const fixture = await openFixtureConsole(page, "settled", {
      turnResponseDelayMs: 600,
    });

    await messageInput(page).fill("Start a delayed response.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => fixture.turnRequests.length).toBe(1);
    await page.getByRole("button", { name: "Open Approve launch notes" }).click();

    await expect(page.getByRole("heading", { name: "Approve launch notes" })).toBeVisible();
    await expect(page.getByText("The approved beta checklist is ready for review.")).toBeVisible();
    await page.evaluate(() => {
      const recordMismatch = () => {
        const title = document.querySelector(".chat-header h1")?.textContent;
        if (
          title === "Approve launch notes"
          && document.body.textContent?.includes("23 publishable packages")
        ) {
          document.body.dataset.streamThreadMismatch = "true";
        }
      };
      new MutationObserver(recordMismatch).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await page.waitForTimeout(700);
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-stream-thread-mismatch",
      "true",
    );
    await expect(page.getByRole("heading", { name: "Approve launch notes" })).toBeVisible();
    await expect(page.getByText("The approved beta checklist is ready for review.")).toBeVisible();
  });

  test("an attachment-only turn is sendable and preserves the file payload", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const fixture = await openFixtureConsole(page, "settled");

    await stageFixtureFile(page, "evidence.txt");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await page.getByRole("button", { name: "Send message" }).click();

    await expect.poll(() => fixture.turnRequests.length).toBe(1);
    const request = fixture.turnRequests[0];
    expect(request?.threadId).toBe("thread-settled");
    expect(request?.input.text).toBe("");
    expect(request?.input.attachments).toHaveLength(1);
    expect(request?.input.attachments?.[0]).toMatchObject({
      name: "evidence.txt",
      mediaType: "text/plain",
    });
    expect(request?.input.attachments?.[0]?.url).toMatch(/^data:text\/plain;base64,/u);
  });

  test("a failed turn restores text and files without an unhandled rejection", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const fixture = await openFixtureConsole(page, "settled", {
      turnFailure: "The fixture transport rejected this turn.",
    });

    await stageFixtureFile(page, "retry.txt");
    await stageQuote(page);
    const composer = messageInput(page);
    await composer.fill("Keep this exact retry draft.");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "The fixture transport rejected this turn.",
    );
    await expect(composer).toHaveValue("Keep this exact retry draft.");
    await expect(page.getByText("retry.txt", { exact: true })).toBeVisible();
    await expect(page.locator(".composer-quote-text")).toHaveText("Yes.");
    await expect(page.getByRole("button", { name: "Remove quote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(fixture.turnRequests[0]?.input.quote).toMatchObject({
      conversationId: "web:thread-settled",
      messageId: "operator-settled-response",
    });
    expect(fixture.turnRequests[0]?.input.quote?.text).toContain("23 publishable packages");
    expect(pageErrors).toEqual([]);
  });

  test("a failed AskUser submission keeps the selected answer", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openFixtureConsole(page, "interactive", {
      askFailure: "The fixture could not submit this answer.",
    });

    const answer = page.getByRole("radio", { name: /Brief summary/iu });
    await answer.check();
    await page.getByRole("button", { name: "Submit answer" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "The fixture could not submit this answer.",
    );
    await expect(answer).toBeChecked();
    await expect(page.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test("only authoritative assistant text can become a quote", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled");

    const activity = page.getByRole("button", { name: /^Activity/u }).last();
    await activity.click();
    await selectText(page.getByText("CheckArchitecture", { exact: true }), 0, 5);
    await expect(page.getByRole("button", { name: "Quote" })).toHaveCount(0);

    await stageQuote(page);
    await expect(page.locator(".composer-quote-text")).toHaveText("Yes.");
  });

  test("selection toolbar cannot pierce a mobile modal", async ({ page }, testInfo) => {
    test.skip(!isTouchLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    await selectText(page.locator(".message-assistant .markdown").last(), 0, 4);
    await expect(page.getByRole("button", { name: "Quote" })).toBeVisible();
    await page.getByRole("button", { name: "Open conversations" }).click();

    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quote" })).toBeHidden();
  });

  test("scroll-to-latest keeps its circular geometry", async ({ page }, testInfo) => {
    test.skip(
      !["chromium-compact-desktop", "chromium-mobile"].includes(testInfo.project.name),
    );
    await openFixtureConsole(page, "settled", { denseTranscript: true });

    await page.locator(".thread-viewport").evaluate((viewport) => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const scrollToLatest = page.getByRole("button", { name: "Scroll to latest" });
    await expect(scrollToLatest).toBeVisible();
    const bounds = await scrollToLatest.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBe(34);
    expect(bounds?.height).toBe(34);
    await scrollToLatest.click({ trial: true });
  });

  test("mobile controls expose touch-sized hit regions", async ({ page }, testInfo) => {
    test.skip(!isTouchLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    const controls = [
      page.getByRole("button", { name: "Choose agent" }),
      page.getByRole("button", { name: "Open conversations" }),
      page.getByRole("button", { name: "Context usage" }),
      page.getByRole("button", { name: "Conversation actions" }),
      page.getByRole("button", { name: "Attach files" }),
      page.getByRole("button", { name: "Run settings" }),
      page.getByRole("button", { name: "Copy response" }),
    ];
    for (const control of controls) await expectMinimumTarget(control, 44);
  });

  test("collapsed touch rail preserves the complete agent selection target", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name !== "chromium-touch-desktop");
    await openFixtureConsole(page, "settled");

    const agent = page.getByRole("button", { name: /Personal Agent, online, pinned/iu });
    const pin = page.getByRole("button", { name: "Unpin Personal Agent" });
    await expect(agent).toBeVisible();
    await expectMinimumTarget(agent, 48);
    await expect(pin).toBeHidden();
    await expect.poll(async () => agent.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const inset = 2;
      return [
        [bounds.left + bounds.width / 2, bounds.top + inset],
        [bounds.right - inset, bounds.top + bounds.height / 2],
        [bounds.left + bounds.width / 2, bounds.bottom - inset],
        [bounds.left + inset, bounds.top + bounds.height / 2],
        [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
      ].every(([x, y]) => {
        const hit = document.elementFromPoint(x ?? 0, y ?? 0);
        return hit === element || (hit !== null && element.contains(hit));
      });
    })).toBe(true);

    await page.getByRole("button", { name: "Expand agent rail" }).click();
    await expect(pin).toBeVisible();
    const agentRow = agent.locator("..");
    await expectMinimumTarget(agent, 44);
    await expectMinimumTarget(pin, 44);
    await expectNoIntersection(agent, pin);
    await expectInsideContainer(agentRow, agent);
    await expectInsideContainer(agentRow, pin);
    await agent.click({ trial: true });
    await pin.click({ trial: true });
  });

  test("mobile drawer isolates background controls from focus", async ({ page }, testInfo) => {
    test.skip(!isTouchLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    const trigger = page.getByRole("button", { name: "Open conversations" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Conversations" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => exposedBackgroundControls(page, dialog)).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

async function expectReceivesPointerEvents(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(async () => locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return hit !== null && (hit === element || element.contains(hit));
  })).toBe(true);
}

async function expectNoIntersection(first: Locator, second: Locator): Promise<void> {
  const [firstBounds, secondBounds] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ]);
  expect(firstBounds).not.toBeNull();
  expect(secondBounds).not.toBeNull();
  if (firstBounds === null || secondBounds === null) return;
  const intersects =
    firstBounds.x < secondBounds.x + secondBounds.width
    && firstBounds.x + firstBounds.width > secondBounds.x
    && firstBounds.y < secondBounds.y + secondBounds.height
    && firstBounds.y + firstBounds.height > secondBounds.y;
  expect(intersects).toBe(false);
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const inside = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return (
      bounds.left >= 0
      && bounds.top >= 0
      && bounds.right <= window.innerWidth
      && bounds.bottom <= window.innerHeight
    );
  });
  expect(inside).toBe(true);
}

async function expectInsideContainer(container: Locator, child: Locator): Promise<void> {
  const [containerBounds, childBounds] = await Promise.all([
    container.boundingBox(),
    child.boundingBox(),
  ]);
  expect(containerBounds).not.toBeNull();
  expect(childBounds).not.toBeNull();
  if (containerBounds === null || childBounds === null) return;
  expect(childBounds.x).toBeGreaterThanOrEqual(containerBounds.x);
  expect(childBounds.y).toBeGreaterThanOrEqual(containerBounds.y);
  expect(childBounds.x + childBounds.width).toBeLessThanOrEqual(
    containerBounds.x + containerBounds.width,
  );
  expect(childBounds.y + childBounds.height).toBeLessThanOrEqual(
    containerBounds.y + containerBounds.height,
  );
}

async function expectMinimumTarget(locator: Locator, minimum: number): Promise<void> {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width).toBeGreaterThanOrEqual(minimum);
  expect(bounds?.height).toBeGreaterThanOrEqual(minimum);
}

async function exposedBackgroundControls(page: Page, dialog: Locator): Promise<readonly string[]> {
  const dialogHandle = await dialog.elementHandle();
  expect(dialogHandle).not.toBeNull();
  if (dialogHandle === null) return ["dialog missing"];
  return await page.evaluate((activeDialog) => {
    const selectors = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    return [...document.querySelectorAll<HTMLElement>(selectors)]
      .filter((element) => !activeDialog.contains(element))
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none"
          && style.visibility !== "hidden"
          && bounds.width > 0
          && bounds.height > 0
        );
      })
      .filter((element) => element.closest("[inert], [aria-hidden='true']") === null)
      .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName);
  }, dialogHandle);
}

function isTouchLane(projectName: string): boolean {
  return projectName === "chromium-mobile" || projectName === "chromium-tablet";
}

function messageInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

async function stageFixtureFile(page: Page, name: string): Promise<void> {
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  await (await fileChooser).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("deterministic E2E fixture"),
  });
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

async function stageQuote(page: Page): Promise<void> {
  const source = page.locator(".message-assistant .markdown").last();
  await selectText(source, 0, 4);
  const quote = page.getByRole("button", { name: "Quote" });
  await expect(quote).toBeVisible();
  await quote.click();
  await expect(page.getByRole("button", { name: "Remove quote" })).toBeVisible();
}

async function selectText(locator: Locator, start: number, end: number): Promise<void> {
  await locator.evaluate((element, offsets) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (textNode === null) throw new Error("The fixture quote source has no text node.");
    const range = document.createRange();
    range.setStart(textNode, offsets.start);
    range.setEnd(textNode, Math.min(offsets.end, textNode.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
  await locator.page().evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}
