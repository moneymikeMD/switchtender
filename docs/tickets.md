# Tickets

switchtender tracks work in Jira, project key `CMB` (Space name Switchtender).
The ticket contract it conforms to is
[work-order](https://github.com/moneymikeMD/work-order)'s `SPEC.md`, **not**
night-watchman. This repo does not run the night-watchman operating model
(owner decision 2026-09-16, see `CLAUDE.md`) and never has.

## Conformance claim

```
work-order SPEC.md 0.1 profile minimal
```

`minimal` is the right level for a repo whose owner explicitly wants fast code
production with tests and less process (`CLAUDE.md`, "How work happens here").
Claiming `full` would mean adopting the review/verify ceremony that decision
rejected by name; `minimal` is the honest claim for what this repo actually
does.

`.claude-plugin/plugin.json` declares the dependency this claim rests on:
`work-order` and `work-order-jira`, never `night-watchman`. CI
(`.github/workflows/conformance.yml`) asserts the negative on every push and
PR — that the dependency list does not contain `night-watchman` — which is
the portability proof this ticket (WO-014) exists to run.

## How a session works a ticket here

1. Read the Jira ticket (`CMB-NNN`) and work-order's `SPEC.md` for what a
   ticket must carry: `id`, `title`, `verify` capable of failing at the base
   state, a statement of the problem and the solution.
2. Do the work on a branch, open a PR (`CLAUDE.md` rule: every change lands
   through a PR, merged right away). Commit subjects stay Conventional
   Commits.
3. Run whatever the ticket's `verify` says before calling it done. There is no
   local `verify-run.sh` wired into this repo's CI; a session runs it by hand
   or copies the pattern from `ai-toolkit/scripts/verify-run.sh`.
4. Close the Jira ticket with a comment after merge, per `CLAUDE.md`.

None of this depends on where the session was launched from, or on
night-watchman being installed — that is the point of adopting the spec
instead of the operating model built on top of it.

## Known gap: SPEC.md conformance is not machine-checked against live CMB tickets

`work-order/conformance/validate.py` (landed by WO-006) validates a **file
binding** set: a directory with one stage subdirectory per lifecycle position
and tickets as Markdown files with frontmatter. It takes a directory as its
positional argument and has no Jira reader — no `--source` flag, no
`ISSUES_SOURCE` environment variable, nothing that reads a tracker over the
network. `plugins/work-order-jira/provider.sh` reads and writes **one issue at
a time** by key (`fetch KEY`, `position KEY`); it has no verb that lists every
issue in a project, which a materializer would need before `validate.py`
could run against a Jira-backed set at all.

So proving that CMB's actual tickets satisfy `SPEC.md`'s `minimal` MUSTs today
would require one of:

- extending `validate.py` with a Jira reader (or a project-listing verb in
  `provider.sh` plus a converter into the file binding's shape), which is a
  change to `work-order`, not to this repo; or
- provisioning CMB with the Jira binding's custom fields and workflow
  validators (`plugins/work-order-jira/provision.sh` /
  `workflow-apply.sh`) and recording the conformance claim in the project's
  description per `[JIRA-9]` — a live, production mutation to the tracker a
  shipped service actually uses today, not a repo change either.

Neither happened here. This repo, its CI and its docs conform structurally —
the plugin dependency is declared, night-watchman is absent, the profile is
documented — but no tool anywhere can currently confirm that a given CMB
issue's fields satisfy `SPEC.md` short of reading it by hand. See WO-014's
`findings` for the fuller record.
