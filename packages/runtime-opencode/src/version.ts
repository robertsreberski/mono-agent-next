export type VersionTuple = readonly [number, number, number];

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const EMBEDDED_VERSION = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u;

function tuple(match: RegExpExecArray): VersionTuple {
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function parseStableVersion(value: string): VersionTuple | undefined {
  const match = STABLE_VERSION.exec(value);
  return match === null ? undefined : tuple(match);
}

export function extractVersion(value: string): VersionTuple | undefined {
  const match = EMBEDDED_VERSION.exec(value);
  return match === null ? undefined : tuple(match);
}

export function versionAtLeast(
  actual: VersionTuple,
  minimum: VersionTuple,
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((actual[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}
