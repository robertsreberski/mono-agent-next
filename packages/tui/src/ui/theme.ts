import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/**
 * ANSI styling for the whole TUI. pi-tui has no named-role theme registry —
 * components take per-component theme objects of styling functions — so this
 * module is the single place colors live. 4-bit/8-bit SGR only (no truecolor)
 * so both dark and light terminals stay legible.
 */

const wrap = (open: string, close: string) => (text: string): string =>
  text.length === 0 ? text : `\u001b[${open}m${text}\u001b[${close}m`;

const fg = (color: number) => wrap(`38;5;${color}`, "39");

export const styles = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),
  strikethrough: wrap("9", "29"),
  inverse: wrap("7", "27"),

  accent: fg(45), // cyan — interactive highlights, headers
  info: fg(75), // blue — neutral notices
  user: fg(114), // green — user-authored text
  muted: fg(245), // gray — chrome, secondary text
  warning: fg(214), // orange — warnings, failover
  error: fg(203), // red — errors
  success: fg(114), // green — completed tools
  thinking: (text: string): string => styles.dim(styles.italic(text)),
  code: fg(180),
  link: fg(75),
} as const;

export const markdownTheme: MarkdownTheme = {
  heading: (text) => styles.bold(styles.accent(text)),
  link: styles.link,
  linkUrl: (text) => styles.dim(styles.link(text)),
  code: styles.code,
  codeBlock: styles.code,
  codeBlockBorder: styles.muted,
  quote: styles.muted,
  quoteBorder: styles.muted,
  hr: styles.muted,
  listBullet: styles.accent,
  bold: styles.bold,
  italic: styles.italic,
  strikethrough: styles.strikethrough,
  underline: styles.underline,
};

/** Markdown theme for collapsed/secondary content (thinking, previews). */
export const dimMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  heading: (text) => styles.dim(styles.bold(text)),
  listBullet: styles.dim,
  code: styles.dim,
  codeBlock: styles.dim,
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: styles.accent,
  selectedText: (text) => styles.bold(styles.accent(text)),
  description: styles.muted,
  scrollInfo: styles.dim,
  noMatch: styles.dim,
};

export const editorTheme: EditorTheme = {
  borderColor: styles.muted,
  selectList: selectListTheme,
};
