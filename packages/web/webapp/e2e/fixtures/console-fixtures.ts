import { expect, type Page, type Route } from "@playwright/test";

import type {
  Agent,
  Bootstrap,
  Message,
  ModelOption,
  StartTurnInput,
  Thread,
  ThreadDetail,
} from "../../src/types";

export type VisualScenario = "interactive" | "running" | "settled";

export interface FixtureOptions {
  readonly askFailure?: string;
  readonly denseTranscript?: boolean;
  readonly effortMetadata?: "complete" | "missing";
  readonly priorCompletedTelemetry?: boolean;
  readonly threadResponseDelays?: Readonly<Record<string, number>>;
  readonly turnFailure?: string;
  readonly turnResponseDelayMs?: number;
}

export interface FixtureTurnRequest {
  readonly threadId: string;
  readonly input: StartTurnInput;
}

export interface FixtureHarness {
  readonly turnRequests: readonly FixtureTurnRequest[];
}

export const scenarioThreadIds = {
  interactive: "thread-interactive",
  running: "thread-running",
  settled: "thread-settled",
} as const satisfies Readonly<Record<VisualScenario, string>>;

export const scenarioTitles = {
  interactive: "Approve launch notes",
  running: "Preparing migration summary",
  settled: "Beta architecture review",
} as const satisfies Readonly<Record<VisualScenario, string>>;

const token = "visual-fixture-token-000000000000";
const now = "2026-07-24T10:00:00.000Z";
const nowMs = Date.parse(now);

const configuredRoutes = [
  {
    runtime: "pi",
    id: "shared-model",
    label: "Pi shared route",
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 272_000,
  },
  {
    runtime: "codex-app-server",
    id: "shared-model",
    label: "Codex shared route",
    efforts: ["low", "medium", "high"],
    contextWindow: 196_000,
  },
] as const satisfies readonly (ModelOption & { readonly runtime: string })[];

const personalAgent = {
  id: "personal",
  label: "Personal Agent",
  endpoint: "http://127.0.0.1:4410",
  online: true,
  pinned: true,
  capabilities: {
    askUser: true,
    attachments: true,
    cancellation: true,
    configView: true,
    health: true,
    liveInput: true,
    proactive: true,
    quotes: true,
    replay: true,
    runtimeOverrides: true,
  },
  defaults: {
    runtime: "pi",
    model: "shared-model",
    effort: "high",
  },
  models: configuredRoutes,
} as const satisfies Agent;

const agents = [
  personalAgent,
  {
    ...personalAgent,
    id: "research",
    label: "Research",
    endpoint: "http://127.0.0.1:4420",
    online: false,
    pinned: true,
  },
  {
    ...personalAgent,
    id: "archive",
    label: "Archive",
    endpoint: "http://127.0.0.1:4430",
    online: false,
    pinned: false,
  },
] as const satisfies readonly Agent[];

const threads = [
  thread({
    id: scenarioThreadIds.interactive,
    title: scenarioTitles.interactive,
    status: "complete",
    lastTurnId: "turn-interactive",
    pendingAsk: {
      interactionId: "ask-launch-format",
      requestedAt: "2026-07-24T09:58:00.000Z",
      questions: [
        {
          id: "format",
          prompt: "How should I deliver the beta launch notes?",
          allowFreeText: true,
          multiple: false,
          choices: [
            {
              value: "brief",
              label: "Brief summary",
              description: "Lead with outcomes and link the retained evidence.",
            },
            {
              value: "full",
              label: "Full report",
              description: "Include implementation and verification details.",
            },
          ],
        },
      ],
    },
  }),
  thread({
    id: scenarioThreadIds.running,
    title: scenarioTitles.running,
    status: "running",
    activeTurnId: "turn-running",
    lastTurnId: "turn-running",
    updatedAt: "2026-07-24T09:59:55.000Z",
  }),
  thread({
    id: scenarioThreadIds.settled,
    title: scenarioTitles.settled,
    status: "complete",
    lastTurnId: "turn-settled",
    updatedAt: "2026-07-24T09:56:00.000Z",
  }),
  thread({
    id: "thread-scheduled",
    title: "Morning operations digest",
    status: "complete",
    proactive: true,
    trigger: { kind: "cron" },
    lastTurnId: "turn-scheduled",
    updatedAt: "2026-07-24T08:30:00.000Z",
  }),
] as const satisfies readonly Thread[];

