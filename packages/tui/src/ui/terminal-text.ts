const BIDI_CONTROL = /\p{Bidi_Control}/u;

export interface SanitizeTerminalTextOptions {
  /** Preserve LF only for renderer surfaces that deliberately support multiple lines. */
  readonly multiline?: boolean;
}

/**
 * Make untrusted text inert before pi-tui sees it.
 *
 * C0/C1 and bidi controls are rendered as visible lowercase Unicode escapes,
 * so OSC/CSI/DCS payloads cannot execute and invisible direction overrides
 * cannot reorder surrounding terminal chrome. LF survives only on explicitly
 * multiline surfaces.
 */
export function sanitizeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (options.multiline === true && codePoint === 0x0a) {
      sanitized += character;
    } else if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || BIDI_CONTROL.test(character)
    ) {
      sanitized += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      sanitized += character;
    }
  }
  return sanitized;
}
