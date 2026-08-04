# Plan Frontmatter Convention

Every `plans/**/*.md` in a participating repository carries this block:

```yaml
---
title: "Human-readable plan title"
date: 2026-08-02
status: active
tags: []
---
```

Exactly four fields, in this order.

- `date` is the plan's creation date, not its last edit.
- `title` is the document's H1 with dates and file-name noise removed.
- Adding the block must not change any other content in the file.

## Status vocabulary

| status      | meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `active`    | Being executed or observed now                                                              |
| `backlog`   | Decided, not started — includes deferred work                                               |
| `done`      | Executed to completion. A disposal queue, not a resting place — retired at the next release |
| `reference` | Still consulted: standing documents, and finished plans something still points at           |

`archived` and `untriaged` are presentation states, not values to write. A file under an
`archive/` directory is archived by location; if it also carries frontmatter, the written status
wins.

## done vs reference

Both describe finished work, so the distinction cannot rest on how significant the plan feels.

> **Does anything still point at it?** An ADR, a successor plan, a doc.
> Yes → `reference`. No → `done`.

An inbound link makes a plan load-bearing for a document that outlives it, and retiring it breaks
that reference. Nothing pointing at it means the plan has no readers left — its content either
flowed upstream or was scaffolding.

`done` decays. At each release, `done` plans move to `plans/archive/`: they leave the active
surface, keep their git history, and stay greppable. **A `done` pile that never shrinks means the
retirement step is not running.**

A plan asserting its own permanence in its body ("retained as the record") is still `done` — that
is what `done` means. Only an inbound link promotes it to `reference`.

## Retirement contract

A consumer that automates retirement:

1. Selects `status: done` plans outside the archive directory.
2. Fails when any of them has an inbound link. That plan is misclassified, and archiving it would
   break the citing document.
3. Moves the rest into `plans/archive/`, preserving each subpath and re-basing relative links for
   the added directory depth.

Step 2 is the whole gate. It does not fail because the queue is non-empty: `done` plans exist
legitimately between releases, and a check that fired on their existence would be red almost
always and therefore ignored.

**Link sources are configured, never defaulted.** The scan answering "does anything point at
this?" is worth exactly what the directory list it reads is worth. A repository whose layout does
not match the configured sources finds nothing, reports a clean queue, and archives plans that are
still cited — silently, then destructively. The two failure directions are not symmetric:

|          | False positive                | False negative                          |
| -------- | ----------------------------- | --------------------------------------- |
| Cause    | A plan named in passing prose | Link sources misconfigured or missing   |
| Effect   | Plan not archived             | Plan archived while still cited         |
| Recovery | Re-runs at the next release   | Restore from git, fix every broken link |

So absent configuration is an error, never an empty scan.
