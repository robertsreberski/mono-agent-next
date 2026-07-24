---
name: repo-hygiene-gc
description: Explicit bulk branch/worktree garbage collection using API-bound deletion proof. Use when asked to clean up the repository or run a deliberate maintenance sweep; ordinary PR cleanup belongs to worktree-feature.
---

# Repo hygiene GC

The clean `main` integration checkout stays in place; this GC never removes the
primary worktree or changes any consumer source. Feature work uses branches and
worktrees under a repository-specific directory below
`${XDG_CONFIG_HOME:-$HOME/.config}/superpowers/worktrees/` (see
`worktree-feature`).
Per-PR cleanup prevents new residue. This skill handles an explicitly requested
historical sweep; never start it merely because another task finished.

Load this resolver before any inspection or deletion below. It fails closed
unless `origin` has exactly one fetch URL and one push URL, both identify the
same GitHub repository, and GitHub returns that same canonical repository
identity:

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

## Verify server-side auto-delete

Merged **remote** branches should auto-delete on merge. Resolve the repository
from the current checkout, verify the setting, and restore it only if it has
drifted:

```bash
repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_common_dir="$(cd "$repo_common_dir" && pwd -P)"
repo="$(verified_github_repo_from_common_dir "$repo_common_dir")" || exit 1
gh api --hostname github.com "repos/$repo" --jq .delete_branch_on_merge   # => true
gh api --hostname github.com -X PATCH "repos/$repo" -F delete_branch_on_merge=true
```

`-F` (typed field) sends a JSON boolean; `-f` would send the string `"true"`.
This only reaps the remote branch on merge — local branches and worktrees still
need the sweep below.

## Local branch sweep

List branches already merged into `main`, excluding `main`/current, and delete them:

```bash
git branch --merged main | rg -v '^\*|(^|\s)main$' | xargs -r git branch -d
```

`git branch -d` is the safe delete — it refuses any branch not actually merged, so
this cannot drop live work.

## Worktree sweep

Prune registrations whose directories are already gone, then audit every live
worktree before removal. A worktree is removable only when it is clean and its
exact branch tip is the head of an API-confirmed merged PR. The proof block in
*Post-merge protocol* is the canonical removal path:

```bash
git worktree prune
git worktree list
git -C <path> status --porcelain
```

`git worktree list` shows the live `main` checkout as its first row —
never remove that one. Only sweep a feature worktree after the canonical proof
below confirms that its Git common directory is the current repository's.

## Post-merge protocol (prevents regrowth)

This is the discipline that keeps the sweep from ever having 45 branches to
catch up on. After a PR merges, prove the exact PR state, branch name, and head
SHA before removing a clean worktree and force-deleting its squash-merged local
branch:

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
cleanup_merged_worktree <number> <branch> <exact-registered-worktree-path>
```

The local deletion is an atomic compare-and-delete against the reviewed OID. If
the ref advances after proof, deletion fails and the advanced branch remains.

Paired with the `delete_branch_on_merge` setting, remote and local both self-clean
per feature. (This same step is folded into `worktree-feature`'s "Ship" flow — the
bulk sweep here is the safety net for when it was skipped.)

## Historical squash-merge sweep

Inventory first; do not pipe a list of old branch names directly into
`git branch -D`. Branch names can be reused, and a merged PR with the same name
does not prove the current tip was merged. For each candidate, list its PRs and
select the one whose `headRefOid` exactly equals the current local or remote tip:

```bash
repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_common_dir="$(cd "$repo_common_dir" && pwd -P)"
repo="$(verified_github_repo_from_common_dir "$repo_common_dir")" || exit 1
branch=<candidate>
gh pr list --repo "github.com/$repo" --state all --head "$branch" \
  --limit 100 --json number,state,mergedAt,headRefName,headRefOid,url
git rev-parse "refs/heads/$branch"
git rev-parse "refs/remotes/origin/$branch"
```

Use that PR number with the canonical proof block above. If the remote branch
still exists after local cleanup, delete it only with a lease bound to the
API-confirmed head SHA, so a concurrently advanced branch is preserved:

<!-- remote-branch-compare-delete:start -->
```bash
delete_remote_branch_at_head() {
  local branch="$1"
  local api_head="$2"
  local repo_common_dir verified_repo origin_push_url origin_push_repo

  git check-ref-format --branch "$branch" >/dev/null || return 1
  test "${#api_head}" -eq 40 || return 1
  case "$api_head" in *[!0-9a-fA-F]*) return 1 ;; esac
  repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || return 1
  repo_common_dir="$(cd "$repo_common_dir" && pwd -P)" || return 1
  verified_repo="$(verified_github_repo_from_common_dir "$repo_common_dir")" || return 1
  test -n "$verified_repo" || return 1
  origin_push_url="$(git --git-dir="$repo_common_dir" \
    remote get-url --push --all origin)" || return 1
  test -n "$origin_push_url" || return 1
  case "$origin_push_url" in *$'\n'*) return 1 ;; esac
  origin_push_repo="$(canonical_github_repo_from_url "$origin_push_url")" || return 1
  test "$origin_push_repo" = "$verified_repo" || return 1
  git push --force-with-lease="refs/heads/$branch:$api_head" \
    "$origin_push_url" ":refs/heads/$branch"
}
```
<!-- remote-branch-compare-delete:end -->

Run `delete_remote_branch_at_head "$branch" "$api_head"` only after the exact
API proof above.

Keep every dirty worktree, branch without an exact merged-PR/head match, and
closed-unmerged or open PR branch. Record the survivor and its reason instead
of guessing.

## Inventory before an explicit sweep

Counts can justify proposing maintenance, but do not mutate historical branches
or worktrees without a cleanup request:

```bash
git branch --list | wc -l
git worktree list | wc -l
```

## Gotchas

- **Squash-merged branches are invisible to `git branch --merged`.** PRs squashed
  into `main` land as a new commit whose SHA the branch never contained, so
  `--merged` reports them as unmerged and `git branch -d` refuses them. Use the
  exact API/branch/head proof above; never force-delete a bulk list of names.
- **A worktree's branch can't be deleted while the worktree exists.** Remove the
  worktree first, then compare-and-delete the branch with `git update-ref -d`
  (the order in the post-merge protocol).
- **Prune before you trust the list.** A worktree dir deleted by hand still shows in
  `git worktree list` as a stale row until `git worktree prune` clears it — run prune
  before counting for the double-digit trigger.
