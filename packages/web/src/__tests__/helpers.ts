// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories = new Set<string>();

export async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mono-agent-web-test-"));
  directories.add(path);
  return path;
}

export async function cleanup(): Promise<void> {
  await Promise.all([...directories].map(async (path) => rm(path, { recursive: true, force: true })));
  directories.clear();
}
