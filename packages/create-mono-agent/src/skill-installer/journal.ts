// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  JOURNAL_MAX_BYTES,
  NO_FOLLOW,
  SKILL_NAME,
  UUID_PATTERN,
  archiveExactFile,
  assertDirectoryIdentity,
  assertEmptyDirectory,
  assertOwnerPrivate,
  assertPathAbsent,
  assertRealDirectory,
  hasExactKeys,
  identityOf,
  inferredReservationIdentity,
  isRecord,
  lstatOrUndefined,
  parseIdentity,
  parseSourceDescriptors,
  pidIsAlive,
  readOwnerFile,
  sameFileIdentity,
  sameIdentity,
  syncDirectory,
  validateExactTree,
  writeFully,
  type FileIdentity,
  type SourceDescriptor,
} from "./fs.ts";

const JOURNAL_NAME = ".mono-agent-composer.install-journal-v1";

interface RestoreAttempt {
  readonly attempt: number;
  readonly identity?: FileIdentity;
}

interface JournalHeader {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.composer-skill-install";
  readonly nonce: string;
  readonly ownerPid: number;
  readonly home: string;
  readonly homeIdentity: FileIdentity;
  readonly source: readonly SourceDescriptor[];
  readonly plans: readonly JournalPlan[];
}

interface JournalPlan {
  readonly target: "claude" | "codex";
  readonly productRoot: string;
  readonly productIdentity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly destination: string;
  readonly stage: string;
  readonly backup?: string;
  readonly priorIdentity?: FileIdentity;
}

interface JournalState {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly header: JournalHeader;
  readonly stages: ReadonlyMap<string, FileIdentity>;
  readonly reservationIntents: ReadonlySet<string>;
  readonly reservations: ReadonlyMap<string, FileIdentity>;
  readonly restoreAttempts: ReadonlyMap<string, RestoreAttempt>;
  readonly prepared: boolean;
  readonly committed: boolean;
}

interface JournalCreatePlan {
  readonly authority: {
    readonly target: "claude" | "codex";
    readonly productRoot: string;
    readonly productIdentity: FileIdentity;
    readonly parent: string;
    readonly parentIdentity: FileIdentity;
  };
  readonly destination: string;
  readonly stage: string;
  readonly backup?: string;
  readonly priorIdentity?: FileIdentity;
}

export interface OpenJournal {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly nonce: string;
  readonly handle: FileHandle;
}

export async function createJournal(
  home: { readonly path: string; readonly identity: FileIdentity },
  nonce: string,
  source: readonly SourceDescriptor[],
  plans: readonly JournalCreatePlan[],
): Promise<OpenJournal> {
  const path = join(home.path, JOURNAL_NAME);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
      | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  const identity = identityOf(await handle.stat());
  const header: JournalHeader = Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.composer-skill-install",
    nonce,
    ownerPid: process.pid,
    home: home.path,
    homeIdentity: home.identity,
    source: Object.freeze(source.map((entry) => Object.freeze({ ...entry }))),
    plans: Object.freeze(plans.map((plan): JournalPlan => Object.freeze({
      target: plan.authority.target,
      productRoot: plan.authority.productRoot,
      productIdentity: plan.authority.productIdentity,
      parent: plan.authority.parent,
      parentIdentity: plan.authority.parentIdentity,
      destination: plan.destination,
      stage: plan.stage,
      ...(plan.backup === undefined ? {} : { backup: plan.backup }),
      ...(plan.priorIdentity === undefined
        ? {}
        : { priorIdentity: plan.priorIdentity }),
    }))),
  });
  const journal = Object.freeze({ path, identity, nonce, handle });
  await appendJournal(journal, header);
  await syncDirectory(home.path);
  return journal;
}

export async function appendJournal(
  journal: OpenJournal,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeFully(journal.handle, bytes);
  await journal.handle.sync();
}

