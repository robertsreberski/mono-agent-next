---
name: worktree-feature
description: Start isolated mono-agent work with diff-aware setup, keep only required dist fresh, and ship through a PR with safe cleanup. Use for tracked repository changes, multi-commit work, or before executing an implementation plan.
---

# Worktree feature workflow

Keep the normal non-bare `main` checkout as the clean integration checkout.
Never develop in, commit from, or `git stash` WIP in that checkout. All tracked
changes happen in isolated worktrees; `main` advances only to reviewed commits.
Live consumers remain on their current reviewed source until a separate
cutover is explicitly authorized.

Current practice keeps worktrees under a repository-specific directory below
`${XDG_CONFIG_HOME:-$HOME/.config}/superpowers/worktrees/`. Derive that
directory from the current checkout's verified GitHub `origin`; never copy a
repository name or a worktree path from another checkout.

Load this resolver before the commands below. It fails closed unless `origin`
has exactly one fetch URL and one push URL, both identify the same GitHub
repository, and GitHub returns that same canonical repository identity:

<!-- github-origin-identity:start -->
```bash
canonical_github_repo_from_url() {
  local url="$1"
  local path owner name

  case "$url" in
    git@github.com:*) path="${url#git@github.com:}" ;;
    ssh://git@github.com/*) path="${url#ssh://git@github.com/}" ;;
    https://github.com/*) path="${url#https://github.com/}" ;;
    *) return 1 ;;
  esac

  path="${path%.git}"
  owner="${path%%/*}"
  name="${path#*/}"
  test -n "$owner" || return 1
  test -n "$name" || return 1
  test "$name" != "$path" || return 1
  case "$name" in */*) return 1 ;; esac
  case "$owner" in *[!A-Za-z0-9_.-]*) return 1 ;; esac
  case "$name" in *[!A-Za-z0-9_.-]*) return 1 ;; esac

  printf '%s/%s\n' "$owner" "$name" | tr '[:upper:]' '[:lower:]'
}

verified_github_repo_from_common_dir() {
  local common_dir="$1"
  local fetch_urls push_urls fetch_repo push_repo api_repo

  test -d "$common_dir" || return 1
  fetch_urls="$(git --git-dir="$common_dir" remote get-url --all origin)" || return 1
  push_urls="$(git --git-dir="$common_dir" remote get-url --push --all origin)" || return 1
  test -n "$fetch_urls" || return 1
  test -n "$push_urls" || return 1
  case "$fetch_urls" in *$'\n'*) return 1 ;; esac
  case "$push_urls" in *$'\n'*) return 1 ;; esac

  fetch_repo="$(canonical_github_repo_from_url "$fetch_urls")" || return 1
  push_repo="$(canonical_github_repo_from_url "$push_urls")" || return 1
  test "$fetch_repo" = "$push_repo" || return 1

  api_repo="$(gh api --hostname github.com "repos/$fetch_repo" \
    --jq '.full_name')" || return 1
  api_repo="$(printf '%s' "$api_repo" | tr '[:upper:]' '[:lower:]')"
  test "$api_repo" = "$fetch_repo" || return 1
  printf '%s\n' "$fetch_repo"
}
```
<!-- github-origin-identity:end -->

## Create

```bash
cd "$(git rev-parse --show-toplevel)"
repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_common_dir="$(cd "$repo_common_dir" && pwd -P)"
repo="$(verified_github_repo_from_common_dir "$repo_common_dir")" || exit 1
repo_name="${repo#*/}"
worktree_parent="${XDG_CONFIG_HOME:-$HOME/.config}/superpowers/worktrees/$repo_name"
mkdir -p "$worktree_parent"
git fetch origin main
git worktree add "$worktree_parent/<name>" -b <branch> origin/main
# or branch from current work:
git worktree add "$worktree_parent/<name>" -b <branch> HEAD
```

Branch naming in this repo: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `worktree-<topic>`.

## First step — choose setup from the diff

Do not build the whole monorepo by default:

| Diff | Worktree preparation |
|---|---|
| Docs, skills, agent metadata, process files | No package build |
| One package or a narrow package boundary | Install dependencies if needed, then build that package's dependency closure |
| Cross-cutting package graph or build tooling | Install dependencies, then run the full dependency-ordered build |

```bash
cd "$worktree_parent/<name>"

# Only when dependencies are absent or manifests/lockfile changed:
pnpm install --frozen-lockfile

# Narrow package work:
pnpm --filter @mono-agent/<X>... run build

# Cross-cutting work only:
pnpm -r --sort run build
```

Cross-package TypeScript and tests resolve workspace imports through `dist/`.
After editing package X, rebuild it before checking a dependent. Intra-package
Vitest runs use `src` directly. A process-only diff does not exercise either
path and needs no dist baseline.

If cross-package resolution still appears stale, confirm the worktree's local
`dist/` and rebuild the affected dependency closure. Use a fresh worktree and
full ordered build only when the local outputs cannot be trusted.

## Website inside a worktree

`website/` is its own pnpm workspace. Install its dependencies inside the
feature worktree so the website gate cannot resolve through another checkout:

