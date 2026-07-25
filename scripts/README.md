# Repository scripts

Every runnable script lives in the directory named for what it does. The
directory carries the verb, so the filename carries only the subject:
`scripts/check/docs.mjs`, not `scripts/check-docs.mjs`.

| Directory | Holds | Invoked as |
| --- | --- | --- |
| `check/` | Assertions about the repository that exit non-zero when violated | `pnpm run check:*`, and `preinstall` |
| `generate/` | Writers of checked-in generated documentation | `pnpm run generate:*` |
| `verify/` | End-to-end proofs that build, install, and run the product | `pnpm run verify:*` |
| `measure/` | Reporters that quantify the tree and, with `--enforce`, floor it | `pnpm run report:source-beta`, `pnpm run mutate` |
| `release/` | The lockstep release pipeline and its fixtures | `pnpm run release:*` |
| `lib/` | Modules other scripts import; nothing here is run directly | — |
| `fixtures/` | Static inputs for the above | — |
| `__tests__/` | Tests for all of it, run by `pnpm run scripts:test` | — |

Two rules keep that true, both asserted by
`scripts/__tests__/gate-coverage.test.mjs`:

1. **Every `.mjs` in `check/`, `generate/`, `verify/` or `measure/` is named by
   a `package.json` script.** If nothing runs it, it is not an entrypoint and
   belongs in `lib/`.
2. **`scripts/` itself contains no `.mjs` at all.** A file dropped at the top
   level would otherwise be invisible to the first rule.

`gate-coverage.test.mjs` also asserts that every gate in
`scripts/verify/all.mjs` either runs in `.github/workflows/ci.yml` or is listed
with a predicate proving where else it runs. A gate that is not itself executed
by a gate is not a gate.

## Adding one

Put it in the directory that matches the verb, name it for its subject, and add
the `package.json` script that runs it in the same change — the tests above fail
otherwise. If it is a module rather than a command, it belongs in `lib/`, and
nothing needs to invoke it.
