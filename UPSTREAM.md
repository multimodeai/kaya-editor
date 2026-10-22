# Upstream: the -axi line

Kaya tracks [kunchenguid](https://github.com/kunchenguid)'s AXI work so it does not drift far from it.
Lavish ships roughly every two days, so a one-off parity pass goes stale within a week.
This file is the memory between checks: what was reviewed, and what was decided.

Run `npm run upstream` to see only what changed since the baselines below.
After reviewing a delta, record decisions in the table, then run `npm run upstream -- --mark` to move the baselines forward.

## Baselines

The check script reads and rewrites this block. Keep the format.

```upstream
lavish-axi: 0.1.90
axi-sdk-js: 0.1.13
axi-spec: 0374ba4118d4
reviewed: 2026-10-22
```

| Source | What it is | Where the check reads it |
| --- | --- | --- |
| `lavish-axi` | Kaya's direct comparison, listed in the AXI catalog as the AXI for human review | `kunchenguid/lavish-axi` CHANGELOG.md |
| `axi-sdk-js` | The runtime Kaya's CLI is built on, so most AXI conformance arrives from here | `kunchenguid/axi` packages/axi-sdk-js/CHANGELOG.md |
| `axi-spec` | The ten principles | commits to `principles.yaml` and the AXI skill in `kunchenguid/axi` |

## Decisions

Declined items stay declined. They are recorded so the same question is not re-argued on every check.

| Item | Source | Decision | Why |
| --- | --- | --- | --- |
| Atomic batched submit | lavish-axi | adopted | A partial send lost every note queued behind a failure |
| next_step in every poll | lavish-axi | adopted | Agents answered in their own chat instead of in the review |
| Unmistakable multi-item delivery | lavish-axi | adapted | `[item n/N]` numbering instead of a JSON array; same intent in Kaya's plain-text poll |
| Agent presence shown to the reviewer | lavish-axi | adopted | A dead or absent agent was invisible from the review panel |
| browser_disconnected poll status | lavish-axi 0.1.67 | adopted | Polls hung on closed tabs |
| Guidance lives in the CLI, skill is a pointer | lavish-axi | adopted | The skill file drifted twice from the code |
| DOM snapshot with feedback | lavish-axi | adapted | Written to disk and passed as a path, not inlined, so it never buries the notes |
| Image attachments | lavish-axi | adopted | |
| One server on a fixed port | lavish-axi | adopted | Root cause of dead URLs, stranded notes and stale servers. Port 41731, not Lavish's 4387, so both can run |
| Superseding pollers | lavish-axi 0.1.75 | adopted | 25 concurrent pollers piled up on one session. Only JSON-speaking clients take part, so old ones cannot ping-pong |
| `reply` command with acceptance receipt | lavish-axi 0.1.80 | adopted | A reply could only ride on a poll |
| Per-item receipts for batches | lavish-axi | adapted | Applied to every batch, not just tracked forms; skipped ids are named back on the next poll or reply |
| Full AXI compliance via axi-sdk-js | axi-spec | adopted | Building on the same SDK keeps Kaya close without re-implementing it |
| AXI 3: truncate large fields | axi-spec | adapted | Notes are never truncated: they are the payload, and a skimmed batch is how only the first note got answered. The DOM snapshot is passed as a path instead |
| AXI 7: session hooks, then a skill | axi-spec | adopted | `kaya setup hooks` via the SDK; `skills/kaya/SKILL.md` ships as a pointer to `kaya --help` |
| Idle auto-stop | lavish-axi | adopted | 30 minutes; an open tab keeps the server alive, so a review never dies under someone reading it |
| Server replaces older running code | own | adopted | A running server used to keep its old code forever; open and poll now swap it for the current one, never a downgrade |
| Stop refuses while notes are unsent | own | adopted | Restarting a per-file server stranded typed notes; `--force` to override |
| Constrain sessions and assets to the artifact tree; refuse foreign hosts and cross-site requests | lavish-axi 0.1.84 | adopted | Reproduced on Kaya: a website could register any local file as a review and read it back via DNS rebinding |
| Per-note delivery receipts (seen, working, done) | lavish-axi 0.1.83 | adapted | Text status on each of the reviewer's notes (waiting, seen, working, then the receipt's outcome) instead of emoji |
| Edit queued annotations in place | lavish-axi 0.1.81 | adopted | Click a queued note or its element to edit it before sending |
| Cmd/Ctrl-click follows a link in annotate mode | lavish-axi 0.1.83 | adopted | A plain click on a link used to navigate away from the review |
| Interactive ARIA widgets pass through annotation | lavish-axi 0.1.82 | adopted | Same role list as Lavish, with its exception for a real link inside a widget |
| Artifact declares initial annotation mode | lavish-axi 0.1.86 | adapted | `<html data-kaya-annotate="on">`; Kaya's default stays off, since its pages are mostly choices to click |
| Configurable browser-disconnect grace | lavish-axi 0.1.90 | adopted | `KAYA_DISCONNECT_GRACE_MS`; default stays 15s |
| Adopt a running server newer than the CLI | lavish-axi 0.1.87 | already had | Kaya never replaces a newer running server with an older one, since 0.3.0 |
| Ignore the Enter that confirms an IME conversion | lavish-axi 0.1.89 | adopted | Reproduced on Kaya: Enter confirming a Chinese/Japanese word queued a half-typed note |
| Cmd-click follows links on macOS only, Ctrl-click elsewhere | lavish-axi 0.1.88 | adopted | On a Mac Ctrl-click is right-click; on Windows/Linux only Ctrl should follow |
| Excalidraw libraries in the whiteboard | lavish-axi 0.1.85 | declined | Whiteboard itself is declined |
| Fatal render detection (`artifact_failures`) | lavish-axi | open | Not yet reviewed in depth |
| Per-harness guidance | lavish-axi | open | Lavish special-cases Codex; not yet needed |
| Whiteboard / Excalidraw editing | lavish-axi | declined | About 8MB of runtime for diagram redrawing nobody has asked for |
| Share to third-party hosting | lavish-axi | declined | Kaya is local-only by design; `export` covers portability |
| Usage telemetry | lavish-axi | declined | Lavish reports every command to an analytics host; Kaya sends nothing anywhere |
| Herdr readiness chime | lavish-axi 0.1.74 | declined | Niche; tied to a specific harness |
| Playbooks and `design` command | lavish-axi | declined for now | Content, not plumbing; `kaya --help` carries condensed guidance |
