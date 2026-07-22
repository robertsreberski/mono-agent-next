import type { MemoryStatus, MemoryType } from "../store/index.js";

import type { Bullet } from "./types.js";

const MARKERS: Record<string, { type: MemoryType; status: MemoryStatus }> = {
  "[ ]": { type: "task", status: "open" },
  "[x]": { type: "task", status: "done" },
  "[>]": { type: "task", status: "migrated" },
  "[<]": { type: "task", status: "scheduled" },
  "[~]": { type: "task", status: "dropped" },
  "◦": { type: "event", status: "open" },
  "–": { type: "note", status: "open" },
};

const STATUS_MARKER: Partial<Record<MemoryStatus, string>> = {
  done: "[x]",
  migrated: "[>]",
  scheduled: "[<]",
  dropped: "[~]",
  invalidated: "[~]", // rendered struck like dropped; the comment metadata stays authoritative for the real status
};

export const MARKER_FOR = (type: MemoryType, status: MemoryStatus): string => {
  // For task-style statuses (done/migrated/scheduled/dropped), the visible marker encodes status.
  const statusMarker = STATUS_MARKER[status];
  if (statusMarker !== undefined) return statusMarker;
  // For open status, use the type-specific marker.
  for (const [marker, m] of Object.entries(MARKERS)) {
    if (m.type === type && m.status === status) return marker;
  }
  // notes/events that have no direct marker fall back to the base marker
  if (type === "event") return "◦";
  return "–";
};

// Allowed enum members (must mirror the SQLite CHECK constraints in ../store/index.js).
// A malformed daily line (`type=bogus`, `status=invalid`) must NOT produce an out-of-enum Bullet,
// or rebuild/upsert would fail the CHECK constraint.
const VALID_TYPES = new Set<string>(["task", "event", "note"]);
const VALID_STATUSES = new Set<string>(["open", "done", "scheduled", "migrated", "dropped", "invalidated"]);

const BULLET_MARKER = String.raw`(\[[ x><~]\]|◦|–)`;
const LEGACY_LINE_RE = new RegExp(`^- ${BULLET_MARKER} (.*?)  <!--mem (.*)-->$`, "u");
const VISIBLE_LINE_RE = new RegExp(`^- ${BULLET_MARKER} (.*?)$`, "u");
const META_LINE_RE = /^\s+<!--mem (.*)-->$/u;

export function parseBullet(line: string): Bullet | undefined {
  const match = parseBulletParts(line);
  if (match === undefined) return undefined;
  const [, marker, text, meta] = match;
  const fields = parseMeta(meta ?? "");
  const base = MARKERS[marker ?? ""];
  if (base === undefined) return undefined;
  // Validate enum membership before trusting metadata; an empty OR invalid value (e.g. `status=` or
  // `status=bogus`) falls back to the marker-derived base value rather than corrupting the Bullet.
  const status = (VALID_STATUSES.has(fields.status ?? "") ? (fields.status as MemoryStatus) : undefined) ?? base.status;
  const type = (VALID_TYPES.has(fields.type ?? "") ? (fields.type as MemoryType) : undefined) ?? base.type;
  // A bullet needs a stable id, a created timestamp, and non-empty text. Missing/blank values (e.g.
  // `id=` or `created=`) would yield id="" — a primary-key collision on rebuild and impossible to
  // rewrite-by-id. Treat such malformed lines as non-bullets rather than corrupting the index.
  const id = (fields.id ?? "").trim();
  const createdAt = (fields.created ?? "").trim();
  const bulletText = (text ?? "").trim();
  if (id === "" || createdAt === "" || bulletText === "") return undefined;
  const salienceNum = Number(fields.salience);
  const bullet: Bullet = {
    id,
    type,
    status,
    text: bulletText,
    salience: fields.salience !== undefined && Number.isFinite(salienceNum) ? salienceNum : 0.5,
    isInsight: fields.isInsight === "1",
    createdAt,
    refs: fields.refs === undefined || fields.refs.length === 0 ? [] : fields.refs.split(","),
    ...(fields.due !== undefined ? { dueAt: fields.due } : {}),
  };
  return bullet;
}

export function serializeBullet(bullet: Bullet): string {
  if (/[\r\n\p{Zl}\p{Zp}]/u.test(bullet.text) || bullet.text.includes("<!--mem")) {
    throw new Error("memory-bujo: bullet text must not contain a newline or the '<!--mem' delimiter.");
  }
  const marker = MARKER_FOR(bullet.type, bullet.status);
  const meta = [
    `id=${bullet.id}`,
    `type=${bullet.type}`,
    `status=${bullet.status}`,
    `salience=${bullet.salience}`,
    `isInsight=${bullet.isInsight ? "1" : "0"}`,
    `created=${bullet.createdAt}`,
    `refs=${bullet.refs.join(",")}`,
    ...(bullet.dueAt === undefined ? [] : [`due=${bullet.dueAt}`]),
  ].join(" ");
  return `- ${marker} ${bullet.text}\n  <!--mem ${meta}-->`;
}

function parseBulletParts(line: string): RegExpExecArray | undefined {
  const legacy = LEGACY_LINE_RE.exec(line);
  if (legacy !== null) return legacy;

  const split = line.split("\n");
  if (split.length !== 2) return undefined;
  const visible = VISIBLE_LINE_RE.exec(split[0] ?? "");
  const meta = META_LINE_RE.exec(split[1] ?? "");
  if (visible === null || meta === null) return undefined;
  const out = [line, visible[1] ?? "", visible[2] ?? "", meta[1] ?? ""] as unknown as RegExpExecArray;
  out.index = 0;
  out.input = line;
  return out;
}

function parseMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of meta.trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export interface DailyLine {
  readonly raw: string;
  readonly lineNumber: number;
  readonly bullet?: Bullet;
}

export interface DailyFile {
  readonly lines: readonly DailyLine[];
}

export function parseDailyFile(content: string): DailyFile & { bullets: Bullet[] } {
  const rawLines = content.split("\n");
  const lines: DailyLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const lineNumber = i + 1;
    const bullet = parseBullet(raw);
    if (bullet !== undefined) {
      lines.push({ raw, lineNumber, bullet });
      continue;
    }

    const next = rawLines[i + 1];
    if (next !== undefined) {
      const splitRaw = `${raw}\n${next}`;
      const splitBullet = parseBullet(splitRaw);
      if (splitBullet !== undefined) {
        lines.push({ raw: splitRaw, lineNumber, bullet: splitBullet });
        i += 1;
        continue;
      }
    }

    lines.push({ raw, lineNumber });
  }
  return { lines, bullets: lines.flatMap((l) => (l.bullet ? [l.bullet] : [])) };
}

export function serializeDailyFile(file: DailyFile): string {
  return file.lines.map((l) => (l.bullet ? serializeBullet(l.bullet) : l.raw)).join("\n");
}
