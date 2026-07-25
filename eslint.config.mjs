// SPDX-License-Identifier: MIT
import tseslint from "typescript-eslint";

// Five typed rules, all errors, nothing stylistic.
//
// This is not a style linter and must not become one. `tsc` already runs with
// every strictness flag the repository can hold, `check:oss-hygiene` covers
// house rules, and `check:source-line-length` covers width. What none of them
// can see is a promise nobody waited for -- and that is the mechanism behind
// the defect class this repository keeps producing: a function returns before
// its work settles, the caller reports success, and the failure lands in an
// unhandled rejection nobody reads. Four confirmed fake-success states, and the
// two of them that were *shape* rather than logic (#120's swallowed settlement,
// the operator listener leak) are exactly what `no-floating-promises` and
// `no-misused-promises` see.
//
// Typed rules need type information, so this runs after `build`: the resolver
// follows cross-package imports through `dist/*.d.ts`.
//
// Every rule here is "error". A warning in a repository whose CI does not read
// warnings is a comment with extra steps.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.stryker-tmp/**",
      "**/reports/**",
      "website/**",
      "packages/web/webapp/dist/**",
    ],
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "extras/*/src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody awaited is a result nobody checked.
      "@typescript-eslint/no-floating-promises": "error",
      // An async callback passed where a sync one is expected: the caller
      // returns immediately, and the rejection has nowhere to go.
      "@typescript-eslint/no-misused-promises": "error",
      // `await` on a non-promise usually means the awaited thing changed shape
      // and the call site did not.
      "@typescript-eslint/await-thenable": "error",
      // `return-await` is deliberately absent. Its bug-catching half -- a
      // missing `await` inside `try`, where the rejection escapes the `catch`
      // written to handle it -- reported zero findings here; the codebase
      // already gets that right. Its other half flagged 71 sites of `return
      // await` outside try/catch, which is a preference, and removing them
      // would drop async stack frames and make failures harder to read. A rule
      // whose only live output is churn is not worth a CI step.
      //
      // `catch (error) { throw error }` reads as handling and handles nothing.
      // Core ESLint rule, not a typed one, but it belongs with this set.
      "no-useless-catch": "error",
    },
  },
);
