export type WhatsAppJid = string;

export type WhatsAppChatKind = "direct" | "group";

export interface WhatsAppMessageKeyLike {
  id?: string | null;
  remoteJid?: string | null;
  participant?: string | null;
  fromMe?: boolean | null;
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
}

export interface WhatsAppContextInfoLike {
  mentionedJid?: string[] | null;
  participant?: string | null;
  remoteJid?: string | null;
  stanzaId?: string | null;
}

export interface WhatsAppMessageContentLike {
  conversation?: string | null;
  extendedTextMessage?: {
    text?: string | null;
    contextInfo?: WhatsAppContextInfoLike | null;
  } | null;
  [key: string]: unknown;
}

export interface WhatsAppRawMessage {
  key?: WhatsAppMessageKeyLike | null;
  message?: WhatsAppMessageContentLike | null;
  messageTimestamp?: number | string | LongLike | null;
  pushName?: string | null;
  participant?: string | null;
  [key: string]: unknown;
}

export interface LongLike {
  toNumber?: () => number;
  toString?: () => string;
}

export interface WhatsAppTextMessage {
  remoteJid: WhatsAppJid;
  chatJid: WhatsAppJid;
  chatKind: WhatsAppChatKind;
  senderJid?: WhatsAppJid;
  participantJid?: WhatsAppJid;
  messageId?: string;
  timestamp?: number;
  pushName?: string;
  text: string;
  mentionedJids: WhatsAppJid[];
  raw: WhatsAppRawMessage;
}

export interface WhatsAppSentMessage {
  key?: WhatsAppMessageKeyLike | null;
  message?: WhatsAppMessageContentLike | null;
  [key: string]: unknown;
}

export interface WhatsAppSendMessageContent {
  text: string;
  mentions?: WhatsAppJid[];
}

export interface WhatsAppSendMessageOptions {
  quoted?: WhatsAppRawMessage;
}

export interface WhatsAppSocketLike {
  sendMessage(
    jid: WhatsAppJid,
    content: WhatsAppSendMessageContent,
    options?: WhatsAppSendMessageOptions,
  ): Promise<WhatsAppSentMessage | undefined>;
  ev?: WhatsAppEventEmitterLike;
}

export interface WhatsAppEventEmitterLike {
  on(event: string, listener: (payload: unknown) => void): void;
  off?(event: string, listener: (payload: unknown) => void): void;
  removeListener?(event: string, listener: (payload: unknown) => void): void;
}
