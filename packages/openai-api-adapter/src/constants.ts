export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 0;
export const DEFAULT_BASE_PATH = "/v1";
export const DEFAULT_MODEL_ID = "agent";

/**
 * Hard upper bound for one fully serialized OpenWebUI tool-details SSE frame,
 * including HTML escaping, the Chat Completions JSON wrapper, and SSE framing.
 */
export const MAX_TOOL_SSE_FRAME_BYTES = 256 * 1024;

/**
 * Default per-field upper bound for raw UTF-8 preview bytes. The actual bound
 * may be lowered further when serialized expansion would exceed the frame cap.
 */
export const DEFAULT_MAX_TOOL_PAYLOAD_BYTES = MAX_TOOL_SSE_FRAME_BYTES / 2;
