import { expect, test, type Page } from "@playwright/test";

import { openFixtureConsole } from "./fixtures/console-fixtures";

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

  test("AskUser, quote, and attachment compose cleanly", async ({ page }) => {
    await openFixtureConsole(page, "interactive");
    await stageAttachment(page);

    await expect(page.getByText("How should I deliver the beta launch notes?")).toBeVisible();
    await expect(page.getByText("fixture-report.pdf")).toBeVisible();
    await expect(page.getByText("The approved beta checklist is ready for review.")).toBeVisible();
    await expect(page.getByText("Keep the release phase separate from the beta proof.")).toBeVisible();
    await expect(page).toHaveScreenshot("ask-quote-attachment.png");
  });

  test("context and run settings stay compact", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop");
    await openFixtureConsole(page, "settled");

    await page.locator('summary[aria-label="Context usage"]').click();
    await openRunSettings(page);
    await expect(page.getByText("8,455", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
    await expect(page).toHaveScreenshot("context-and-run-settings-open.png");
  });

  test("mobile agent drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile");
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Choose agent" }).click();
    await expect(page.getByRole("dialog", { name: "Choose agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close agent navigation" })).toBeVisible();
    await expect(page).toHaveScreenshot("mobile-agent-drawer-open.png");
  });

  test("mobile conversation drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile");
    await openFixtureConsole(page, "settled");

    await page.getByRole("button", { name: "Open conversations" }).click();
    await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close conversations" })).toBeVisible();
    await expect(page).toHaveScreenshot("mobile-conversation-drawer-open.png");
  });

  test("mobile run settings", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile");
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
  const fileInput = page.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles({
    name: "fixture-report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("deterministic visual fixture"),
  });
}

async function openRunSettings(page: Page): Promise<void> {
  const runSettings = page.locator(
    'summary[aria-label="Run settings"], button[aria-label="Run settings"]',
  );
  await expect(
    runSettings,
    "The console must expose an accessible run-settings trigger.",
  ).toBeVisible();
  await runSettings.first().click();
  await expect(page.getByLabel(/model/i).first()).toBeVisible();
  await expect(page.getByLabel(/reasoning effort/i).first()).toBeVisible();
}