export async function recoverStaleJournal(
  home: string,
  homeIdentity: FileIdentity,
  allowCurrentProcess = false,
): Promise<readonly string[]> {
  const path = join(home, JOURNAL_NAME);
  const details = await lstatOrUndefined(path);
  if (details === undefined) return Object.freeze([]);
  await assertDirectoryIdentity(
    home,
    homeIdentity,
    "home directory",
    "authority",
  );
  const state = await readJournal(path, home, homeIdentity);
  if (!allowCurrentProcess && pidIsAlive(state.header.ownerPid)) {
    throw new Error(`An active install journal remains at ${path}.`);
  }
  if (state.committed) {
    for (const plan of state.header.plans) {
      const stageIdentity = state.stages.get(plan.target);
      if (stageIdentity === undefined) {
        throw journalRecoveryError(state, plan, "Committed journal is missing stage identity");
      }
      await assertJournalAuthority(state.header, plan);
      await validateExactTree(
        plan.destination,
        stageIdentity,
        state.header.source,
        true,
      );
    }
    await archiveJournal(state, home, "committed-recovered");
    return Object.freeze(state.header.plans.flatMap((plan) =>
      plan.backup === undefined ? [] : [plan.backup]));
  }

  const retained: string[] = [];
  for (const plan of [...state.header.plans].reverse()) {
    await assertJournalAuthority(state.header, plan);
    const stageIdentity = state.stages.get(plan.target);
    const reservationIdentity = state.reservations.get(plan.target);
    const restoreAttempt = state.restoreAttempts.get(plan.target);
    await collectExistingQuarantines(
      state,
      plan,
      stageIdentity,
      reservationIdentity,
      restoreAttempt,
      retained,
    );
    let destination = await lstatOrUndefined(plan.destination);
    const backup = plan.backup === undefined
      ? undefined
      : await lstatOrUndefined(plan.backup);

    if (plan.priorIdentity !== undefined && plan.backup !== undefined) {
      if (backup !== undefined) {
        assertRealDirectory(backup, "skill backup");
        assertOwnerPrivate(backup, "skill backup", true);
        if (!sameFileIdentity(identityOf(backup), plan.priorIdentity)) {
          throw journalRecoveryError(state, plan, "Backup identity is unknown");
        }
        if (destination !== undefined) {
          const destinationIdentity = identityOf(destination);
          if (restoreAttempt !== undefined) {
            if (
              restoreAttempt.identity !== undefined
              && sameFileIdentity(destinationIdentity, restoreAttempt.identity)
            ) {
              await assertEmptyDirectory(
                plan.destination,
                restoreAttempt.identity,
                "restore reservation",
              );
            } else if (
              restoreAttempt.identity === undefined
              && await inferredReservationIdentity(plan.destination) !== undefined
            ) {
              pushRetained(retained, await quarantineJournalTree(
                state,
                plan,
                destinationIdentity,
                `${plan.target}-restore-${String(restoreAttempt.attempt)}`,
              ));
              destination = undefined;
            } else {
              throw journalRecoveryError(
                state,
                plan,
                "Unknown destination prevents interrupted restore recovery",
              );
            }
          } else if (
            isKnownInstallIdentity(
              destinationIdentity,
              stageIdentity,
              reservationIdentity,
            )
            || (
              state.reservationIntents.has(plan.target)
              && await inferredReservationIdentity(plan.destination) !== undefined
            )
          ) {
            pushRetained(retained, await quarantineJournalTree(
              state,
              plan,
              destinationIdentity,
              `${plan.target}-new`,
            ));
            destination = undefined;
          } else {
            throw journalRecoveryError(
              state,
              plan,
              "Destination competitor prevents automatic backup restore",
            );
          }
        }
        if (destination === undefined) {
          await restoreExactBackup(state, plan);
        } else if (
          restoreAttempt?.identity !== undefined
          && sameFileIdentity(identityOf(destination), restoreAttempt.identity)
        ) {
          await restoreExactBackup(state, plan);
        } else {
          throw journalRecoveryError(
            state,
            plan,
            "Destination prevents exact backup restore",
          );
        }
      } else if (
        destination === undefined
        || !sameFileIdentity(identityOf(destination), plan.priorIdentity)
      ) {
        throw journalRecoveryError(state, plan, "Prior install is not recoverable");
      } else {
        assertRealDirectory(destination, "restored skill");
        assertOwnerPrivate(destination, "restored skill", true);
      }
    } else if (destination !== undefined) {
      const destinationIdentity = identityOf(destination);
      if (
        isKnownInstallIdentity(
          destinationIdentity,
          stageIdentity,
          reservationIdentity,
        )
        || (
          state.reservationIntents.has(plan.target)
          && await inferredReservationIdentity(plan.destination) !== undefined
        )
      ) {
        pushRetained(retained, await quarantineJournalTree(
          state,
          plan,
          destinationIdentity,
          `${plan.target}-new`,
        ));
      } else {
        throw journalRecoveryError(
          state,
          plan,
          "Unknown destination prevents automatic rollback",
        );
      }
    }

    if (stageIdentity !== undefined) {
      const stage = await lstatOrUndefined(plan.stage);
      if (
        stage !== undefined
        && sameFileIdentity(identityOf(stage), stageIdentity)
      ) {
        pushRetained(retained, await quarantineJournalTree(
          state,
          plan,
          stageIdentity,
          `${plan.target}-stage`,
          plan.stage,
        ));
      } else if (stage !== undefined) {
        // Never delete or move an identity that is not journal-authorized.
        pushRetained(retained, plan.stage);
      }
    } else if (await lstatOrUndefined(plan.stage) !== undefined) {
      // A crash can happen after mkdir and before the stage identity frame is
      // durable. Its deterministic path is reported but never moved or
      // recursively removed because the journal cannot authorize its inode.
      pushRetained(retained, plan.stage);
    }
    await assertJournalAuthority(state.header, plan);
  }
  await archiveJournal(state, home, state.prepared ? "rolled-back" : "abandoned");
  return Object.freeze(retained);
}

