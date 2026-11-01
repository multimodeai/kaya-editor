#!/bin/zsh
# Weekly: when the -axi line has moved past UPSTREAM.md's baselines, Claude Code
# brings Kaya level in a throwaway worktree (brief: scripts/upstream-auto.md).
# This script then re-checks the work itself and only if it holds fast-forwards
# master, pushes and tags. Anything that fails a check stays on its branch,
# master is untouched, and one GitHub issue says why.
# KAYA_NOTIFY, when set, is a command that gets the outcome on stdin.
# DRY_RUN=1 stops after the check and prints what would be updated.
set -u
REPO_DIR=${0:A:h:h}
NODE=${KAYA_NODE:-$(command -v node)}
GH=${KAYA_GH:-$(command -v gh)}
CLAUDE=${KAYA_CLAUDE:-$(command -v claude)}
LIMIT=${KAYA_AGENT_SECONDS:-5400}
path=("${NODE:h}" $path)  # npm, kaya and the -axi tools for the agent
stamp=$(date +%Y-%m-%d)
log() { print -- "[$(date '+%Y-%m-%d %H:%M')] $*"; }

notify() {
  print -- "$1"
  if [[ -n "${KAYA_NOTIFY:-}" ]]; then
    print -- "$1" | ${=KAYA_NOTIFY} >/dev/null 2>&1 || log "notify failed"
  fi
}

version_of() { "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }

cd "$REPO_DIR" || exit 1
out=$("$NODE" scripts/upstream.mjs 2>&1); code=$?
log "upstream check exit=$code"
if (( code != 0 )); then print -- "$out"; exit $code; fi
new=$(print -- "$out" | sed -n 's/^  new: \([0-9][0-9]*\)$/\1/p' | head -1)
log "new: ${new:-?}"
[[ "$new" =~ ^[0-9]+$ ]] || { print -- "could not read the new count"; print -- "$out"; exit 1; }
(( new == 0 )) && exit 0
if [[ -n "${DRY_RUN:-}" ]]; then print -- "DRY RUN - would update Kaya for:"; print -- "$out"; exit 0; fi

branch="upstream/$(date +%Y-%m-%d-%H%M)"
work="$HOME/Library/Caches/kaya-upstream/${branch:t}"
summary=""

fail() {
  log "FAILED: $1"
  local body issue
  body=$(printf '%s\n\nMaster was not touched. The work is on branch `%s` in `%s`.\n\nAgent summary:\n\n```\n%s\n```\n\nDelta:\n\n```\n%s\n```\n' "$1" "$branch" "$work" "$summary" "$out")
  issue=$("$GH" issue create --repo multimodeai/kaya-editor --title "Upstream -axi auto-update failed: $stamp" --body "$body" 2>&1)
  notify "Kaya auto-update FAILED: $1
Master was not touched. Details: $issue"
  exit 1
}

git fetch --quiet origin || fail "could not fetch from GitHub"
base=$(git rev-parse master)
unpushed=$(git rev-list --count origin/master..master)
mkdir -p "${work:h}"
git worktree add --quiet -b "$branch" "$work" "$base" || fail "could not create the worktree"
npm ci --prefix "$work" --no-audit --no-fund >/dev/null 2>&1 || fail "npm ci failed in the worktree"

# Its own port and state, so the agent never replaces the Kaya server in use.
log "agent started on $branch"
summary=$(cd "$work" && KAYA_PORT=41799 KAYA_STATE_DIR="$work.state" \
  perl -e 'alarm shift; exec @ARGV' "$LIMIT" \
  "$CLAUDE" -p "$(<scripts/upstream-auto.md)" --dangerously-skip-permissions --no-session-persistence --output-format text 2>&1)
code=$?
log "agent exit=$code"
(( code == 0 )) || fail "the agent stopped early (exit $code; the time limit is ${LIMIT}s)"
[[ "$summary" == FAILED:* ]] && fail "the agent could not finish"

# Re-check here rather than trusting the agent's word.
[[ -z "$(git -C "$work" status --porcelain)" ]] || fail "the agent left uncommitted changes"
(( $(git -C "$work" rev-list --count "$base..$branch") >= 1 )) || fail "the agent made no commit"
git -C "$work" diff --quiet "$base" "$branch" -- UPSTREAM.md && fail "the UPSTREAM.md baselines did not move"
npm test --prefix "$work" >/dev/null 2>&1 || fail "the tests fail on the agent's commit"
old=$(git show "$base:package.json" | version_of)
now=$(git show "$branch:package.json" | version_of)
tag=""
if ! git -C "$work" diff --quiet "$base" "$branch" -- src bin vendor skills; then
  [[ "$old" != "$now" ]] || fail "the code changed but the version was not bumped"
  tag="v$now"
fi

if [[ "$(git branch --show-current)" != master || -n "$(git status --porcelain)" ]]; then
  notify "Kaya update ready on branch $branch but not landed: your kaya-editor checkout is off master or has uncommitted changes. Land it with: git merge --ff-only $branch

$summary"
  exit 0
fi
git merge --ff-only --quiet "$branch" || fail "master moved during the run, so it could not be fast-forwarded"
[[ -n "$tag" ]] && git tag "$tag"
git worktree remove --force "$work" && git branch -q -d "$branch"
rm -rf -- "$work.state"
landed="Kaya auto-updated${tag:+ to $tag}."
if (( unpushed > 0 )); then
  landed="$landed Not pushed: master already had $unpushed unpushed commit(s) of yours."
elif git push --quiet origin master ${tag:+"$tag"}; then
  landed="$landed Pushed to GitHub."
else
  landed="$landed Landed locally, but the push failed."
fi
log "$landed"
notify "$landed

$summary"
