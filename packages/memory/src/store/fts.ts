/** Build a safe FTS5 MATCH expression: quote each alphanumeric token, OR them. */
export function ftsQuery(raw: string): string {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
