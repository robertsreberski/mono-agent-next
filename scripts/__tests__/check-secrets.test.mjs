// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { runCheckSecrets } from "../check-secrets.mjs";

describe("check-secrets", () => {
  it("runs gitleaks with redacted output against the current tree", async () => {
    const calls = [];
    const stdout = sink();
    const stderr = sink();

    const result = await runCheckSecrets({
      cwd: "/repo",
      stdout,
      stderr,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0, stdout: "clean\n", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "gitleaks",
        args: ["dir", "--redact", "--no-banner", "--config", ".gitleaks.toml", "."],
        cwd: "/repo",
      },
    ]);
    expect(stdout.text).toBe("clean\n");
    expect(stderr.text).toBe("");
  });

  it("prints an install hint when gitleaks is missing", async () => {
    const stdout = sink();
    const stderr = sink();

    const result = await runCheckSecrets({
      cwd: "/repo",
      stdout,
      stderr,
      runCommand: async () => ({
        status: 127,
        stdout: "",
        stderr: "spawn gitleaks ENOENT",
      }),
    });

    expect(result.exitCode).toBe(127);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("gitleaks is required");
    expect(stderr.text).toContain("brew install gitleaks");
  });
});

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
