import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
  type UserFacingSocketConfig,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { WhatsAppSocketLike } from "./types.js";

export interface BaileysWhatsAppSocketOptions {
  authDir: string;
  browserName?: string;
  markOnlineOnConnect?: boolean;
  syncFullHistory?: boolean;
  socketConfig?: Omit<Partial<UserFacingSocketConfig>, "auth">;
}

export interface BaileysWhatsAppSocket {
  socket: WhatsAppSocketLike;
  baileysSocket: WASocket;
  saveCreds: () => Promise<void>;
}

export async function createBaileysWhatsAppSocket(
  options: BaileysWhatsAppSocketOptions,
): Promise<BaileysWhatsAppSocket> {
  if (typeof options.authDir !== "string" || options.authDir.trim().length === 0) {
    throw new TypeError("createBaileysWhatsAppSocket requires a non-empty authDir.");
  }

  const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
  const socketConfig: UserFacingSocketConfig = {
    ...options.socketConfig,
    auth: state,
    browser:
      options.socketConfig?.browser ??
      Browsers.appropriate(options.browserName ?? "Agent"),
    markOnlineOnConnect:
      options.socketConfig?.markOnlineOnConnect ?? options.markOnlineOnConnect ?? false,
    syncFullHistory:
      options.socketConfig?.syncFullHistory ?? options.syncFullHistory ?? false,
  };
  const baileysSocket = makeWASocket(socketConfig);

  return {
    socket: baileysSocket as unknown as WhatsAppSocketLike,
    baileysSocket,
    saveCreds,
  };
}