```bash
pnpm -C website install
```

## Ship

**Before shipping — new durable state?** If this PR adds a new on-disk store
under `.mono-agent/`, confirm an existing purge/reset/clear surface covers it
too, along with the relevant `doctor`/`validate` status and documentation
boundary. A durable store that nothing can clear and no current boundary doc
mentions is a merge blocker.

Verify with the `verify-green` skill first. Then:

```bash
git add -A && git commit -q -F - <<'EOF'
feat(<scope>): <summary>

<why + what, wrapped body paragraphs>
EOF
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<title>" --body "<body>"
gh pr checks <n> --watch --interval 30
```

Preserve the repository-configured author identity. Local identity policy, if
any, belongs outside the tracked public workflow.

**After merge (mandatory), not optional.** The instant the PR is merged, clean
up both sides. Do not trust `gh pr merge`'s exit status or commit ancestry as the
proof: squash merges create a new commit, so `git branch -d` correctly refuses
the original head. Query the exact PR and require its API state, branch name,
and head SHA to match before force-deleting that one local branch. The remote
branch self-deletes only when `delete_branch_on_merge` is on; see
`repo-hygiene-gc`.

Skipped per-feature cleanups are exactly how the repo regressed from 2 branches
/ 3 worktrees to 47 branches / 50 worktrees. Run the cleanup block under
*Compare against base / cleanup* below as part of finishing every merged PR.

## Compare against base / cleanup

Check whether a failure pre-exists on main without touching your tree:

```bash
git worktree add --detach /tmp/<name>-base-check <commit>
```

When merged, record the exact PR number, branch, and worktree. Run this
immediately from the feature worktree. The function fails closed unless the
supplied path is the root of a registered worktree in this repository, attached
to the API-proved branch at the API/local reviewed OID:

<!-- merged-worktree-cleanup:start -->
```bash
cleanup_merged_worktree() {
  local pr="$1"
  local branch="$2"
  local worktree="$3"
  local repo_common_dir repo proof api_branch api_head local_head
  local worktree_common_dir worktree_root supplied_worktree
  local worktree_branch worktree_head worktree_status

  case "$pr" in ""|*[!0-9]*) return 1 ;; esac
  test "$pr" -gt 0 || return 1
  git check-ref-format --branch "$branch" >/dev/null || return 1
  repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || return 1
  repo_common_dir="$(cd "$repo_common_dir" && pwd -P)" || return 1
  repo="$(verified_github_repo_from_common_dir "$repo_common_dir")" || return 1

  proof="$(gh pr view "$pr" --repo "github.com/$repo" \
    --json state,mergedAt,headRefName,headRefOid \
    --jq 'select(.state == "MERGED" and .mergedAt != null) | [.headRefName, .headRefOid] | join(" ")')" || return 1
  test -n "$proof" || return 1
  api_branch="${proof%% *}"
  api_head="${proof#* }"
  local_head="$(git --git-dir="$repo_common_dir" rev-parse --verify "refs/heads/$branch^{commit}")" || return 1

  worktree_common_dir="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)" || return 1
  worktree_common_dir="$(cd "$worktree_common_dir" && pwd -P)" || return 1
  worktree_root="$(git -C "$worktree" rev-parse --path-format=absolute --show-toplevel)" || return 1
  worktree_root="$(cd "$worktree_root" && pwd -P)" || return 1
  supplied_worktree="$(cd "$worktree" && pwd -P)" || return 1
  worktree_branch="$(git -C "$worktree" symbolic-ref --quiet --short HEAD)" || return 1
  worktree_head="$(git -C "$worktree" rev-parse --verify HEAD)" || return 1
  worktree_status="$(git -C "$worktree" status --porcelain)" || return 1

  test "$api_branch" = "$branch" || return 1
  test "$api_head" = "$local_head" || return 1
  test "$worktree_common_dir" = "$repo_common_dir" || return 1
  test "$worktree_root" = "$supplied_worktree" || return 1
  test "$worktree_branch" = "$api_branch" || return 1
  test "$worktree_head" = "$api_head" || return 1
  test -z "$worktree_status" || return 1

  cd "$repo_common_dir" || return 1
  git --git-dir="$repo_common_dir" worktree remove "$worktree" || return 1
  git --git-dir="$repo_common_dir" update-ref -d "refs/heads/$branch" "$api_head" || return 1
  git --git-dir="$repo_common_dir" worktree prune
}
```
<!-- merged-worktree-cleanup:end -->

```bash
cleanup_merged_worktree <number> <branch> "$worktree_parent/<name>"
```

Any failed proof or dirty worktree stops the cleanup. Investigate it; never add
`--force` to `git worktree remove`, and never weaken the repository, branch, or
HEAD checks. `git update-ref -d <ref> <old-oid>` is an atomic compare-and-delete:
if the local branch advances after proof, deletion fails and the advanced ref is
preserved.

For a periodic *bulk* sweep of accumulated merged branches/worktrees (not just
this one), use the `repo-hygiene-gc` skill.
