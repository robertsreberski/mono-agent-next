export interface SlackDestination {
  readonly channelId: string;
  readonly threadId?: string;
}

export function parseSlackIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || /[\s:\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be one bounded Slack identifier.`);
  }
  return value;
}

export function parseSlackDestination(
  value: unknown,
  label: string,
): SlackDestination {
  if (typeof value !== "string" || value.length > 257) {
    throw new TypeError(`${label} must be one channel or channel:thread destination.`);
  }
  const segments = value.split(":");
  if (segments.length < 1 || segments.length > 2) {
    throw new TypeError(`${label} must be one channel or channel:thread destination.`);
  }
  const channelId = parseSlackIdentifier(segments[0], `${label} channel`);
  const threadId = segments[1] === undefined
    ? undefined
    : parseSlackIdentifier(segments[1], `${label} thread`);
  return Object.freeze({
    channelId,
    ...(threadId === undefined ? {} : { threadId }),
  });
}

export function resolveSlackDestination(
  conversationId: string,
  fallback: string | undefined,
): SlackDestination | undefined {
  const value = conversationId.startsWith("slack:")
    ? conversationId.slice("slack:".length)
    : conversationId.length === 0
      ? fallback
      : undefined;
  if (value === undefined) return undefined;
  try {
    return parseSlackDestination(value, "Slack destination");
  } catch {
    return undefined;
  }
}

export function slackConversationId(destination: SlackDestination): string {
  return `slack:${destination.channelId}${destination.threadId === undefined
    ? ""
    : `:${destination.threadId}`}`;
}
