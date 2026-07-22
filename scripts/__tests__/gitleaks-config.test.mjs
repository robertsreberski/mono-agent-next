import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const configPath = join(repositoryRoot, ".gitleaks.toml");
const fixturePath = join(
  repositoryRoot,
  "scripts/fixtures/gitleaks/telegram-token-cases.json",
);
const temporaryDirectories = [];
const hasGitleaks = spawnSync("gitleaks", ["version"], {
  encoding: "utf8",
}).status === 0;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Telegram token gitleaks rule", () => {
  it("matches only the exact documented token shape", async () => {
    const { config, fixture, fixtureSource } = await readInputs();
    const rule = readRule(config, "telegram-bot-token");
    const pattern = new RegExp(rule.regex, "u");

    expect(rule.secretGroup).toBe(1);

    for (const testCase of fixture.detected) {
      expect(
        pattern.test(JSON.stringify({ candidate: materialize(testCase) })),
        `${testCase.name} should match`,
      ).toBe(true);
    }

    for (const testCase of fixture.ignored) {
      expect(
        pattern.test(JSON.stringify({ candidate: materialize(testCase) })),
        `${testCase.name} should not match`,
      ).toBe(false);
    }

    for (const testCase of [...fixture.detected, ...fixture.ignored]) {
      expect(fixtureSource).not.toContain(materializeToken(testCase));
      expect(fixtureSource).not.toContain(materialize(testCase));
    }
  });

  it("kills restrictive and permissive token-shape mutations", async () => {
    const { config, fixture } = await readInputs();
    const rule = readRule(config, "telegram-bot-token");
    const mutations = [
      {
        name: "uppercase-only credential tail",
        regex: replaceExactlyOnce(
          rule.regex,
          "[A-Za-z0-9_-]{35}",
          "[A-Z_-]{35}",
        ),
        mismatches: [
          "six-digit identifier with every URL-safe tail class",
        ],
      },
      {
        name: "alphanumeric identifier",
        regex: replaceExactlyOnce(
          rule.regex,
          "[0-9]{6,10}",
          "[A-Za-z0-9]{6,10}",
        ),
        mismatches: ["non-numeric identifier"],
      },
      {
        name: "standard Base64 punctuation in credential tail",
        regex: replaceExactlyOnce(
          rule.regex,
          "[A-Za-z0-9_-]{35}",
          "[A-Za-z0-9_+/=-]{35}",
        ),
        mismatches: [
          "35-character credential tail containing plus",
          "35-character credential tail containing slash",
          "35-character credential tail containing equals",
        ],
      },
    ];

    for (const mutation of mutations) {
      expect(
        shapeMismatches(new RegExp(mutation.regex, "u"), fixture),
        `${mutation.name} must be killed by the fixture matrix`,
      ).toEqual(mutation.mismatches);
    }
  });

  it.skipIf(!hasGitleaks)(
    "flags planted synthetic tokens without flagging near misses",
    async () => {
      const { fixture } = await readInputs();
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "mono-agent-gitleaks-telegram-"),
      );
      temporaryDirectories.push(temporaryDirectory);

      const detectedPath = join(temporaryDirectory, "detected.jsonl");
      const ignoredPath = join(temporaryDirectory, "ignored.jsonl");
      const reportPath = join(temporaryDirectory, "gitleaks-report.json");

      await writeFile(detectedPath, toJsonLines(fixture.detected), "utf8");
      await writeFile(ignoredPath, toJsonLines(fixture.ignored), "utf8");

      const result = spawnSync(
        "gitleaks",
        [
          "dir",
          "--redact",
          "--no-banner",
          "--config",
          configPath,
          "--report-format",
          "json",
          "--report-path",
          reportPath,
          "--exit-code",
          "17",
          temporaryDirectory,
        ],
        { encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(17);

      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report).toHaveLength(fixture.detected.length);
      expect(report.map((finding) => finding.RuleID)).toEqual(
        fixture.detected.map(() => "telegram-bot-token"),
      );
      expect(report.map((finding) => basename(finding.File))).toEqual(
        fixture.detected.map(() => "detected.jsonl"),
      );
      expect(report.map((finding) => finding.StartLine)).toEqual(
        fixture.detected.map((_, index) => index + 1),
      );
    },
  );
});

async function readInputs() {
  const [config, fixtureSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(fixturePath, "utf8"),
  ]);

  return {
    config,
    fixture: JSON.parse(fixtureSource),
    fixtureSource,
  };
}

function readRule(config, id) {
  const block = config
    .split("[[rules]]")
    .slice(1)
    .map((section) => section.split(/\n\[\[/u, 1)[0])
    .find((section) => new RegExp(`^\\s*id\\s*=\\s*"${id}"\\s*$`, "mu").test(section));

  if (!block) {
    throw new Error(`Missing [[rules]] block with id ${id}`);
  }

  const regex = /^\s*regex\s*=\s*'''([\s\S]*?)'''\s*$/mu.exec(block)?.[1];
  const secretGroup = /^\s*secretGroup\s*=\s*(\d+)\s*$/mu.exec(block)?.[1];

  if (!regex || secretGroup === undefined) {
    throw new Error(`Rule ${id} must define regex and secretGroup`);
  }

  return { regex, secretGroup: Number(secretGroup) };
}

function materialize(testCase) {
  return `${testCase.candidatePrefix ?? ""}${materializeToken(testCase)}${testCase.candidateSuffix ?? ""}`;
}

function materializeToken(testCase) {
  const { character, count, suffix } = testCase.tail;
  return `${testCase.id}:${character.repeat(count)}${suffix}`;
}

function shapeMismatches(pattern, fixture) {
  return [
    ...fixture.detected.map((testCase) => ({ expected: true, testCase })),
    ...fixture.ignored.map((testCase) => ({ expected: false, testCase })),
  ]
    .filter(({ expected, testCase }) =>
      pattern.test(JSON.stringify({ candidate: materialize(testCase) })) !== expected)
    .map(({ testCase }) => testCase.name);
}

function replaceExactlyOnce(source, search, replacement) {
  const firstIndex = source.indexOf(search);
  if (firstIndex === -1 || source.indexOf(search, firstIndex + search.length) !== -1) {
    throw new Error(`Expected exactly one ${search} fragment in the token rule`);
  }
  return source.replace(search, replacement);
}

function toJsonLines(testCases) {
  return `${testCases
    .map((testCase) => JSON.stringify({ candidate: materialize(testCase) }))
    .join("\n")}\n`;
}