const details = {
  interactive: {
    thread: threads[0],
    messages: [
      message({
        id: "interactive-request",
        turnId: "turn-interactive",
        role: "user",
        text: "Prepare the launch notes from our approved beta checklist.",
        attachments: [
          {
            id: "attachment-plan",
            name: "beta-acceptance-plan.pdf",
            mediaType: "application/pdf",
            sizeBytes: 28_194,
          },
        ],
      }),
      message({
        id: "interactive-source",
        operatorMessageId: "operator-interactive-source",
        turnId: "turn-interactive",
        role: "assistant",
        text: "The approved beta checklist is ready for review.",
        quote: {
          conversationId: "web:thread-interactive",
          messageId: "operator-prior-message",
          text: "Keep the release phase separate from the beta proof.",
        },
        telemetry: {
          inputTokens: 4_218,
          outputTokens: 236,
          contextWindow: 200_000,
          contextUsed: 4_454,
          compacted: false,
          sessionEvicted: false,
        },
      }),
    ],
  },
  running: {
    thread: threads[1],
    messages: [
      message({
        id: "running-request",
        turnId: "turn-running",
        role: "user",
        text: "Compare the migration evidence and prepare a concise summary.",
      }),
      message({
        id: "running-response",
        turnId: "turn-running",
        role: "assistant",
        status: "running",
        text: "I’m checking the retained verification evidence now.",
        activities: [
          { type: "activity", text: "Reading the beta verification report" },
          {
            type: "tool_call",
            call: {
              id: "call-read-report",
              name: "Read",
              input: { path: "docs/reference/source-beta-complexity.md" },
              inputOmitted: false,
            },
          },
          { type: "activity", text: "Comparing package boundaries" },
        ],
      }),
    ],
  },
  settled: {
    thread: threads[2],
    messages: [
      message({
        id: "settled-request",
        turnId: "turn-settled",
        role: "user",
        text: "Did the rebuilt architecture pass its beta gate?",
      }),
      message({
        id: "settled-response",
        operatorMessageId: "operator-settled-response",
        turnId: "turn-settled",
        role: "assistant",
        text:
          "Yes. The rebuilt framework passed the focused package checks and the complete beta verification gate.\n\n" +
          "- 23 publishable packages\n- zero first-party dependency cycles\n- retained migration evidence",
        activities: [
          { type: "activity", text: "Loaded architecture evidence" },
          {
            type: "tool_call",
            call: {
              id: "call-architecture",
              name: "CheckArchitecture",
              input: { lane: "beta" },
              inputOmitted: false,
            },
          },
          {
            type: "tool_result",
            result: {
              callId: "call-architecture",
              content: [
                {
                  type: "json",
                  value: { packages: 23, cycles: 0, status: "passed" },
                },
              ],
              contentOmitted: false,
              isError: false,
            },
          },
          {
            type: "compaction",
            compaction: {
              compacted: true,
              tokensBefore: 18_420,
              tokensAfter: 7_180,
              summaryTokens: 812,
            },
          },
        ],
        telemetry: {
          inputTokens: 7_944,
          outputTokens: 511,
          contextWindow: 272_000,
          contextUsed: 61_337,
          compacted: true,
          sessionEvicted: false,
        },
      }),
    ],
  },
} as const satisfies Readonly<Record<VisualScenario, ThreadDetail>>;

