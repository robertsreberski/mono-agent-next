// SPDX-License-Identifier: MIT
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const wrap = (open: string, close: string) => (text: string): string =>
  text.length === 0 ? text : `\u001b[${open}m${text}\u001b[${close}m`;
const color = (code: number) => wrap(`38;5;${String(code)}`, "39");

export const style = {
  accent: color(45),
  assistant: color(252),
  error: color(203),
  muted: color(245),
  user: color(114),
  warning: color(214),
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),
  strike: wrap("9", "29"),
} as const;

const selectList: SelectListTheme = {
  selectedPrefix: style.accent,
  selectedText: (text) => style.bold(style.accent(text)),
  description: style.muted,
  scrollInfo: style.dim,
  noMatch: style.dim,
};

export const editorTheme: EditorTheme = { borderColor: style.muted, selectList };

export const markdownTheme: MarkdownTheme = {
  heading: (text) => style.bold(style.accent(text)),
  link: style.underline,
  linkUrl: style.dim,
  code: style.warning,
  codeBlock: style.warning,
  codeBlockBorder: style.muted,
  quote: style.muted,
  quoteBorder: style.muted,
  hr: style.muted,
  listBullet: style.accent,
  bold: style.bold,
  italic: style.italic,
  strikethrough: style.strike,
  underline: style.underline,
};
