export const CANONICAL_VISIBLE_BULLET = /^- (?:\[[ x><~]\]|◦|–) /u;
const VALID_BULLET_TYPES = new Set(["task", "event", "note"]);
const VALID_BULLET_STATUSES = new Set(["open", "done", "scheduled", "migrated", "dropped", "invalidated"]);

export function assertStrictBulletRaw(raw: string, file: string, line: number): void {
  const match = /<!--mem\s+(.+?)-->/u.exec(raw);
  if (match === null) throw new Error(`memory-rebuild: canonical bullet metadata is missing at ${file}:${line}.`);
  const fields = parseMetadataFields(match[1] ?? "", file, line);
  const required = ["id", "type", "status", "salience", "isInsight", "created", "refs"];
  if (required.some((key) => !fields.has(key))) {
    throw new Error(`memory-rebuild: incomplete bullet metadata at ${file}:${line}.`);
  }
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) {
    throw new Error(`memory-rebuild: invalid bullet type/status at ${file}:${line}.`);
  }
  if (!Number.isFinite(Number(fields.get("salience")))) {
    throw new Error(`memory-rebuild: invalid bullet salience at ${file}:${line}.`);
  }
  if (fields.get("isInsight") !== "0" && fields.get("isInsight") !== "1") {
    throw new Error(`memory-rebuild: invalid bullet isInsight at ${file}:${line}.`);
  }
  if (!Number.isFinite(Date.parse(fields.get("created") ?? ""))) {
    throw new Error(`memory-rebuild: invalid bullet created timestamp at ${file}:${line}.`);
  }
  const due = fields.get("due");
  if (due !== undefined && !Number.isFinite(Date.parse(due))) {
    throw new Error(`memory-rebuild: invalid bullet due timestamp at ${file}:${line}.`);
  }
}

export function isMissingOnlyIdentity(raw: string): boolean {
  if (!CANONICAL_VISIBLE_BULLET.test(raw)) return false;
  const match = /<!--mem\s+(.+?)-->/u.exec(raw);
  if (match === null) return false;
  const fields = tryParseMetadataFields(match[1] ?? "");
  if (fields === undefined || (fields.get("id") ?? "") !== "") return false;
  const requiredWithoutIdentity = ["type", "status", "salience", "isInsight", "created", "refs"];
  if (requiredWithoutIdentity.some((key) => !fields.has(key))) return false;
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) return false;
  if (!Number.isFinite(Number(fields.get("salience")))) return false;
  if (fields.get("isInsight") !== "0" && fields.get("isInsight") !== "1") return false;
  if (!Number.isFinite(Date.parse(fields.get("created") ?? ""))) return false;
  const due = fields.get("due");
  return due === undefined || Number.isFinite(Date.parse(due));
}

export function isLegacySourceRecord(raw: string): boolean {
  if (raw.includes("\n") || !raw.startsWith("- ")) return false;
  if ((raw.match(/<!--mem/gu) ?? []).length !== 1 || (raw.match(/-->/gu) ?? []).length !== 1) return false;
  const match = /<!--mem\s+(.+?)-->\s*$/u.exec(raw);
  if (match === null) return false;
  const fields = tryParseMetadataFields(match[1] ?? "");
  if (fields === undefined) return false;
  const keys = [...fields.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(["salience", "source", "status", "type"])) return false;
  if (!VALID_BULLET_TYPES.has(fields.get("type") ?? "") || !VALID_BULLET_STATUSES.has(fields.get("status") ?? "")) return false;
  if (!Number.isFinite(Number(fields.get("salience")))) return false;
  return (fields.get("source") ?? "").length > 0;
}

function parseMetadataFields(raw: string, file: string, line: number): Map<string, string> {
  const fields = new Map<string, string>();
  for (const pair of raw.trim().split(/\s+/u)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`memory-rebuild: malformed bullet metadata at ${file}:${line}.`);
    const key = pair.slice(0, separator);
    if (fields.has(key)) {
      throw new Error(`memory-rebuild: duplicate bullet metadata key ${key} at ${file}:${line}.`);
    }
    fields.set(key, pair.slice(separator + 1));
  }
  return fields;
}

function tryParseMetadataFields(raw: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  for (const pair of raw.trim().split(/\s+/u)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) return undefined;
    const key = pair.slice(0, separator);
    if (fields.has(key)) return undefined;
    fields.set(key, pair.slice(separator + 1));
  }
  return fields;
}
