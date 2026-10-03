---
name: kaya
description: Put a plan, comparison, diagram, table, report or spec in front of the user as a local review page they can annotate, then collect their notes. Use when a response would land better as a page than as prose, or when the user mentions Kaya, a review, an artifact, or their feedback.
---

# Kaya

Kaya opens an HTML or Markdown artifact as a local review page. The user annotates
it and sends notes back; you poll for them. Nothing leaves the machine.

## The current workflow lives in the CLI

Do not follow workflow details from this file: an installed skill drifts from the
code it describes. The binary ships with its own reference:

```
npx -y kaya-editor --help
```

That covers the review loop, the rules that are easy to get wrong, receipts, how to
delegate to a subagent, and how to write the artifact. Bare `npx -y kaya-editor`
shows the live reviews for the current directory.

## The two things that are never optional

1. **Print the review URL** that `kaya open <file>` returns, in full, in your reply
   every time you mention the review. The user cannot see your tool output.
2. **Poll after every artifact create or edit**, and whenever the user mentions the
   review or their feedback: `kaya poll <file> --agent-reply "<what changed>"`.
   Feedback never arrives on its own. Give every delivered note an outcome with
   `--receipt "n1=addressed: ...; n2=deferred: ..."`.
