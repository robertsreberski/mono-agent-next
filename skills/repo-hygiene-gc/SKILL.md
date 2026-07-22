---
name: repo-hygiene-gc
description: Explicit bulk branch/worktree garbage collection using API-bound deletion proof. Use when asked to clean up the repository or run a deliberate maintenance sweep; ordinary PR cleanup belongs to worktree-feature.
---

# Repo hygiene GC

The clean `main` checkout stays in place because it backs local live tooling,
while feature work uses branches and worktrees under
`~/.config/superpowers/worktrees/mono-agent/` (see `worktree-feature`).
Per-PR cleanup prevents new residue. This skill handles an explicitly requested
historical sweep; never start it merely because another task finished.

## Verify server-side auto-delete

Merged **remote** branches should auto-delete on merge. #292 enabled the setting;
verify it remains on, and restore it only if it has drifted:

```bash
gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge   # => true
gh api -X PATCH repos/robertsreberski/mono-agent -F delete_branch_on_merge=true
```

`-F` (typed field) sends a JSON boolean; `-f` would send the string `"true"`.
This only reaps the remote branch on merge — local branches and worktrees still
need the sweep below.

## Local branch sweep

List branches already merged into `main`, excluding `main`/current, and delete them:

```bash
git branch --merged main | grep -vE '^\*|(^|\s)main$' | xargs -r git branch -d
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
never remove that one; only sweep the feature worktrees under
`~/.config/superpowers/worktrees/mono-agent/`.

## Post-merge protocol (prevents regrowth)

This is the discipline that keeps the sweep from ever having 45 branches to
catch up on. After a PR merges, prove the exact PR state, branch name, and head
SHA before removing a clean worktree and force-deleting its squash-merged local
branch:

<!-- merged-worktree-cleanup:start -->
```bash
cleanup_merged_worktree() {
  local repo="$1"
  local pr="$2"
  local branch="$3"
  local worktree="$4"
  local repo_common_dir repo_root proof api_branch api_head local_head
  local worktree_common_dir worktree_root supplied_worktree
  local worktree_branch worktree_head worktree_status

  git check-ref-format --branch "$branch" >/dev/null || return 1
  repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || return 1
  repo_common_dir="$(cd "$repo_common_dir" && pwd -P)" || return 1
  repo_root="$(dirname "$repo_common_dir")"

  proof="$(gh pr view "$pr" --repo "$repo" \
    --json state,mergedAt,headRefName,headRefOid \
    --jq 'select(.state == "MERGED" and .mergedAt != null) | [.headRefName, .headRefOid] | join(" ")')" || return 1
  test -n "$proof" || return 1
  api_branch="${proof%% *}"
  api_head="${proof#* }"
  local_head="$(git -C "$repo_root" rev-parse --verify "refs/heads/$branch^{commit}")" || return 1

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

  git -C "$repo_root" worktree remove "$worktree" || return 1
  git -C "$repo_root" update-ref -d "refs/heads/$branch" "$api_head" || return 1
  git -C "$repo_root" worktree prune
}
```
<!-- merged-worktree-cleanup:end -->

```bash
cleanup_merged_worktree \
  robertsreberski/mono-agent <number> <branch> \
  ~/.config/superpowers/worktrees/mono-agent/<name>
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
branch=<candidate>
gh pr list --repo robertsreberski/mono-agent --state all --head "$branch" \
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

  git check-ref-format --branch "$branch" >/dev/null || return 1
  test -n "$api_head" || return 1
  git push --force-with-lease="refs/heads/$branch:$api_head" \
    origin ":refs/heads/$branch"
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
