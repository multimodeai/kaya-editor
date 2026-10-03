# Upstream: the -axi line

Kaya tracks [kunchenguid](https://github.com/kunchenguid)'s AXI work so it does not drift far from it.
Lavish ships roughly every two days, so a one-off parity pass goes stale within a week.
This file is the memory between checks: what was reviewed, and what was decided.

Run `npm run upstream` to see only what changed since the baselines below.
After reviewing a delta, record decisions in the table, then run `npm run upstream -- --mark` to move the baselines forward.

## Baselines

The check script reads and rewrites this block. Keep the format.

```upstream
lavish-axi: 0.1.80
axi-sdk-js: 0.1.13
axi-spec: e62199508ebb
reviewed: 2026-10-03
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
| One server on a fixed port | lavish-axi | adopting | Root cause of dead URLs, stranded notes and stale servers |
| Superseding pollers | lavish-axi 0.1.75 | adopting | 25 concurrent pollers piled up on one session |
| `reply` command with acceptance receipt | lavish-axi 0.1.80 | adopting | A reply could only ride on a poll |
| Per-item receipts for batches | lavish-axi | adopting | Numbering showed items but did not make agents account for them |
| Full AXI compliance via axi-sdk-js | axi-spec | adopting | Building on the same SDK keeps Kaya close without re-implementing it |
| Whiteboard / Excalidraw editing | lavish-axi | declined | About 8MB of runtime for diagram redrawing nobody has asked for |
| Share to third-party hosting | lavish-axi | declined | Kaya is local-only by design; `export` covers portability |
| Usage telemetry | lavish-axi | declined | Lavish reports every command to an analytics host; Kaya sends nothing anywhere |
| Herdr readiness chime | lavish-axi 0.1.74 | declined | Niche; tied to a specific harness |
| Playbooks and `design` command | lavish-axi | declined for now | Content, not plumbing; `kaya --help` carries condensed guidance |
