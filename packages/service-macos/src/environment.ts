import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface ProtectedEnvironment {
  readonly source: string;
  readonly values: Readonly<Record<string, string>>;
}

export async function loadProtectedEnvironment(
  path: string,
  expectedUid: number,
): Promise<ProtectedEnvironment> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid || (before.mode & 0o777) !== 0o600) {
    throw new Error(`${path} must be an owner-private regular file (mode 0600, uid ${String(expectedUid)}).`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
      throw new Error(`${path} changed identity while it was opened.`);
    }
    if (after.size > 1_048_576) throw new Error(`${path} exceeds the 1 MiB environment limit.`);
    const source = await handle.readFile("utf8");
    return Object.freeze({ source, values: Object.freeze(parseEnvironment(source, path)) });
  } finally {
    await handle.close();
  }
}

export function parseEnvironment(source: string, path = "environment file"): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [index, raw] of source.replace(/\r\n?/gu, "\n").split("\n").entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) throw new Error(`${path}:${String(index + 1)} is not a KEY=value assignment.`);
    const key = match[1]!;
    if (Object.hasOwn(values, key)) throw new Error(`${path}:${String(index + 1)} repeats ${key}.`);
    values[key] = unquote(match[2] ?? "", path, index + 1);
  }
  return values;
}

function unquote(value: string, path: string, line: number): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value;
  if (value.at(-1) !== quote) throw new Error(`${path}:${String(line)} has an unterminated quoted value.`);
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\([\\"nrt])/gu, (_match, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    return character;
  });
}
