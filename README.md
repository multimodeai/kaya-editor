# KAYA Editor

Review an HTML or Markdown artifact in your browser, annotate it, and send the
feedback back to the agent that wrote it. Everything runs on your machine.

No account, no upload, no third-party host. A dependency-free Node server that
serves one file and injects a review overlay over it.

```bash
npm i -g kaya-editor

kaya plan.html            # open a review session, prints a local URL
kaya poll plan.html       # wait for the feedback you queue in the browser
kaya export plan.html     # write a self-contained copy that opens with no server
kaya end plan.html        # close the review
```

## What it is for

An agent writes a document — a plan, a report, a spec, a comparison. Reading that
in a terminal is miserable and reviewing it in prose is worse. KAYA serves the
artifact as a page you can actually look at, lets you attach notes to specific
elements, and hands those notes back to the agent as structured feedback.

The loop: agent writes → you annotate → agent revises → repeat, until you end it.

## Commands

| Command | What it does |
|---|---|
| `kaya <file>` | Open or resume a review. Prints the URL and opens a browser. |
| `kaya <file> --reopen` | Reopen a review **you** ended. Required — see below. |
| `kaya poll <file> [--agent-reply "..."]` | Block until you send feedback or end the session. |
| `kaya export <file> [--out <path>]` | Write a standalone HTML copy with local assets inlined. |
| `kaya end <file>` | End the review as the agent. |
| `kaya list` | Show active sessions. |
| `kaya stop [file]` | Stop the server. |

Markdown is rendered to a dark themed page for review. The source file is never
rewritten, so tooling that parses your raw Markdown keeps working.

## In the browser

- **Annotate** — toggle it on, click an element or select text, write a note.
  Notes queue up; send them as one batch.
- **Zoom** — hover a diagram, image or SVG for a zoom control. Wheel to zoom,
  drag to pan. With Annotate on, click a node inside the zoom to comment on it.
- **Conversation** — the agent's replies and your notes, in order.
- **Layout issues** — flags when the page scrolls sideways. Containers that scroll
  on purpose are not flagged.

### Notes survive a reload

Queued notes are staged in `sessionStorage` and restored automatically, so a
reload, a crash, or an accidental navigation does not destroy work you have
typed. Staging is cleared only after a send succeeds.

### Sessions you end stay ended

If **you** end a review from the browser, a plain `kaya <file>` refuses to reopen
it and says so. An agent cannot wander back into a review you closed; it has to
be asked, via `--reopen`. An agent ending its own turn does not lock you out.

### Asking you a question

An artifact can declare a question and KAYA renders the control:

```html
<div data-kaya-ask="approach"
     data-kaya-label="Which approach?"
     data-kaya-options="rewrite|patch|leave it"></div>
```

Clicking an option queues `[ask] approach = patch`. Because KAYA owns the widget,
the answer comes back typed instead of as prose the agent has to interpret.

## Requirements

Node >= 22. No runtime dependencies.

## Assets

KAYA serves the file through a local server rooted at that file's own directory.
Put images, CSS and fonts alongside the artifact and reference them with relative
paths — never a leading `/`.

## Licence

MIT. See `THIRD-PARTY-NOTICES.md` for attribution.
