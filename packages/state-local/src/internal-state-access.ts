// SPDX-License-Identifier: MIT
import type {
  StateStore,
} from "@mono-agent/module-sdk/internal";

const stateLocalInternalAccessorBrand: unique symbol =
  Symbol("state-local.internal-accessor-brand");

export type StateLocalInternalAccessor = Pick<
  StateStore,
  "read" | "scan" | "transaction" | "putArtifact" | "readArtifact" | "deleteArtifact"
> & {
  readonly [stateLocalInternalAccessorBrand]: true;
};

export const stateLocalInternalAccess: unique symbol = Symbol("state-local.internal-access");

export function createStateLocalInternalAccessor(
  accessor: Pick<
    StateStore,
    "read" | "scan" | "transaction" | "putArtifact" | "readArtifact" | "deleteArtifact"
  >,
): StateLocalInternalAccessor {
  return Object.freeze({
    ...accessor,
    [stateLocalInternalAccessorBrand]: true as const,
  });
}

export interface StateLocalInternalAccessHost {
  readonly [stateLocalInternalAccess]: StateLocalInternalAccessor;
}
