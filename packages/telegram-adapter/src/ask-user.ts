export type TelegramAskUserAction =
  | { readonly kind: "option"; readonly optionIndex: number }
  | { readonly kind: "other" }
  | { readonly kind: "done" };

export interface TelegramAskUserCallback {
  readonly interactionId: string;
  readonly questionIndex: number;
  readonly action: TelegramAskUserAction;
}

const PREFIX = "au1:";

export function telegramAskUserCallbackData(
  interactionId: string,
  questionIndex: number,
  action: TelegramAskUserAction,
): string {
  const suffix = action.kind === "option" ? `o:${String(action.optionIndex)}` : action.kind === "other" ? "c" : "d";
  const value = `${PREFIX}${interactionId}:${String(questionIndex)}:${suffix}`;
  if (Buffer.byteLength(value, "utf8") > 64) {
    throw new RangeError("Telegram AskUser callback_data exceeds 64 bytes.");
  }
  return value;
}

export function parseTelegramAskUserCallbackData(data: string): TelegramAskUserCallback | undefined {
  const match = /^au1:([^:]{1,48}):([0-4]):(c|d|o:([0-2]))$/u.exec(data);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  const interactionId = match[1];
  const questionIndex = Number(match[2]);
  if (match[3] === "c") return { interactionId, questionIndex, action: { kind: "other" } };
  if (match[3] === "d") return { interactionId, questionIndex, action: { kind: "done" } };
  const optionIndex = Number(match[4]);
  return { interactionId, questionIndex, action: { kind: "option", optionIndex } };
}
