import { describe, expect, it } from "vitest";

import {
  evaluateWebappDependencyLicenses,
} from "../check-webapp-dependency-licenses.mjs";

const manifest = {
  license: "GPL-3.0-only",
  dependencies: {
    "@base-ui/react": "1.6.0",
    cmdk: "1.1.1",
  },
};

describe("webapp production dependency license gate", () => {
  it("accepts a complete reviewed permissive production graph", () => {
    expect(evaluateWebappDependencyLicenses({
      MIT: [{ name: "@base-ui/react", versions: ["1.6.0"] }],
      ISC: [{ name: "cmdk", versions: ["1.1.1"] }],
    }, manifest)).toEqual({ issues: [], packageCount: 2 });
  });

  it("fails closed on unreviewed licenses and omitted direct dependencies", () => {
    const result = evaluateWebappDependencyLicenses({
      "AGPL-3.0-only": [{ name: "@base-ui/react", versions: ["1.6.0"] }],
    }, manifest);

    expect(result.issues).toEqual([
      "production dependency missing from license report: cmdk",
      "unreviewed production license: AGPL-3.0-only",
    ]);
  });
});
