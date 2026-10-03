# KAYA Editor

Review an HTML or Markdown artifact in your browser, annotate it, and send the
feedback back to the agent that wrote it. Everything runs on your machine.

No account, no upload, no third-party host, no telemetry. One small local server
hosts every review and injects a review overlay over each artifact.

```bash
npm i -g kaya-editor

kaya plan.html            # open a review, prints its URL
kaya poll plan.html       # wait for the notes you send from the browser
kaya reply plan.html --agent-reply "Done" --receipt "n1=addressed: warmer title"
kaya end plan.html        # close the review
```

KAYA is an [AXI](https://axi.md) (Agent eXperience Interface): output is compact
TOON, errors are structured with a next step, and bare `kaya` shows the live
reviews for the directory you are in.

## What it is for

An agent writes a document: a plan, a report, a spec, a comparison. Reading that
in a terminal is miserable and reviewing it in prose is worse. KAYA serves the
artifact as a page you can actually look at, lets you attach notes to specific
elements, and hands those notes back to the agent as structured feedback.

The loop: agent writes, you annotate, agent revises and accounts for every note,
repeat until you end it.

## Commands

| Command | What it does |
|---|---|
| `kaya` | Live reviews for this directory. |
| `kaya <file>` | Open or resume a review. Prints the URL; opens a browser if none is showing it. |
| `kaya <file> --reopen` | Reopen a review **you** ended. Required, see below. |
| `kaya poll <file> [--agent-reply "..."] [--receipt "..."]` | Block until you send notes, end the review, or close it. |
| `kaya reply <file> --agent-reply "..." [--receipt "..."]` | Hand a result back without waiting; confirms the server accepted it. |
| `kaya list` | Every live review on this machine, with unread counts. |
| `kaya end <file>` | End the review as the agent. A no-op if it is already ended. |
| `kaya export <file> [--out <path>]` | Write a standalone HTML copy with local assets inlined. |
| `kaya stop <file>` / `kaya stop --all` | Stop a review. Refuses while you have unsent notes, unless `--force`. |
| `kaya setup hooks` | Show live reviews at the start of every Claude Code, Codex or OpenCode session. |
| `kaya update` | Upgrade KAYA itself. |

Every command takes `--help`. Unknown flags are rejected with the valid ones
listed, never silently ignored.

Markdown is rendered to a dark themed page for review. The source file is never
rewritten, so tooling that parses your raw Markdown keeps working.

## In the browser

- **Annotate**: toggle it on, click an element or select text, write a note. Notes
  queue up; send them as one batch. Paste or drop an image onto a note to attach it.
- **Zoom**: hover a diagram, image or SVG for a zoom control. Wheel to zoom, drag to
  pan. With Annotate on, click a node inside the zoom to comment on it.
- **Conversation**: the agent's replies and your notes, in order. Each note shows its
  id, and the agent's receipt marks each one addressed, deferred or rejected.
- **Agent presence**: the header says whether an agent is listening, working, has
  replied, or whether nothing is listening at all, so notes are never sent into a
  void without you knowing.
- **Layout issues**: flags when the page scrolls sideways. Containers that scroll on
  purpose are not flagged.

### A review's URL never changes

One server on a fixed port (41731, or `KAYA_PORT`) hosts every review at
`/s/<key>/`. The URL survives restarts and upgrades, so links stay valid and an
open tab simply reconnects. The server replaces itself with newer code the next
time `kaya open` or `kaya poll` runs, and stops itself after 30 idle minutes; an
open tab keeps it running.

### Notes are never lost

Queued notes are staged in browser storage and restored automatically, so a
reload, a crash, a server restart or an upgrade does not destroy work you have
typed. Notes that arrived but had not reached the agent yet are kept on disk.
Staging is cleared only after a send succeeds, and `kaya stop` refuses while you
still have notes you have not sent.

### Every note gets an answer

Each note has a short id (`n1`, `n2`, ...). When the agent replies it gives every
id an outcome in a receipt:

```bash
kaya poll plan.html --agent-reply "Applied your notes" \
  --receipt "n1=addressed: warmer title; n2=deferred: needs Q3 figures; n3=rejected: out of scope"
```

Any note the agent skips is named back to it on its next poll or reply, so a batch
of several notes cannot quietly get only its first one answered.

### Sessions you end stay ended

If **you** end a review from the browser, a plain `kaya <file>` refuses to reopen
it and says so. An agent cannot wander back into a review you closed; it has to be
asked, via `--reopen`. An agent ending its own turn does not lock you out.

### Asking you a question

An artifact can declare a question and KAYA renders the control:

```html
<div data-kaya-ask="approach"
     data-kaya-label="Which approach?"
     data-kaya-options="rewrite|patch|leave it"></div>
```

Clicking an option queues `[ask] approach = patch`. Because KAYA owns the widget,
the answer comes back typed instead of as prose the agent has to interpret.

## Using it from an agent

Two ways to give an agent KAYA; you only need one.

- **Session hook** (recommended): `kaya setup hooks` makes every new Claude Code,
  Codex or OpenCode session start with the live reviews for its directory already
  in view. It only touches its own entries; `kaya setup remove` takes them out.
- **Skill**: `npx skills add multimodeai/kaya-editor --skill kaya` installs an
  on-demand skill. It points the agent at `kaya --help`, which carries the full
  workflow and ships with the code, so it cannot drift out of date.

## Requirements

Node >= 22. Runtime dependencies: `axi-sdk-js` (the shared AXI runtime) and
`@toon-format/toon`.

## Assets

KAYA serves the file through a local server rooted at that file's own directory.
Put images, CSS and fonts alongside the artifact and reference them with relative
paths, never a leading `/`.

## Licence

FSL-1.1-MIT: source-available now, converts to plain MIT two years after each
release. See `LICENSE` for the full terms and `THIRD-PARTY-NOTICES.md` for
attribution.
