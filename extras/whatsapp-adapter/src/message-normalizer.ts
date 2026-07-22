import type {
  WhatsAppChatKind,
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppTextMessage,
} from "./types.js";

export type WhatsAppMessageIgnoredReason =
  | "from_self"
  | "missing_remote_jid"
  | "status_broadcast_ignored"
  | "broadcast_ignored"
  | "unsupported_message"
  | "empty_text";

export type WhatsAppMessageNormalizationResult =
  | { kind: "message"; message: WhatsAppTextMessage }
  | {
      kind: "ignored";
      reason: WhatsAppMessageIgnoredReason;
      chatJid?: WhatsAppJid;
      messageId?: string;
    };

export function normalizeWhatsAppMessage(
  raw: WhatsAppRawMessage,
): WhatsAppMessageNormalizationResult {
  const key = raw.key ?? undefined;
  const remoteJid = cleanJid(key?.remoteJid ?? undefined);
  const messageId = cleanString(key?.id ?? undefined);

  if (key?.fromMe === true) {
    return ignored("from_self", remoteJid, messageId);
  }
  if (remoteJid === undefined) {
    return ignored("missing_remote_jid", undefined, messageId);
  }
  if (isStatusJid(remoteJid)) {
    return ignored("status_broadcast_ignored", remoteJid, messageId);
  }
  if (isBroadcastJid(remoteJid)) {
    return ignored("broadcast_ignored", remoteJid, messageId);
  }

  const textResult = extractText(raw);
  if (textResult.kind === "unsupported") {
    return ignored("unsupported_message", remoteJid, messageId);
  }

  const text = textResult.text.trim();
  if (text.length === 0) {
    return ignored("empty_text", remoteJid, messageId);
  }

  const chatKind: WhatsAppChatKind = isGroupJid(remoteJid) ? "group" : "direct";
  const participantJid =
    chatKind === "group"
      ? cleanJid(key?.participant ?? raw.participant ?? undefined)
      : undefined;
  const senderJid = chatKind === "group" ? participantJid : remoteJid;
  const message: WhatsAppTextMessage = {
    remoteJid,
    chatJid: remoteJid,
    chatKind,
    text,
    mentionedJids: textResult.mentionedJids,
    raw,
  };

  if (senderJid !== undefined) {
    message.senderJid = senderJid;
  }
  if (participantJid !== undefined) {
    message.participantJid = participantJid;
  }
  if (messageId !== undefined) {
    message.messageId = messageId;
  }
  const timestamp = normalizeTimestamp(raw.messageTimestamp);
  if (timestamp !== undefined) {
    message.timestamp = timestamp;
  }
  const pushName = cleanString(raw.pushName ?? undefined);
  if (pushName !== undefined) {
    message.pushName = pushName;
  }

  return { kind: "message", message };
}

export function isGroupJid(jid: WhatsAppJid): boolean {
  return jid.endsWith("@g.us");
}

function ignored(
  reason: WhatsAppMessageIgnoredReason,
  chatJid: WhatsAppJid | undefined,
  messageId: string | undefined,
): WhatsAppMessageNormalizationResult {
  const result: Extract<WhatsAppMessageNormalizationResult, { kind: "ignored" }> = {
    kind: "ignored",
    reason,
  };
  if (chatJid !== undefined) {
    result.chatJid = chatJid;
  }
  if (messageId !== undefined) {
    result.messageId = messageId;
  }
  return result;
}

function extractText(raw: WhatsAppRawMessage):
  | { kind: "text"; text: string; mentionedJids: WhatsAppJid[] }
  | { kind: "unsupported" } {
  const content = raw.message ?? undefined;
  if (content === undefined || content === null) {
    return { kind: "unsupported" };
  }

  if (typeof content.conversation === "string") {
    return { kind: "text", text: content.conversation, mentionedJids: [] };
  }

  const extendedText = content.extendedTextMessage ?? undefined;
  if (extendedText !== undefined && extendedText !== null) {
    const mentionedJids = normalizeMentionedJids(
      extendedText.contextInfo?.mentionedJid ?? undefined,
    );
    if (typeof extendedText.text === "string") {
      return { kind: "text", text: extendedText.text, mentionedJids };
    }
  }

  return { kind: "unsupported" };
}

function normalizeMentionedJids(mentionedJids: string[] | null | undefined): WhatsAppJid[] {
  if (!Array.isArray(mentionedJids)) {
    return [];
  }

  const normalized: WhatsAppJid[] = [];
  const seen = new Set<string>();
  for (const jid of mentionedJids) {
    const clean = cleanJid(jid);
    if (clean !== undefined && !seen.has(clean)) {
      normalized.push(clean);
      seen.add(clean);
    }
  }
  return normalized;
}

function cleanJid(jid: string | null | undefined): WhatsAppJid | undefined {
  if (typeof jid !== "string") {
    return undefined;
  }
  const trimmed = jid.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isStatusJid(jid: WhatsAppJid): boolean {
  return jid === "status@broadcast";
}

function isBroadcastJid(jid: WhatsAppJid): boolean {
  return jid.endsWith("@broadcast") && !isStatusJid(jid);
}

function normalizeTimestamp(
  value: WhatsAppRawMessage["messageTimestamp"],
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "object" && value !== null) {
    if (typeof value.toNumber === "function") {
      const parsed = value.toNumber();
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value.toString === "function") {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}
