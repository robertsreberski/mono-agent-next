// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { digest, isErrno } from "./internal-fs.js";
import {
  assertOwnerPrivatePlistStats,
  assertUnchangedJournalFileIdentity,
} from "./journal-guards.js";
import type { ServiceFileObservation } from "./service-types.js";

export async function observeOwnerPrivatePlist(
  path: string,
  expectedUid: number,
  options: { readonly allowTwoLinks?: boolean } = {},
): Promise<ServiceFileObservation> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return Object.freeze({ exists: false });
    }
    throw error;
  }
  const maximumLinks = options.allowTwoLinks === true ? 2n : 1n;
  assertOwnerPrivatePlistStats(
    path,
    before,
    expectedUid,
    maximumLinks,
  );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertOwnerPrivatePlistStats(
      path,
      opened,
      expectedUid,
      maximumLinks,
    );
    assertUnchangedJournalFileIdentity(path, before, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertOwnerPrivatePlistStats(
      path,
      after,
      expectedUid,
      maximumLinks,
    );
    assertUnchangedJournalFileIdentity(path, opened, after);
    if (after.size !== BigInt(bytes.byteLength)) {
      throw new Error(`${path} changed size while it was read.`);
    }
    const finalPath = await lstat(path, { bigint: true });
    assertOwnerPrivatePlistStats(
      path,
      finalPath,
      expectedUid,
      maximumLinks,
    );
    assertUnchangedJournalFileIdentity(path, after, finalPath);
    return Object.freeze({
      exists: true,
      digest: digest(bytes),
      bytes: bytes.byteLength,
      identity: Object.freeze({
        device: after.dev.toString(),
        inode: after.ino.toString(),
        ctimeNanoseconds: after.ctimeNs.toString(),
        uid: Number(after.uid),
        mode: Number(after.mode & 0o777n),
        links: Number(after.nlink),
        size: Number(after.size),
      }),
    });
  } finally {
    await handle.close();
  }
}
