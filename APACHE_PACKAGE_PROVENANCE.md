# Apache package provenance and authority

This is the reviewed human-readable authority record for the two Apache-2.0
extension surfaces, `packages/module-sdk` and `packages/operator`. The
machine-readable file-level record is
[`licensing/apache-package-provenance.json`](./licensing/apache-package-provenance.json).
It records the SHA-256, origin classification, source commit and path where
applicable, copyright holder, and authority basis for every Git-tracked file in
both package trees.

## Authority declaration

Robert Sreberski is the repository owner and the sole copyright holder of the
identified predecessor material and successor-original work in this report.
Robert Sreberski explicitly authorizes the predecessor material identified
below to be adapted into the named successor files and distributed under the
Apache License 2.0. Merging this record into the owner-controlled successor
repository records that authorization durably.

This authorization is intentionally narrow. It covers only the predecessor
sources and successor targets named in the machine-readable record. It does
not claim authority over third-party code, and Git authorship alone is not used
to invent third-party permission. Future contributions remain subject to the
repository's explicit inbound contribution terms.

## Audited classifications

The current record covers 35 tracked files exactly:

| Classification | Files | Authority |
| --- | ---: | --- |
| Successor-original | 26 | Robert Sreberski's original work, expressly offered under Apache-2.0 |
| Predecessor-authorized adaptation | 7 | Robert Sreberski's sole-holder relicensing authorization above |
| Canonical license text | 2 | Verbatim Apache License 2.0 text published by the Apache Software Foundation for inclusion |

The predecessor source snapshot is commit
`79140866712145cb5cc3e2b742445db4fb1b4df8`. The copied or adapted metadata
is recorded rather than being misclassified as newly authored:

| Successor file | Audited predecessor source |
| --- | --- |
| `packages/module-sdk/package.json` | `packages/agent-contracts/package.json` |
| `packages/module-sdk/tsconfig.build.json` | `demos/final-agent/tsconfig.build.json` |
| `packages/module-sdk/tsconfig.json` | `demos/final-agent/tsconfig.json` |
| `packages/operator/package.json` | `packages/agent-contracts/package.json` |
| `packages/operator/tsconfig.build.json` | `packages/openai-api-adapter/tsconfig.build.json` |
| `packages/operator/tsconfig.json` | `extras/a2a-adapter/tsconfig.json` |

`packages/operator/src/client.ts` materially descends from the GPL predecessor
client at `packages/web/src/operator-client.ts`; it is not represented as an
independent reimplementation. Its complete material predecessor history is:

| Commit | Predecessor change |
| --- | --- |
| `92ddcdaa915d8586bff96636169717bf91a7d1dc` | Initial always-on web operator client |
| `8450daa4fc56c7cadacf2fa0842ecbaae7fd3069` | Notification and history behavior |
| `7c89e063491de78959bf9baf0e7f974cc7801141` | AskUser behavior |
| `b87f154b42b8a975c1d7966f851b7f29e2cd6962` | Live-input behavior |

The predecessor shortlog for that path names only Robert Sreberski. The
metadata source paths likewise name only Robert Sreberski (including the
`robertsreberski` spelling with the same email identity). That sole-holder
finding, together with the explicit authorization above, is the authority for
the Apache successor adaptation.

## Machine gate

Run:

```sh
node scripts/check-apache-provenance.mjs
```

The gate fails closed when:

- a tracked file is missing from the record, including an exact one-file
  increase;
- a record names a path that Git no longer tracks;
- a non-ignored untracked file exists inside either Apache package tree;
- current bytes do not match the recorded SHA-256;
- a scoped path is a symlink or another non-regular file;
- authority fields, origin classifications, predecessor hashes, or the
  operator-client material history are missing or changed;
- a successor-original source commit and path do not resolve in the public
  successor history.

Adding or changing a file in either Apache package therefore requires an
explicit provenance-record change. A new predecessor adaptation also requires
a reviewed policy update in the checker; changing only descriptive JSON cannot
downgrade known GPL-derived material to "original."
