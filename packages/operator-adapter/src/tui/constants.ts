export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 0;
export const DEFAULT_BASE_PATH = "/gui";

/**
 * Wire schema version surfaced by GET /v1/info so a version-skewed TUI can
 * detect an incompatible agent before starting a turn.
 */
export const TUI_WIRE_SCHEMA = 1;

/**
 * Strict UTF-8 byte maximum for one serialized event frame, including its NDJSON
 * newline. Oversized assistant-thought and tool-call payloads are field-reduced;
 * any other oversized event, or a reducible event whose minimal form does not
 * fit, becomes a bounded `oversized_event` marker. Other frame kinds are not
 * governed by this cap. JSONL replay has independent redaction/string caps and
 * a terminal-only event-file boundary, so it is not a full-payload recovery path.
 */
export const MAX_FRAME_BYTES = 256 * 1024;
