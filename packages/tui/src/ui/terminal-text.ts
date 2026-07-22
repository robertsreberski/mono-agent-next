const BIDI_CONTROL = /\p{Bidi_Control}/u;

export interface EscapeTerminalControlsOptions {
  /** Preserve LF when it is the renderer's intentional multi-line separator. */
  readonly allowLineFeed?: boolean;
}

/**
 * Render untrusted persisted text without letting terminal controls execute or
 * visually reorder the surrounding UI. Controls remain inspectable as
 * lowercase `\\uXXXX` escapes; intentional raw-view LF separators may be kept.
 */
export function escapeTerminalControls(
  value: string,
  options: EscapeTerminalControlsOptions = {},
): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (options.allowLineFeed === true && codePoint === 0x0a) {
      escaped += character;
    } else if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || BIDI_CONTROL.test(character)
    ) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}