function isKnownInstallIdentity(
  candidate: FileIdentity,
  stage: FileIdentity | undefined,
  reservation: FileIdentity | undefined,
): boolean {
  return (stage !== undefined && sameFileIdentity(candidate, stage))
    || (reservation !== undefined && sameFileIdentity(candidate, reservation));
}

async function collectExistingQuarantines(
  state: JournalState,
  plan: JournalPlan,
  stageIdentity: FileIdentity | undefined,
  reservationIdentity: FileIdentity | undefined,
  restoreAttempt: RestoreAttempt | undefined,
  retained: string[],
): Promise<void> {
  const newQuarantine = quarantinePath(
    plan.parent,
    state.header.nonce,
    `${plan.target}-new`,
  );
  const newDetails = await lstatOrUndefined(newQuarantine);
  if (newDetails !== undefined) {
    const identity = identityOf(newDetails);
    if (
      isKnownInstallIdentity(identity, stageIdentity, reservationIdentity)
    ) {
      await assertDirectoryIdentity(
        newQuarantine,
        identity,
        "retained install quarantine",
        "private",
      );
    } else if (
      !state.reservationIntents.has(plan.target)
      || await inferredReservationIdentity(newQuarantine) === undefined
    ) {
      throw journalRecoveryError(state, plan, "Install quarantine identity is unknown");
    }
    pushRetained(retained, newQuarantine);
  }

  const stageQuarantine = quarantinePath(
    plan.parent,
    state.header.nonce,
    `${plan.target}-stage`,
  );
  const stageDetails = await lstatOrUndefined(stageQuarantine);
  if (stageDetails !== undefined) {
    if (
      stageIdentity === undefined
      || !sameFileIdentity(identityOf(stageDetails), stageIdentity)
    ) {
      throw journalRecoveryError(state, plan, "Stage quarantine identity is unknown");
    }
    await assertDirectoryIdentity(
      stageQuarantine,
      stageIdentity,
      "retained stage quarantine",
      "private",
    );
    pushRetained(retained, stageQuarantine);
  }

  if (restoreAttempt !== undefined) {
    for (let attempt = 0; attempt <= restoreAttempt.attempt; attempt += 1) {
      const restoreQuarantine = quarantinePath(
        plan.parent,
        state.header.nonce,
        `${plan.target}-restore-${String(attempt)}`,
      );
      if (await lstatOrUndefined(restoreQuarantine) === undefined) continue;
      if (await inferredReservationIdentity(restoreQuarantine) === undefined) {
        throw journalRecoveryError(
          state,
          plan,
          "Restore reservation quarantine identity is unknown",
        );
      }
      pushRetained(retained, restoreQuarantine);
    }
  }
}