export async function openFixtureConsole(
  page: Page,
  scenario: VisualScenario,
  options: FixtureOptions = {},
): Promise<FixtureHarness> {
  const turnRequests: FixtureTurnRequest[] = [];
  await installDeterministicBrowserState(page);
  await page.unroute("**/api/v1/**");
  await page.route(
    "**/api/v1/**",
    (route) => respondToApi(route, scenario, options, turnRequests),
  );
  await page.goto(`/?thread=${scenarioThreadIds[scenario]}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: scenarioTitles[scenario] })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return { turnRequests };
}

async function installDeterministicBrowserState(page: Page): Promise<void> {
  await page.addInitScript(({ fixtureToken, fixtureNow }) => {
    window.sessionStorage.setItem("mono-agent-web-token", fixtureToken);
    window.localStorage.setItem("mono-agent-web-show-offline", "false");
    window.localStorage.setItem("mono-agent-web-show-archived", "false");
    window.localStorage.setItem("mono-agent-web-agent-rail", "collapsed");
    Date.now = () => fixtureNow;
  }, { fixtureToken: token, fixtureNow: nowMs });
}

async function respondToApi(
  route: Route,
  scenario: VisualScenario,
  options: FixtureOptions,
  turnRequests: FixtureTurnRequest[],
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.headers().authorization !== `Bearer ${token}`) {
    await json(route, 401, { error: { code: "unauthorized", message: "Fixture token required." } });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/bootstrap") {
    const bootstrap = {
      version: 1,
      revision: 42,
      agents: fixtureAgents(options),
      threads,
      newProactiveThreadIds: [],
    } satisfies Bootstrap;
    await json(route, 200, bootstrap);
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/v1/events") {
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      },
      body:
        `id: 42\n` +
        `data: ${JSON.stringify({
          id: "fixture-ready",
          version: 1,
          revision: 42,
          type: "ready",
          at: now,
        })}\n\n`,
    });
    return;
  }
  const threadMatch = /^\/api\/v1\/threads\/([^/]+)$/u.exec(url.pathname);
  if (request.method() === "GET" && threadMatch !== null) {
    const requestedId = decodeURIComponent(threadMatch[1] ?? "");
    const detail = fixtureDetail(requestedId, options);
    if (detail === undefined) {
      await json(route, 404, { error: { code: "not_found", message: "Unknown fixture thread." } });
      return;
    }
    await delay(options.threadResponseDelays?.[requestedId] ?? 0);
    await json(route, 200, detail);
    return;
  }
  const turnMatch = /^\/api\/v1\/threads\/([^/]+)\/turns$/u.exec(url.pathname);
  if (request.method() === "POST" && turnMatch !== null) {
    const threadId = decodeURIComponent(turnMatch[1] ?? "");
    const detail = fixtureDetail(threadId, options);
    if (detail === undefined) {
      await json(route, 404, { error: { code: "not_found", message: "Unknown fixture thread." } });
      return;
    }
    const input = request.postDataJSON() as StartTurnInput;
    turnRequests.push({ threadId, input });
    await delay(options.turnResponseDelayMs ?? 0);
    if (options.turnFailure !== undefined) {
      await json(route, 502, {
        error: {
          code: "fixture_turn_failure",
          message: options.turnFailure,
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
      body: `${JSON.stringify({ type: "done", detail })}\n`,
    });
    return;
  }
  const askMatch = /^\/api\/v1\/threads\/([^/]+)\/ask$/u.exec(url.pathname);
  if (request.method() === "POST" && askMatch !== null && options.askFailure !== undefined) {
    await json(route, 502, {
      error: {
        code: "fixture_ask_failure",
        message: options.askFailure,
      },
    });
    return;
  }
  await json(route, 500, {
    error: {
      code: "unexpected_fixture_request",
      message: `${request.method()} ${url.pathname} is not part of the visual fixture.`,
    },
    scenario,
  });
}

function fixtureAgents(options: FixtureOptions): readonly Agent[] {
  if (options.effortMetadata !== "missing") return agents;
  return agents.map((agent) => ({
    ...agent,
    models: agent.models?.map((route) => {
      const { efforts: _efforts, ...withoutEfforts } = route;
      return withoutEfforts;
    }),
  }));
}

function fixtureDetail(
  threadId: string,
  options: FixtureOptions,
): ThreadDetail | undefined {
  const detail = Object.values(details).find((candidate) => candidate.thread.id === threadId);
  if (detail === undefined) return undefined;
  let result: ThreadDetail = detail;
  if (options.denseTranscript === true && threadId === scenarioThreadIds.settled) {
    result = {
      ...result,
      messages: result.messages.map((candidate) => candidate.id === "settled-response"
        ? {
            ...candidate,
            text: `${candidate.text}\n\n${Array.from(
              { length: 36 },
              (_value, index) => `Verification detail ${index + 1}: retained evidence remains reviewable.`,
            ).join("\n\n")}`,
          }
        : candidate),
    };
  }
  if (
    options.priorCompletedTelemetry === true
    && threadId === scenarioThreadIds.running
  ) {
    result = {
      ...result,
      messages: [
        message({
          id: "running-prior-response",
          operatorMessageId: "operator-running-prior-response",
          turnId: "turn-before-running",
          role: "assistant",
          text: "The previous response completed with trustworthy context telemetry.",
          telemetry: {
            inputTokens: 31_200,
            outputTokens: 901,
            contextWindow: 272_000,
            contextUsed: 75_444,
            compacted: false,
            sessionEvicted: false,
          },
        }),
        ...result.messages,
      ],
    };
  }
  return result;
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
}

function thread(input: Omit<Thread, "agentId" | "createdAt" | "titleManual" | "updatedAt"> & {
  readonly updatedAt?: string;
}): Thread {
  return {
    agentId: "personal",
    titleManual: true,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-24T09:58:00.000Z",
    ...input,
  };
}

function message(input: Omit<Message, "createdAt" | "status" | "threadId" | "updatedAt"> & {
  readonly status?: Message["status"];
}): Message {
  return {
    threadId: input.id.startsWith("settled")
      ? scenarioThreadIds.settled
      : input.id.startsWith("running")
        ? scenarioThreadIds.running
        : scenarioThreadIds.interactive,
    createdAt: "2026-07-24T09:58:30.000Z",
    updatedAt: "2026-07-24T09:59:00.000Z",
    status: "complete",
    ...input,
  };
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
