import type {
  AgentSummary,
  AskAnswer,
  AskSnapshot,
  AskSubmissionResult,
  Bootstrap,
  LiveInputReceipt,
  StartTurnInput,
  ThreadDetail,
  ThreadSummary,
  WebAttachment,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const readError = async (response: Response): Promise<ApiError> => {
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;
  try {
    const payload = (await response.json()) as {
      error?: string | { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    if (typeof payload.error === "string") message = payload.error;
    if (payload.error && typeof payload.error === "object") {
      message = payload.error.message ?? message;
      code = payload.error.code;
    }
    message = payload.message ?? message;
    code = payload.code ?? code;
  } catch {
    // The status line is still useful when the response is not JSON.
  }
  return new ApiError(message, response.status, code);
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
};

export const api = {
  bootstrap: (signal?: AbortSignal) =>
    request<Bootstrap>("/api/v1/bootstrap", { signal }),

  thread: (threadId: string, signal?: AbortSignal) =>
    request<ThreadDetail>(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      signal,
    }),

  createThread: async (sourceId: string) => {
    const result = await request<{ thread: ThreadSummary }>("/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ sourceId }),
    });
    return result.thread;
  },

  patchAgent: async (sourceId: string, pinned: boolean) => {
    const result = await request<{ agent: AgentSummary }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify({ pinned }) },
    );
    return result.agent;
  },

  patchThread: async (
    threadId: string,
    patch: { title?: string; archived?: boolean },
  ) => {
    const result = await request<{ thread: ThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    return result.thread;
  },

  deleteThread: async (threadId: string) => {
    const response = await fetch(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },

  startTurn: async (threadId: string, input: StartTurnInput) =>
    request<{ thread: ThreadSummary; turn: { id: string; status: string } }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  liveInput: async (threadId: string, text: string) =>
    request<LiveInputReceipt>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/live-input`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),

  cancelTurn: async (threadId: string) =>
    request<{ cancelled: true; thread: ThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/cancel`,
      { method: "POST" },
    ),

  pendingAsk: async (threadId: string, signal?: AbortSignal) => {
    const result = await request<{ ask: AskSnapshot | null }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/ask`,
      { signal },
    );
    return result.ask ?? undefined;
  },

  submitAsk: async (threadId: string, interactionId: string, answers: readonly AskAnswer[]) =>
    request<AskSubmissionResult>(`/api/v1/threads/${encodeURIComponent(threadId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ interactionId, answers }),
    }),

  createUpload: async (file: File) => {
    const result = await request<{ attachment: WebAttachment }>("/api/v1/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });
    return result.attachment;
  },

  deleteUpload: async (uploadId: string) => {
    const response = await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },
};

export const uploadContent = (
  upload: WebAttachment,
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<WebAttachment> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      reject(new DOMException("The upload was cancelled.", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.open("PUT", `/api/v1/uploads/${encodeURIComponent(upload.id)}/content`);
    xhr.responseType = "json";
    // The reservation already stores the declared MIME. The content endpoint
    // deliberately accepts only an opaque byte stream.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("The upload connection was interrupted."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    };
    xhr.onload = () => {
      cleanup();
      const payload = xhr.response as
        | { attachment?: WebAttachment; error?: string | { message?: string } }
        | null;
      if (xhr.status < 200 || xhr.status >= 300 || !payload?.attachment) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message ?? `Upload failed with status ${xhr.status}.`;
        reject(new ApiError(message, xhr.status));
        return;
      }
      onProgress(100);
      resolve(payload.attachment);
    };
    xhr.send(file);
  });
