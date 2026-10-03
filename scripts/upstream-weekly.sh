#!/bin/zsh
# Weekly: check the -axi line for changes since UPSTREAM.md's baselines and,
# only when there are some, open one GitHub issue with the delta. Never commits,
# pushes or moves the baselines - a human reviews the issue and runs --mark.
# DRY_RUN=1 prints the issue instead of opening it.
set -u
REPO_DIR=${0:A:h:h}
NODE=${KAYA_NODE:-$(command -v node)}
GH=${KAYA_GH:-$(command -v gh)}
cd "$REPO_DIR" || exit 1
out=$("$NODE" scripts/upstream.mjs 2>&1); code=$?
stamp=$(date +%Y-%m-%d)
print -- "[$stamp] upstream check exit=$code"
if (( code != 0 )); then print -- "$out"; exit $code; fi
new=$(print -- "$out" | sed -n 's/^  new: \([0-9][0-9]*\)$/\1/p' | head -1)
print -- "new: ${new:-?}"
[[ "$new" =~ ^[0-9]+$ ]] || { print -- "could not read the new count"; print -- "$out"; exit 1; }
(( new == 0 )) && exit 0
title="Upstream -axi delta: $stamp"
body=$(printf 'Changes in the -axi line since the UPSTREAM.md baselines.\n\nRecord adopt / adapt / decline for each in UPSTREAM.md, then run `npm run upstream -- --mark`.\n\n```\n%s\n```\n' "$out")
if [[ -n "${DRY_RUN:-}" ]]; then print -- "DRY RUN - would open: $title"; print -- "$body"; exit 0; fi
# One open issue per week, so a re-run never duplicates it.
if "$GH" issue list --repo multimodeai/kaya-editor --state open --search "\"$title\" in:title" --json number --jq 'length' | grep -qv '^0$'; then
  print -- "issue already open for $stamp"; exit 0
fi
"$GH" issue create --repo multimodeai/kaya-editor --title "$title" --body "$body"