async function restoreExactBackup(
  state: JournalState,
  plan: JournalPlan,
): Promise<void> {
  if (plan.backup === undefined || plan.priorIdentity === undefined) return;
  await assertJournalAuthority(state.header, plan);
  await assertDirectoryIdentity(
    plan.backup,
    plan.priorIdentity,
    "skill backup",
    "private",
  );

  let attempt = state.restoreAttempts.get(plan.target);
  let reservationIdentity: FileIdentity;
  const destination = await lstatOrUndefined(plan.destination);
  if (destination !== undefined) {
    if (
      attempt?.identity === undefined
      || !sameFileIdentity(identityOf(destination), attempt.identity)
    ) {
      throw journalRecoveryError(
        state,
        plan,
        "Unknown destination remains before backup restore",
      );
    }
    reservationIdentity = attempt.identity;
    await assertEmptyDirectory(
      plan.destination,
      reservationIdentity,
      "restore reservation",
    );
  } else {
    if (attempt === undefined) {
      attempt = Object.freeze({ attempt: 0 });
      await appendRecoveryJournal(state, Object.freeze({
        phase: "restore-intent",
        target: plan.target,
        attempt: attempt.attempt,
      }));
    } else if (
      attempt.identity === undefined
      && await lstatOrUndefined(quarantinePath(
        plan.parent,
        state.header.nonce,
        `${plan.target}-restore-${String(attempt.attempt)}`,
      )) !== undefined
    ) {
      attempt = Object.freeze({ attempt: attempt.attempt + 1 });
      await appendRecoveryJournal(state, Object.freeze({
        phase: "restore-intent",
        target: plan.target,
        attempt: attempt.attempt,
      }));
    } else if (attempt.identity !== undefined) {
      throw journalRecoveryError(
        state,
        plan,
        "Durable restore reservation disappeared",
      );
    }

    await assertJournalAuthority(state.header, plan);
    await assertPathAbsent(plan.destination, "restore reservation");
    await mkdir(plan.destination, { mode: 0o700 });
    await assertJournalAuthority(state.header, plan);
    const reservation = await lstat(plan.destination);
    assertRealDirectory(reservation, "restore reservation");
    assertOwnerPrivate(reservation, "restore reservation", true);
    reservationIdentity = identityOf(reservation);
    await assertEmptyDirectory(
      plan.destination,
      reservationIdentity,
      "restore reservation",
    );
    await syncDirectory(plan.parent);
    await appendRecoveryJournal(state, Object.freeze({
      phase: "restore-reserved",
      target: plan.target,
      attempt: attempt.attempt,
      identity: reservationIdentity,
    }));
  }

  await assertJournalAuthority(state.header, plan);
  await assertEmptyDirectory(
    plan.destination,
    reservationIdentity,
    "restore reservation",
  );
  await assertDirectoryIdentity(
    plan.backup,
    plan.priorIdentity,
    "skill backup",
    "private",
  );
  await assertJournalAuthority(state.header, plan);
  await rename(plan.backup, plan.destination);
  await assertJournalAuthority(state.header, plan);
  await assertDirectoryIdentity(
    plan.destination,
    plan.priorIdentity,
    "restored skill",
    "private",
  );
  await syncDirectory(plan.parent);
}

