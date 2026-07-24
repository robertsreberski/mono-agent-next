import { expect, test, type Page } from "@playwright/test";

import {
  openFixtureConsole,
  openFixtureLogin,
} from "./fixtures/console-fixtures";

test.describe("assistant-ui console visual contract", () => {
  test("settled conversation keeps Activity collapsed", async ({ page }) => {
    await openFixtureConsole(page, "settled");
    await setActivityExpanded(page, false);

    await expect(page.getByText("23 publishable packages")).toBeVisible();
    await expect(page).toHaveScreenshot("settled-activity-collapsed.png");
  });

  test("running conversation keeps Activity open", async ({ page }) => {
    await openFixtureConsole(page, "running");
    await setActivityExpanded(page, true);

    await expect(page.getByText("Reading the beta verification report")).toBeVisible();
    await expect(page.getByText("Read", { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot("running-activity-open.png");
  });

  test("AskUser, quote, and attachment render cleanly", async ({ page }) => {
    await openFixtureConsole(page, "interactive");

    await expect(page.getByText("How should I deliver the beta launch notes?")).toBeVisible();
    await expect(page.getByText("beta-acceptance-plan.pdf")).toBeVisible();
    await expect(page.getByText("The approved beta checklist is ready for review.")).toBeVisible();
    await expect(page.getByText("Keep the release phase separate from the beta proof.")).toBeVisible();
    await expect(page).toHaveScreenshot("ask-quote-attachment.png");
  });

  test("quote and attachment chips remain visible with a staged file", async ({ page }) => {
    await openFixtureConsole(page, "interactive", { pendingAsk: false });
    await stageAttachment(page);

    await expect(page.getByText("beta-acceptance-plan.pdf")).toBeVisible();
    await expect(page.getByText("fixture-report.pdf")).toBeVisible();
    await expect(page.getByText("Keep the release phase separate from the beta proof.")).toBeVisible();
    await expect(page).toHaveScreenshot("quote-attachment-compose.png");
  });

  test("empty conversation keeps the full navigation chrome", async ({ page }) => {
    await openFixtureConsole(page, "empty");

    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page).toHaveScreenshot("empty-conversation.png");
  });

  test("archived conversation keeps its transcript and restore action", async ({ page }) => {
    await openFixtureConsole(page, "archived");

    await expect(page.getByText("This conversation is archived.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore to continue" })).toBeVisible();
    await expect(page).toHaveScreenshot("archived-conversation.png");
  });

  test("token login is polished in every responsive lane", async ({ page }) => {
    await openFixtureLogin(page);

    await expect(page.getByRole("heading", { name: "Connect to your agents" })).toBeVisible();
    await expect(page).toHaveScreenshot("login.png");
  });

  test("context and run settings stay compact and mutually exclusive", async ({ page }, testInfo) => {
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Context usage" }).click();
    await expect(page.getByText("61,337", { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot("context-open.png");
    if (testInfo.project.name === "chromium-mobile") return;

    await openRunSettings(page);
    await expect(page.getByRole("dialog", { name: "Context usage" })).toBeHidden();
    await expect(page).toHaveScreenshot("run-settings-open.png");
  });

  test("searchable model picker filters the advertised route catalog", async ({ page }) => {
    await openFixtureConsole(page, "settled");

    await openRunSettings(page);
    const search = page.getByRole("combobox", { name: "Search models" });
    await search.fill("Codex");
    await expect(page.getByText("Codex shared route", { exact: true })).toBeVisible();
    await expect(page.getByText("Pi shared route", { exact: true })).toBeHidden();
    await expect(page).toHaveScreenshot("model-picker-search.png");
  });

  test("global command palette exposes its keyboard-selected command", async ({ page }) => {
    await openFixtureConsole(page, "settled");

    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "Command palette" });
    await expect(search).toBeFocused();
    await search.fill("conversation");
    await expect(page.locator("[cmdk-item][data-selected='true']")).toBeVisible();
    await expect(page).toHaveScreenshot("command-palette.png");
  });

  test("mobile agent drawer", async ({ page }, testInfo) => {
    test.skip(!isTouchNavigationLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Choose agent" }).click();
    await expect(page.getByRole("dialog", { name: "Choose agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close agent navigation" })).toBeVisible();
    await expect(page).toHaveScreenshot("mobile-agent-drawer-open.png");
  });

  test("mobile conversation drawer", async ({ page }, testInfo) => {
    test.skip(!isTouchNavigationLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Open conversations" }).click();
    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close conversations" })).toBeVisible();
    await expect(page).toHaveScreenshot("mobile-conversation-drawer-open.png");
  });

  test("mobile run settings", async ({ page }, testInfo) => {
    test.skip(!isTouchNavigationLane(testInfo.project.name));
    await openFixtureConsole(page, "settled");

    await openRunSettings(page);
    await expect(page).toHaveScreenshot("mobile-run-settings-open.png");
  });
});

async function setActivityExpanded(page: Page, expanded: boolean): Promise<void> {
  const disclosure = page.getByRole("button", { name: /^Activity/u }).last();
  await expect(
    disclosure,
    "Activity must be a user-controlled disclosure for the visual contract.",
  ).toBeVisible();
  const current = await disclosure.getAttribute("aria-expanded");
  if ((current === "true") !== expanded) await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", String(expanded));
}

async function stageAttachment(page: Page): Promise<void> {
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  await (await fileChooser).setFiles({
    name: "fixture-report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("deterministic visual fixture"),
  });
}

async function openRunSettings(page: Page): Promise<void> {
  const runSettings = page.getByRole("button", { name: "Run settings" });
  await expect(
    runSettings,
    "The console must expose an accessible run-settings trigger.",
  ).toBeVisible();
  await runSettings.first().click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Reasoning effort" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeFocused();
}

function isTouchNavigationLane(projectName: string): boolean {
  return projectName === "chromium-mobile" || projectName === "chromium-tablet";
}
