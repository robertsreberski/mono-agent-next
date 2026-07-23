import { createHash } from "node:crypto";

import type { ArtifactRef } from "@mono-agent/module-sdk";
import type {
  StateCompareAndSwapRequest,
  StateCompareAndSwapResult,
  StateDeleteRequest,
  StateHostPresenceRequest,
  StateListArtifactsRequest,
  StateListArtifactsResult,
  StateListRequest,
  StateListResult,
  StatePresenceListRequest,
  StatePresenceRecord,
  StatePresenceRemoveRequest,
  StatePresenceUpsertRequest,
  StatePutArtifactRequest,
  StateReadArtifactRequest,
  StateReadRequest,
  StateRecord,
  StateScanRequest,
  StateScanResult,
  StateStore,
  StateTransactionRequest,
  StateTransactionResult,
  StateWriteRequest,
  StateWriteResult,
} from "@mono-agent/module-sdk/internal";

export class MemoryStateStore implements StateStore {
  readonly records = new Map<string, StateRecord>();
  readonly artifacts = new Map<string, Uint8Array>();
  transactionCalls = 0;
  failNextTransaction = false;
  failTransactionAt: number | undefined;
  #version = 0;

  async read(request: StateReadRequest): Promise<StateRecord | undefined> {
    const value = this.records.get(request.key);
    return value === undefined ? undefined : copyRecord(value);
  }

  async write(request: StateWriteRequest): Promise<StateWriteResult> {
    const current = this.records.get(request.key);
    if (
      request.expectedVersion !== undefined
      && current?.version !== request.expectedVersion
    ) {
      throw new Error("version mismatch");
    }
    const record = this.#record(request.key, request.value);
    this.records.set(request.key, record);
    return { version: record.version, updatedAt: record.updatedAt };
  }

  async delete(request: StateDeleteRequest): Promise<boolean> {
    const current = this.records.get(request.key);
    if (
      request.expectedVersion !== undefined
      && current?.version !== request.expectedVersion
    ) {
      throw new Error("version mismatch");
    }
    return this.records.delete(request.key);
  }

  async list(request: StateListRequest): Promise<StateListResult> {
    const result = await this.scan({
      prefix: request.prefix ?? "",
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: request.limit,
      signal: request.signal,
    });
    return result;
  }

  async compareAndSwap(
    request: StateCompareAndSwapRequest,
  ): Promise<StateCompareAndSwapResult> {
    const current = this.records.get(request.key);
    if (
      (request.expectedVersion === null && current !== undefined)
      || (
        request.expectedVersion !== null
        && current?.version !== request.expectedVersion
      )
    ) {
      return {
        status: "conflict",
        ...(current === undefined ? {} : { currentVersion: current.version }),
      };
    }
    const record = this.#record(request.key, request.value);
    this.records.set(request.key, record);
    return { status: "applied", record: copyRecord(record) };
  }

  async transaction(
    request: StateTransactionRequest,
  ): Promise<StateTransactionResult> {
    this.transactionCalls += 1;
    if (
      this.failNextTransaction
      || this.failTransactionAt === this.transactionCalls
    ) {
      this.failNextTransaction = false;
      throw new Error("injected transaction failure");
    }
    const conflicts = [
      ...request.checks,
      ...request.puts,
      ...request.deletes,
    ].flatMap((operation) => {
      const current = this.records.get(operation.key);
      const matches = operation.expectedVersion === null
        ? current === undefined
        : current?.version === operation.expectedVersion;
      return matches
        ? []
        : [{
            key: operation.key,
            ...(current === undefined ? {} : { currentVersion: current.version }),
          }];
    });
    if (conflicts.length > 0) return { status: "conflict", conflicts };

    const draft = new Map(this.records);
    const records: StateRecord[] = [];
    const deletedKeys: string[] = [];
    for (const put of request.puts) {
      const record = this.#record(put.key, put.value);
      draft.set(put.key, record);
      records.push(copyRecord(record));
    }
    for (const deletion of request.deletes) {
      if (draft.delete(deletion.key)) deletedKeys.push(deletion.key);
    }
    this.records.clear();
    for (const [key, value] of draft) this.records.set(key, value);
    return { status: "applied", records, deletedKeys };
  }

  async scan(request: StateScanRequest): Promise<StateScanResult> {
    const after = request.cursor === undefined
      ? undefined
      : decodeCursor(request.cursor, request.prefix);
    const matching = [...this.records.values()]
      .filter((record) =>
        record.key.startsWith(request.prefix)
        && (after === undefined || record.key > after))
      .sort((left, right) => left.key.localeCompare(right.key));
    const selected = matching.slice(0, request.limit);
    return {
      records: selected.map(copyRecord),
      ...(matching.length > selected.length
        ? {
            cursor: encodeCursor(
              request.prefix,
              selected[selected.length - 1]?.key ?? "",
            ),
          }
        : {}),
    };
  }

  async putArtifact(request: StatePutArtifactRequest): Promise<ArtifactRef> {
    const digest = createHash("sha256").update(request.data).digest("hex");
    const id = `artifact:sha256:${digest}`;
    this.artifacts.set(id, new Uint8Array(request.data));
    return {
      id,
      sha256: `sha256:${digest}`,
      sizeBytes: request.data.byteLength,
      mediaType: request.mediaType,
      ...(request.fileName === undefined ? {} : { fileName: request.fileName }),
    };
  }

  async readArtifact(request: StateReadArtifactRequest): Promise<Uint8Array> {
    const value = this.artifacts.get(request.ref.id);
    if (value === undefined) throw new Error("missing artifact");
    if (value.byteLength > request.maxBytes) throw new Error("artifact too large");
    return new Uint8Array(value);
  }

  async deleteArtifact(request: { readonly ref: ArtifactRef }): Promise<boolean> {
    return this.artifacts.delete(request.ref.id);
  }

  async listArtifacts(_request: StateListArtifactsRequest): Promise<StateListArtifactsResult> {
    return { artifacts: [] };
  }

  async upsertPresence(
    request: StatePresenceUpsertRequest,
  ): Promise<StatePresenceRecord> {
    return request.presence;
  }

  async removePresence(_request: StatePresenceRemoveRequest): Promise<boolean> {
    return false;
  }

  async listPresence(
    _request: StatePresenceListRequest,
  ): Promise<readonly StatePresenceRecord[]> {
    return [];
  }

  async publishHostPresence(_request: StateHostPresenceRequest): Promise<void> {}

  #record(key: string, value: Uint8Array): StateRecord {
    this.#version += 1;
    return {
      key,
      value: new Uint8Array(value),
      version: `v${String(this.#version)}`,
      updatedAt: "2026-07-23T10:00:00.000Z",
    };
  }
}

function copyRecord(record: StateRecord): StateRecord {
  return {
    ...record,
    value: new Uint8Array(record.value),
  };
}

function encodeCursor(prefix: string, key: string): string {
  return Buffer.from(JSON.stringify({ prefix, key }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, prefix: string): string {
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    readonly prefix: string;
    readonly key: string;
  };
  if (value.prefix !== prefix) throw new Error("cursor prefix mismatch");
  return value.key;
}