async function quarantineJournalTree(
  state: JournalState,
  plan: JournalPlan,
  identity: FileIdentity,
  label: string,
  path = plan.destination,
): Promise<string> {
  await assertJournalAuthority(state.header, plan);
  const quarantine = await quarantineExactTree(
    path,
    identity,
    plan.parent,
    state.header.nonce,
    label,
  );
  await assertJournalAuthority(state.header, plan);
  return quarantine;
}

function quarantinePath(parent: string, nonce: string, label: string): string {
  return join(parent, `.${SKILL_NAME}.quarantine-${nonce}-${label}`);
}

function pushRetained(retained: string[], path: string): void {
  if (!retained.includes(path)) retained.push(path);
}

async function quarantineExactTree(
  path: string,
  identity: FileIdentity,
  parent: string,
  nonce: string,
  label: string,
): Promise<string> {
  await assertDirectoryIdentity(path, identity, "quarantined tree", "private");
  const quarantine = quarantinePath(parent, nonce, label);
  if (await lstatOrUndefined(quarantine) !== undefined) {
    throw new Error(`Recovery quarantine already exists at ${quarantine}.`);
  }
  await rename(path, quarantine);
  await assertDirectoryIdentity(quarantine, identity, "quarantined tree", "private");
  await syncDirectory(parent);
  return quarantine;
}

