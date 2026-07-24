import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cleanupSkillPaths = [
  "skills/worktree-feature/SKILL.md",
  "skills/repo-hygiene-gc/SKILL.md",
];
const successorRepository = "robertsreberski/mono-agent-next";
const predecessorRepository = "robertsreberski/mono-agent";
const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repository hygiene skill contracts", () => {
  it("keeps implementer base comparisons pinned to one immutable SHA", async () => {
    const paths = [
      "agents/implementer.md",
      "agents/implementer.toml",
    ];
    const templates = await Promise.all(paths.map((path) => readFile(path, "utf8")));

    for (const template of templates) {
      expect(template).toContain("BASE_SHA");
      expect(template).toContain("origin/main");
      expect(template).toMatch(/exact (?:detached )?SHA|exact SHA|exact immutable BASE_SHA/iu);
      expect(template).not.toMatch(/git worktree add[^\n]*origin\/main/iu);
    }
  });

  it("keeps live-smoke guidance bounded and explicit about uncovered boundaries", async () => {
    const operatorPaths = [
      "agents/live-smoke-operator.md",
      "agents/live-smoke-operator.toml",
    ];
    const operatorTemplates = await Promise.all(
      operatorPaths.map((path) => readFile(path, "utf8")),
    );
    const [liveSmoke, verifyGreen, agents] = await Promise.all([
      readFile("skills/live-smoke/SKILL.md", "utf8"),
      readFile("skills/verify-green/SKILL.md", "utf8"),
      readFile("AGENTS.md", "utf8"),
    ]);

    for (const template of operatorTemplates) {
      expect(template).toMatch(/uncovered boundary/iu);
      expect(template).toContain("SUBSTITUTED");
      expect(template).not.toContain("/tmp/mono-agent-smoke");
      expect(template).not.toContain("start.log");
      expect(template).not.toContain("SMOKE=$(mktemp");
    }
    expect(liveSmoke).toContain("E. Focused-proof substitution");
    expect(verifyGreen).toMatch(/focused-proof substitution/iu);
    expect(agents).toMatch(/matching .*scenario when one exists/iu);
  });

  it("resolves each Pi package from its direct workspace owner", async () => {
    const skill = await readFile("skills/pi-upstream-recon/SKILL.md", "utf8");

    expect(skill).toContain("pnpm --filter @mono-agent/runtime-pi exec node");
    expect(skill).toContain("pnpm --filter @mono-agent/tui exec node");
    expect(skill).toContain('import.meta.resolve(name)');
    expect(skill).toContain("npm view @earendil-works/pi-coding-agent@latest");
    expect(skill).not.toContain("rg --files --hidden --no-ignore node_modules/.pnpm");
  });

  it("keeps both cleanup recipes identical and documents compare-and-delete gates", async () => {
    const [worktreeSkill, hygieneSkill] = await Promise.all(
      cleanupSkillPaths.map((path) => readFile(path, "utf8")),
    );

    const worktreeIdentity = extractMarkedBash(worktreeSkill, "github-origin-identity");
    const hygieneIdentity = extractMarkedBash(hygieneSkill, "github-origin-identity");
    const worktreeRecipe = extractMarkedBash(worktreeSkill, "merged-worktree-cleanup");
    const hygieneRecipe = extractMarkedBash(hygieneSkill, "merged-worktree-cleanup");
    expect(worktreeIdentity).toBe(hygieneIdentity);
    expect(worktreeRecipe).toBe(hygieneRecipe);
    expect(worktreeRecipe).not.toContain("git branch -D");
    expect(worktreeRecipe).not.toContain('local repo="$1"');
    expect(hygieneSkill).toContain(
      'gh api --hostname github.com "repos/$repo" --jq .delete_branch_on_merge',
    );

    for (const skill of [worktreeSkill, hygieneSkill]) {
      expect(skill).not.toMatch(
        /robertsreberski\/mono-agent(?=\.git(?:["'`\s]|$)|["'`\s]|$)/u,
      );
      expect(skill).not.toContain("worktrees/mono-agent/");
    }
  });

  for (const skillPath of cleanupSkillPaths) {
    describe(skillPath, () => {
      it("removes only the matching merged PR's exact clean worktree and branch", async () => {
        const fixture = await createFixture();

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture));

        expect(result.status, commandFailure(result)).toBe(0);
        expect(existsSync(fixture.worktree)).toBe(false);
        expect(branchOid(fixture.repo, fixture.branch)).toBeNull();
      });

      it("does not remove a clean worktree attached to another branch", async () => {
        const fixture = await createFixture();
        const active = await addWorktree(fixture, "fix/active-work", "active-worktree");

        const result = await executeCleanupRecipe(
          skillPath,
          { ...fixture, worktree: active.worktree },
          mergedEvidence(fixture),
        );

        expect(result.status).not.toBe(0);
        expect(existsSync(active.worktree)).toBe(true);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, active.branch)).toBe(active.head);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("does not remove an exact branch/head predecessor worktree", async () => {
        const fixture = await createFixture();
        const predecessorWorktree = await addPredecessorWorktreeAtReviewedHead(fixture);

        const result = await executeCleanupRecipe(
          skillPath,
          { ...fixture, worktree: predecessorWorktree },
          mergedEvidence(fixture),
          { cwd: fixture.worktree },
        );

        expect(result.status).not.toBe(0);
        expect(existsSync(predecessorWorktree)).toBe(true);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("fails closed when successor fetch origin has a predecessor push target", async () => {
        const fixture = await createFixture();
        git(fixture.repo, [
          "remote",
          "set-url",
          "--push",
          "origin",
          `git@github.com:${predecessorRepository}.git`,
        ]);

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture));

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("fails closed when GitHub returns the predecessor for the successor origin", async () => {
        const fixture = await createFixture();

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture), {
          apiRepository: predecessorRepository,
        });

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("does not accept a predecessor PR URL in place of the numeric PR", async () => {
        const fixture = await createFixture();

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture), {
          prNumber: `https://github.com/${predecessorRepository}/pull/123`,
        });

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("does not remove a dirty matching worktree", async () => {
        const fixture = await createFixture();
        await writeFile(join(fixture.worktree, "uncommitted.txt"), "preserve me\n", "utf8");

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture));

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(existsSync(join(fixture.worktree, "uncommitted.txt"))).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it.each([
        ["open PR", { state: "OPEN", mergedAt: "" }],
        ["closed-unmerged PR", { state: "CLOSED", mergedAt: "" }],
        ["wrong branch name", { branch: "fix/a-different-branch" }],
        ["wrong reviewed head", { head: "base" }],
      ])("does not mutate for %s evidence", async (_label, evidenceOverride) => {
        const fixture = await createFixture();
        const evidence = mergedEvidence(fixture, {
          ...evidenceOverride,
          head: evidenceOverride.head === "base" ? fixture.base : evidenceOverride.head,
        });

        const result = await executeCleanupRecipe(skillPath, fixture, evidence);

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(fixture.head);
      });

      it("preserves a ref that advances after proof instead of deleting it", async () => {
        const fixture = await createFixture();
        const advancedHead = commitObject(fixture.repo, fixture.head, "advanced after proof");

        const result = await executeCleanupRecipe(skillPath, fixture, mergedEvidence(fixture), {
          race: { advancedHead },
        });

        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.worktree)).toBe(false);
        expect(branchOid(fixture.repo, fixture.branch)).toBe(advancedHead);
      });
    });
  }

  describe("historical remote cleanup", () => {
    it("deletes a remote branch only when its head still equals the reviewed OID", async () => {
      const fixture = await createFixture();
      const remote = attachBareOrigin(fixture);

      const result = await executeRemoteDeleteRecipe(fixture, fixture.head, remote);

      expect(result.status, commandFailure(result)).toBe(0);
      expect(bareBranchOid(remote, fixture.branch)).toBeNull();
    });

    it("preserves a remote branch that advances beyond the reviewed OID", async () => {
      const fixture = await createFixture();
      const remote = attachBareOrigin(fixture);
      const advancedHead = commitObject(fixture.repo, fixture.head, "advanced remote head");
      git(fixture.repo, [
        "push",
        remote,
        `${advancedHead}:refs/heads/${fixture.branch}`,
      ]);

      const result = await executeRemoteDeleteRecipe(fixture, fixture.head, remote);

      expect(result.status).not.toBe(0);
      expect(bareBranchOid(remote, fixture.branch)).toBe(advancedHead);
    });

    it("preserves the remote when successor fetch origin has a predecessor push target", async () => {
      const fixture = await createFixture();
      const remote = attachBareOrigin(fixture);
      git(fixture.repo, [
        "remote",
        "set-url",
        "--push",
        "origin",
        `git@github.com:${predecessorRepository}.git`,
      ]);

      const result = await executeRemoteDeleteRecipe(fixture, fixture.head, remote);

      expect(result.status).not.toBe(0);
      expect(bareBranchOid(remote, fixture.branch)).toBe(fixture.head);
    });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-repo-hygiene-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const worktree = join(root, "feature-worktree");
  const branch = "fix/reviewed-cleanup";

  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mono Agent Test"]);
  git(repo, ["config", "user.email", "mono-agent-test@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]);
  git(repo, ["remote", "add", "origin", `git@github.com:${successorRepository}.git`]);
  await writeFile(join(repo, "tracked.txt"), "base\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  git(repo, ["branch", branch]);
  git(repo, ["worktree", "add", worktree, branch]);
  await writeFile(join(worktree, "feature.txt"), "feature\n", "utf8");
  git(worktree, ["add", "feature.txt"]);
  git(worktree, ["commit", "-m", "feature"]);
  const head = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();

  return { root, repo, worktree, branch, base, head };
}

async function addWorktree(fixture, branch, directoryName) {
  const worktree = join(fixture.root, directoryName);
  git(fixture.repo, ["branch", branch, "main"]);
  git(fixture.repo, ["worktree", "add", worktree, branch]);
  await writeFile(join(worktree, "active.txt"), `${branch}\n`, "utf8");
  git(worktree, ["add", "active.txt"]);
  git(worktree, ["commit", "-m", `work on ${branch}`]);
  return {
    branch,
    worktree,
    head: git(worktree, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}

async function addPredecessorWorktreeAtReviewedHead(fixture) {
  const predecessorRepo = join(fixture.root, "predecessor-repo");
  const predecessorWorktree = join(
    fixture.root,
    "superpowers",
    "worktrees",
    "mono-agent",
    "reviewed-worktree",
  );
  command(realGit, ["clone", "--quiet", fixture.repo, predecessorRepo]);
  git(predecessorRepo, [
    "remote",
    "set-url",
    "origin",
    `git@github.com:${predecessorRepository}.git`,
  ]);
  git(predecessorRepo, ["branch", fixture.branch, fixture.head]);
  await mkdir(join(fixture.root, "superpowers", "worktrees", "mono-agent"), {
    recursive: true,
  });
  git(predecessorRepo, ["worktree", "add", predecessorWorktree, fixture.branch]);
  return predecessorWorktree;
}

function mergedEvidence(fixture, overrides = {}) {
  return {
    state: "MERGED",
    mergedAt: "2026-07-16T00:00:00Z",
    branch: fixture.branch,
    head: fixture.head,
    ...overrides,
  };
}

async function executeCleanupRecipe(skillPath, fixture, evidence, options = {}) {
  const skill = await readFile(skillPath, "utf8");
  const identityRecipe = extractMarkedBash(skill, "github-origin-identity");
  const recipe = extractMarkedBash(skill, "merged-worktree-cleanup");
  const bin = await installMockCommands(fixture.root);
  const race = options.race;

  return command(
    "/bin/bash",
    [
      "-c",
      [
        "set -u",
        identityRecipe,
        recipe,
        'cleanup_merged_worktree "$PR_NUMBER" "$BRANCH" "$WORKTREE"',
      ].join("\n"),
    ],
    {
      allowFailure: true,
      cwd: options.cwd ?? fixture.worktree,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        PR_NUMBER: options.prNumber ?? "123",
        BRANCH: fixture.branch,
        WORKTREE: fixture.worktree,
        EXPECTED_GITHUB_REPO: successorRepository,
        MOCK_API_REPO: options.apiRepository ?? successorRepository,
        MOCK_PR_STATE: evidence.state,
        MOCK_PR_MERGED_AT: evidence.mergedAt,
        MOCK_PR_BRANCH: evidence.branch,
        MOCK_PR_HEAD: evidence.head,
        RACE_ON_REMOVE: race ? "1" : "0",
        RACE_REPO: fixture.repo,
        RACE_BRANCH: fixture.branch,
        RACE_OLD_HEAD: fixture.head,
        RACE_NEW_HEAD: race?.advancedHead ?? fixture.head,
      },
    },
  );
}

async function executeRemoteDeleteRecipe(fixture, reviewedHead, remote) {
  const skill = await readFile("skills/repo-hygiene-gc/SKILL.md", "utf8");
  const identityRecipe = extractMarkedBash(skill, "github-origin-identity");
  const recipe = extractMarkedBash(skill, "remote-branch-compare-delete");
  const bin = await installMockCommands(fixture.root);
  return command(
    "/bin/bash",
    [
      "-c",
      [
        "set -u",
        identityRecipe,
        recipe,
        'delete_remote_branch_at_head "$BRANCH" "$API_HEAD"',
      ].join("\n"),
    ],
    {
      allowFailure: true,
      cwd: fixture.repo,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        EXPECTED_GITHUB_REPO: successorRepository,
        MOCK_API_REPO: successorRepository,
        MOCK_PR_STATE: "MERGED",
        MOCK_PR_MERGED_AT: "2026-07-16T00:00:00Z",
        MOCK_PR_BRANCH: fixture.branch,
        MOCK_PR_HEAD: reviewedHead,
        RACE_ON_REMOVE: "0",
        REDIRECT_ORIGIN_PUSH: remote,
        EXPECTED_PUSH_URL: `git@github.com:${successorRepository}.git`,
        BRANCH: fixture.branch,
        API_HEAD: reviewedHead,
      },
    },
  );
}

async function installMockCommands(root) {
  const bin = join(root, "mock-bin");
  await mkdir(bin, { recursive: true });
  const ghPath = join(bin, "gh");
  const gitPath = join(bin, "git");

  await writeFile(
    ghPath,
    `#!/bin/sh
set -u
case "$1 $2" in
  "api --hostname")
    test "$3" = "github.com"
    test "$4" = "repos/$EXPECTED_GITHUB_REPO"
    test "$5" = "--jq"
    test "$6" = ".full_name"
    printf '%s\\n' "$MOCK_API_REPO"
    ;;
  "pr view")
    test "$4" = "--repo"
    test "$5" = "github.com/$EXPECTED_GITHUB_REPO"
    test "$6" = "--json"
    test "$7" = "state,mergedAt,headRefName,headRefOid"
    test "$8" = "--jq"
    if test "$MOCK_PR_STATE" = "MERGED" && test -n "$MOCK_PR_MERGED_AT" && test "$MOCK_PR_MERGED_AT" != "null"; then
      printf '%s %s\\n' "$MOCK_PR_BRANCH" "$MOCK_PR_HEAD"
    fi
    ;;
  *)
    exit 1
    ;;
esac
`,
    "utf8",
  );
  await writeFile(
    gitPath,
    `#!/bin/sh
if test "\${RACE_ON_REMOVE:-0}" = "1"; then
  case " $* " in
    *" worktree remove "*)
      "$REAL_GIT" "$@"
      status=$?
      test "$status" -eq 0 || exit "$status"
      "$REAL_GIT" -C "$RACE_REPO" update-ref "refs/heads/$RACE_BRANCH" "$RACE_NEW_HEAD" "$RACE_OLD_HEAD"
      exit $?
      ;;
  esac
fi
if test -n "\${REDIRECT_ORIGIN_PUSH:-}" && test "\${1:-}" = "push"; then
  test "\${3:-}" = "$EXPECTED_PUSH_URL" || exit 1
  exec "$REAL_GIT" push "$2" "$REDIRECT_ORIGIN_PUSH" "$4"
fi
exec "$REAL_GIT" "$@"
`,
    "utf8",
  );
  await Promise.all([chmod(ghPath, 0o755), chmod(gitPath, 0o755)]);
  return bin;
}

function attachBareOrigin(fixture) {
  const remote = join(fixture.root, "origin.git");
  command(realGit, ["clone", "--bare", "--quiet", fixture.repo, remote]);
  return remote;
}

function commitObject(repo, parent, message) {
  const tree = git(repo, ["rev-parse", `${parent}^{tree}`]).stdout.trim();
  return git(repo, ["commit-tree", tree, "-p", parent, "-m", message]).stdout.trim();
}

function branchOid(repo, branch) {
  const result = command(
    realGit,
    ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function bareBranchOid(remote, branch) {
  const result = command(
    realGit,
    ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function git(cwd, args, options = {}) {
  return command(realGit, ["-C", cwd, ...args], options);
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(commandFailure(result, executable, args));
  }
  return result;
}

function commandFailure(result, executable = "command", args = []) {
  return [
    `${executable} ${args.join(" ")} exited ${result.status}`,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractMarkedBash(markdown, marker) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Missing or invalid ${marker} recipe markers`);
  }
  const fenced = markdown.slice(startIndex + start.length, endIndex).trim();
  const match = /^```bash\n([\s\S]+)\n```$/u.exec(fenced);
  if (!match) {
    throw new Error(`The ${marker} recipe must contain one bash fence`);
  }
  return match[1];
}
