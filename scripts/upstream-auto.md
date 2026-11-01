You are running unattended, started by scripts/upstream-auto.sh, in a throwaway git worktree of kaya-editor on its own branch. Nobody is watching. Finish the whole job without asking questions.

Job: bring Kaya level with what kunchenguid's -axi line (lavish-axi, axi-sdk-js, the AXI spec) shipped since the baselines in UPSTREAM.md.

## Clean-room rule (non-negotiable)

Kaya is a clean-room reimplementation. You may read lavish-axi's public CHANGELOG.md, its README, its npm page, and observe its behaviour by running it (`npx -y lavish-axi ...`). You must never read its source: not node_modules/lavish-axi, not its src or dist on GitHub, unpkg or jsdelivr, not PR diffs. axi-sdk-js is a Kaya dependency, so its changelog, README and public API are fair game.

## Steps

1. Run `npm run upstream`. It lists every new item since the baselines.
2. Read UPSTREAM.md. The Decisions table is precedent: declined items stay declined, and anything built on a declined feature (whiteboard, share/hosting, telemetry, playbooks/design, harness-specific extras) is declined for the same reason.
3. Decide each item yourself: adopted, adapted (same intent, Kaya's own form), declined, or already had. Lean towards adopting fixes to plumbing Kaya shares (polling, sessions, server, replies, receipts, the review overlay). Use `open` only for a genuine product call that needs Hud, and say what the call is.
4. For each adopted or adapted item: if it is a bug fix, reproduce the bug on Kaya first (run the real `bin/kaya.js` server; chrome-devtools-axi drives a browser if you need one). Then implement it, add or extend a test in test/kaya.test.js, and run `npm test` until it passes. Match the surrounding code's style.
5. Add one row per item to the Decisions table, with the lavish-axi version and a short why, then run `npm run upstream -- --mark`.
6. If anything under src/, bin/, vendor/ or skills/ changed, run `npm version patch --no-git-tag-version` so running Kaya servers pick up the new code.
7. Make exactly one commit. Follow the style of commit 1d5a3f3 (`git show 1d5a3f3`): a conventional subject naming what users get and "catch up with lavish-axi <version>", then plain bullets. No AI attribution, no Co-authored-by trailer.

## Do not

- push, merge, tag, publish to npm, open issues or PRs, or edit anything outside this worktree. The wrapper script lands the work after re-checking it.
- open Kaya or Lavish review pages, or wait for a human.
- use the em dash character anywhere: code, comments, commit, summary.

## Final message

Your final message is sent to Hud on Telegram as-is. Plain text, no markdown, at most 12 lines, plain English with no internal codes. Say which version Kaya is now level with, then one line per item: what it means for someone using Kaya and what you decided. End with anything left open and why.

If you could not finish (for example tests fail and you cannot fix them), do not commit. Start the final message with `FAILED:` and say what stopped you.
