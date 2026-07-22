import type {
  AgentSummary,
  Bootstrap,
  ThreadSummary,
  UploadLimits,
  WebAttachment,
} from "../types";

export const uploadLimits: UploadLimits = {
  maxFileBytes: 20,
  maxFilesPerTurn: 10,
  maxTurnBytes: 100,
  accept: ["image/png", "text/markdown", "text/csv", "application/pdf"],
};

export const attachment = (
  id: string,
  overrides: Partial<WebAttachment> = {},
): WebAttachment => ({
  id,
  name: `${id}.txt`,
  contentType: "text/plain",
  sizeBytes: 4,
  kind: "document",
  status: "staged",
  uploaded: false,
  createdAt: "2026-07-17T10:00:00.000Z",
  ...overrides,
});

export const agent = (
  sourceId: string,
  overrides: Partial<AgentSummary> = {},
): AgentSummary => ({
  sourceId,
  label: sourceId.toUpperCase(),
  status: "online",
  pinned: false,
  supportsAttachments: true,
  models: ["provider/model"],
  defaultModel: "provider/model",
  updatedAt: "2026-07-17T10:00:00.000Z",
  ...overrides,
});

export const thread = (
  id: string,
  sourceId: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  id,
  sourceId,
  title: id,
  archivedAt: null,
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  revision: 1,
  messageCount: 0,
  runState: { status: "idle" },
  canSend: true,
  canUpload: true,
  ...overrides,
});

export const bootstrap = (
  agents: Bootstrap["agents"],
  threads: Bootstrap["threads"],
  currentThreadId?: string,
): Bootstrap => ({
  version: 1,
  agents,
  threads,
  currentThreadId,
  limits: uploadLimits,
});
