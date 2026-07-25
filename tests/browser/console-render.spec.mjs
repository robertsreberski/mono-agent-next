// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

import {
  BROWSER_FIXTURE_REPLY,
  BROWSER_FIXTURE_TOOL_NAME,
  BROWSER_FIXTURE_TOOL_RESULT_TEXT,
  BROWSER_FIXTURE_WEB_TOKEN,
} from "./fixture-server.mjs";

// Every assertion here reads the rendered DOM. None reads component source.
//
// That distinction is the entire reason this file exists. The guard that used
// to protect tool rendering asserted the source text of `chat.tsx` and pinned a
// component key assistant-ui never reads (#116). It passed while every tool
// call in the console rendered nothing, and it would have *failed* if someone
// fixed the bug -- an assertion inverted against the behaviour it was written
// to protect. A test that reads source can only ever prove what the source
// says. Proving what the user sees needs a browser.

/** Signs in through the real form, which is also the only coverage that path has. */
async function signIn(page) {
  await page.goto("/");
  const token = page.getByLabel("Web token");
  if (await token.isVisible()) {
    await token.fill(BROWSER_FIXTURE_WEB_TOKEN);
    await page.getByRole("button", { name: "Open console" }).click();
  }
  await expect(page.getByRole("button", { name: /online$/u })).toBeVisible();
}

/**
 * Opens a thread this test owns, then sends one message through the composer.
 *
 * The thread is created over the API rather than by clicking through the
 * conversations rail. That is deliberate and it is not a shortcut around a
 * flaky product: one fixture serves the whole lane from one web data
 * directory, so threads accumulate across tests, the console selects the most
 * recent one on load, and a UI-driven "new conversation" lands in whichever
 * thread the previous test left behind. Navigating straight to a thread id this
 * test just created makes each test's subject unambiguous. Everything actually
 * under assertion -- sign-in, the composer, and every rendered frame -- still
 * happens in the browser.
 *
 * Sending waits for `Send` to become enabled rather than pressing Enter: the
 * composer exists before it is bound to the routed thread, so an early keypress
 * goes nowhere and no user message is ever created. Enabled `Send` is the
 * product saying it is ready.
 */
async function sendFirstMessage(page, text) {
  await signIn(page);

  const threadId = await page.evaluate(async () => {
    const response = await fetch("/api/v1/threads", {
      method: "POST",
      headers: {
        authorization: `Bearer ${window.sessionStorage.getItem("mono-agent-web-token") ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "browser-render-smoke" }),
    });
    if (!response.ok) throw new Error(`thread creation failed: ${String(response.status)}`);
    return (await response.json()).id;
  });

  await page.goto(`/?thread=${threadId}`);
  await expect(page.locator(".message-user")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Message" }).fill(text);
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeEnabled();
  await send.click();
}

test("renders a tool call, its result, and the reply in a real browser", async ({ page }) => {
  await sendFirstMessage(page, "render the tool chain");

  const toolCall = page.locator("details.tool-call");
  await expect(toolCall).toHaveCount(1);
  await expect(toolCall.locator(".tool-name")).toHaveText(BROWSER_FIXTURE_TOOL_NAME);
  await expect(toolCall.locator(".tool-state")).toHaveText("complete");

  // The payload is the half that renders as nothing when the parts map is
  // wrong: the call is announced, and its input and output vanish.
  const payload = toolCall.locator(".tool-payload");
  await expect(payload).toContainText("README.md");
  await expect(payload).toContainText(BROWSER_FIXTURE_TOOL_RESULT_TEXT);

  await expect(page.locator(".message-assistant")).toContainText(BROWSER_FIXTURE_REPLY);
  await expect(page.locator(".message-error")).toHaveCount(0);
});

test("streams the user message and the assistant reply into the same thread", async ({ page }) => {
  await sendFirstMessage(page, "render the tool chain");

  await expect(page.locator(".message-user")).toContainText("render the tool chain");
  await expect(page.locator(".message-assistant")).toContainText(BROWSER_FIXTURE_REPLY);
  // Two text deltas, one message. A regression that renders each delta as its
  // own message still satisfies "the reply is on screen".
  await expect(page.locator(".message-assistant")).toHaveCount(1);
});

test("refuses to open the console without the token", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { window.sessionStorage.clear(); });
  await page.reload();

  await expect(page.getByLabel("Web token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open console" })).toBeDisabled();
  await expect(page.locator("details.tool-call")).toHaveCount(0);
});