async function appendRecoveryJournal(
  state: JournalState,
  value: unknown,
): Promise<void> {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const details = await lstat(state.path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Install journal ${state.path} is no longer a regular file.`);
  }
  assertOwnerPrivate(details, "install journal", true);
  if (!sameFileIdentity(identityOf(details), state.identity)) {
    throw new Error(`Install journal ${state.path} changed identity.`);
  }
  if (details.size + frame.byteLength > JOURNAL_MAX_BYTES) {
    throw new Error(`Install journal ${state.path} exceeds its byte bound.`);
  }
  const handle = await open(
    state.path,
    constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!sameIdentity(details, opened)) {
      throw new Error(`Install journal ${state.path} changed while opening.`);
    }
    await writeFully(handle, frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await lstat(state.path);
  if (!sameFileIdentity(identityOf(after), state.identity)) {
    throw new Error(`Install journal ${state.path} changed after append.`);
  }
}

async function readJournal(
  path: string,
  expectedHome: string,
  expectedHomeIdentity: FileIdentity,
): Promise<JournalState> {
  const file = await readOwnerFile(path, "install journal");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n").slice(0, -1);
  if (lines.length < 1) throw new Error(`Install journal ${path} has no durable frame.`);
  const frames = lines.map((line) => JSON.parse(line) as unknown);
  const header = parseJournalHeader(frames[0], expectedHome, expectedHomeIdentity);
  const stages = new Map<string, FileIdentity>();
  const reservationIntents = new Set<string>();
  const reservations = new Map<string, FileIdentity>();
  const restoreAttempts = new Map<string, RestoreAttempt>();
  const backedUp = new Set<string>();
  const installed = new Set<string>();
  const plans = new Map(header.plans.map((plan) => [plan.target, plan]));
  let prepared = false;
  let committed = false;
  for (const frame of frames.slice(1)) {
    if (!isRecord(frame) || typeof frame.phase !== "string") {
      throw new Error(`Install journal ${path} contains an invalid frame.`);
    }
    if (committed) {
      throw new Error(`Install journal ${path} contains a frame after commit.`);
    }
    if (frame.phase === "stage-created") {
      if (
        prepared
        || !hasExactKeys(frame, ["phase", "target", "identity"])
      ) {
        throw new Error(`Install journal ${path} contains an invalid stage frame.`);
      }
      const target = journalTarget(frame.target);
      if (!plans.has(target)) {
        throw new Error(`Install journal ${path} stages an unplanned target.`);
      }
      const identity = parseIdentity(frame.identity, "journal frame identity");
      if (stages.has(target)) {
        throw new Error(`Install journal ${path} repeats stage-created.`);
      }
      stages.set(target, identity);
    } else if (frame.phase === "prepared") {
      if (
        prepared
        || !hasExactKeys(frame, ["phase"])
        || stages.size !== header.plans.length
      ) {
        throw new Error(`Install journal ${path} contains an invalid prepared frame.`);
      }
      prepared = true;
    } else if (frame.phase === "reservation-intent") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid reservation intent.`);
      }
      const target = journalTarget(frame.target);
      if (
        !plans.has(target)
        || reservationIntents.has(target)
        || backedUp.has(target)
        || reservations.has(target)
        || installed.has(target)
      ) {
        throw new Error(`Install journal ${path} repeats or misorders reservation intent.`);
      }
      reservationIntents.add(target);
    } else if (frame.phase === "backup-moved") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid backup frame.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      if (
        plan?.priorIdentity === undefined
        || !reservationIntents.has(target)
        || backedUp.has(target)
        || reservations.has(target)
      ) {
        throw new Error(`Install journal ${path} contains an invalid backup transition.`);
      }
      backedUp.add(target);
    } else if (frame.phase === "reserved") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "identity"])
      ) {
        throw new Error(`Install journal ${path} contains an invalid reservation frame.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      if (
        plan === undefined
        || !reservationIntents.has(target)
        || reservations.has(target)
        || installed.has(target)
        || (plan.priorIdentity !== undefined && !backedUp.has(target))
      ) {
        throw new Error(`Install journal ${path} contains an invalid reservation transition.`);
      }
      reservations.set(
        target,
        parseIdentity(frame.identity, "journal frame identity"),
      );
    } else if (frame.phase === "restore-intent") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "attempt"])
        || !Number.isSafeInteger(frame.attempt)
        || (frame.attempt as number) < 0
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore intent.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      const previous = restoreAttempts.get(target);
      const expectedAttempt = previous === undefined ? 0 : previous.attempt + 1;
      if (
        plan?.priorIdentity === undefined
        || !reservationIntents.has(target)
        || frame.attempt !== expectedAttempt
        || previous?.identity !== undefined
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore transition.`);
      }
      restoreAttempts.set(target, Object.freeze({
        attempt: frame.attempt as number,
      }));
    } else if (frame.phase === "restore-reserved") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "attempt", "identity"])
        || !Number.isSafeInteger(frame.attempt)
        || (frame.attempt as number) < 0
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore reservation.`);
      }
      const target = journalTarget(frame.target);
      const previous = restoreAttempts.get(target);
      if (
        previous === undefined
        || previous.attempt !== frame.attempt
        || previous.identity !== undefined
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore reservation transition.`);
      }
      restoreAttempts.set(target, Object.freeze({
        attempt: previous.attempt,
        identity: parseIdentity(frame.identity, "journal restore identity"),
      }));
    } else if (frame.phase === "installed") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid installed frame.`);
      }
      const target = journalTarget(frame.target);
      if (!reservations.has(target) || installed.has(target)) {
        throw new Error(`Install journal ${path} contains an invalid install transition.`);
      }
      installed.add(target);
    } else if (frame.phase === "committed") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase"])
        || installed.size !== header.plans.length
      ) {
        throw new Error(`Install journal ${path} contains an invalid commit frame.`);
      }
      committed = true;
    } else {
      throw new Error(`Install journal ${path} contains an unsupported phase.`);
    }
  }
  return Object.freeze({
    path,
    identity: file.identity,
    header,
    stages,
    reservationIntents,
    reservations,
    restoreAttempts,
    prepared,
    committed,
  });
}

function parseJournalHeader(
  value: unknown,
  expectedHome: string,
  expectedHomeIdentity: FileIdentity,
): JournalHeader {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
      "home",
      "homeIdentity",
      "source",
      "plans",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "mono-agent.composer-skill-install"
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
    || value.home !== expectedHome
  ) {
    throw new Error("Install journal has an invalid header.");
  }
  const homeIdentity = parseIdentity(value.homeIdentity, "journal home identity");
  if (!sameFileIdentity(homeIdentity, expectedHomeIdentity)) {
    throw new Error("Install journal home authority does not match.");
  }
  const source = parseSourceDescriptors(value.source, "Install journal source");
  if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 2) {
    throw new Error("Install journal has an invalid target plan count.");
  }
  const seen = new Set<string>();
  const plans = value.plans.map((entry): JournalPlan => {
    if (!isRecord(entry)) throw new Error("Install journal contains an invalid target plan.");
    const baseKeys = [
      "target",
      "productRoot",
      "productIdentity",
      "parent",
      "parentIdentity",
      "destination",
      "stage",
    ] as const;
    const hasPrior = entry.priorIdentity !== undefined || entry.backup !== undefined;
    if (!hasExactKeys(
      entry,
      hasPrior ? [...baseKeys, "backup", "priorIdentity"] : baseKeys,
    )) {
      throw new Error("Install journal contains an invalid target plan shape.");
    }
    const target = journalTarget(entry.target);
    if (seen.has(target)) throw new Error("Install journal repeats a target plan.");
    seen.add(target);
    const productRoot = join(expectedHome, target === "claude" ? ".claude" : ".codex");
    const parent = join(productRoot, "skills");
    const destination = join(parent, SKILL_NAME);
    const stage = join(parent, `.${SKILL_NAME}.stage-${value.nonce}-${target}`);
    if (
      entry.productRoot !== productRoot
      || entry.parent !== parent
      || entry.destination !== destination
      || entry.stage !== stage
    ) {
      throw new Error("Install journal target paths escape their authority.");
    }
    const priorIdentity = entry.priorIdentity === undefined
      ? undefined
      : parseIdentity(entry.priorIdentity, "journal prior identity");
    const backup = priorIdentity === undefined
      ? undefined
      : join(parent, `.${SKILL_NAME}.backup-${value.nonce}-${target}`);
    if (entry.backup !== backup) {
      throw new Error("Install journal backup path does not match its authority.");
    }
    return Object.freeze({
      target,
      productRoot,
      productIdentity: parseIdentity(entry.productIdentity, "journal product identity"),
      parent,
      parentIdentity: parseIdentity(entry.parentIdentity, "journal parent identity"),
      destination,
      stage,
      ...(backup === undefined ? {} : { backup }),
      ...(priorIdentity === undefined ? {} : { priorIdentity }),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.composer-skill-install",
    nonce: value.nonce,
    ownerPid: value.ownerPid as number,
    home: expectedHome,
    homeIdentity,
    source,
    plans: Object.freeze(plans),
  });
}

async function assertJournalAuthority(
  header: JournalHeader,
  plan: JournalPlan,
): Promise<void> {
  await assertDirectoryIdentity(
    header.home,
    header.homeIdentity,
    "home directory",
    "authority",
  );
  await assertDirectoryIdentity(
    plan.productRoot,
    plan.productIdentity,
    `${plan.target} directory`,
    "authority",
  );
  await assertDirectoryIdentity(
    plan.parent,
    plan.parentIdentity,
    `${plan.target} skills directory`,
    "authority",
  );
}

async function archiveJournal(
  state: JournalState,
  home: string,
  disposition: string,
): Promise<string> {
  return archiveExactFile(
    state.path,
    state.identity,
    home,
    `.${SKILL_NAME}.journal-${disposition}-${state.header.nonce}`,
    "install journal",
  );
}

function journalTarget(value: unknown): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error("Install journal target is invalid.");
}

function journalRecoveryError(
  state: JournalState,
  plan: JournalPlan,
  message: string,
): Error {
  return new Error(
    `${message}; journal=${state.path}; destination=${plan.destination}; stage=${plan.stage}; backup=${plan.backup ?? "none"}.`,
  );
}
