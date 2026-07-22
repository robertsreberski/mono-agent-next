import { lstat, rm } from "node:fs/promises";

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface AttachmentFileIdentity extends FileIdentity {
  readonly path: string;
}

export function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(
  stats: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

/** Delete only the directory object this request created; never follow swaps. */
export async function removeOwnedDirectory(path: string, expected: FileIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) {
    return;
  }
  await rm(path, { recursive: true, force: true });
}
