---
name: sprint-recap
description: Recap what the user achieved during the current or a selected sprint, or an explicit date window, including issues created, PRs opened and merged, merge actions, and reviews submitted. Use for sprint accomplishments, retrospectives, and measurable activity summaries. Use sprint-status for current work and the review queue.
allowed-tools: Bash, Read, Grep, Glob
---

# Sprint recap

Report the authenticated user's recorded activity during an iteration on the
project board named in `docs/agents/issue-tracker.md`, or during an explicit
date window. Include activity across the project's repositories even when the
work is absent from the board. This is an activity recap, not a record of the
sprint's original commitments.

## Collect the evidence

Read the tracker settings and the routing table in
`docs/agents/issue-tracker.md`, following the
[rules for reading the profile](../../references/project-profile.md), and map
them to flags:

| Tracker setting | Flag |
| --- | --- |
| Project board owner | `--owner <owner>` |
| Project board title | `--project "<exact title>"` |
| Iteration field | `--iteration-field "<name>"`, when the board has several |
| Sprint time zone | `--timezone <IANA zone>`, on every run |
| Each distinct repository in the routing table's `Repository` column, skipping rows whose `Component` is still `TODO` | `--repo <owner/repo>`, repeated |
| Default repository, when the routing table has no `Repository` column or every row's `Component` is still `TODO` | `--repo <owner/repo>`, once |

The script needs `--repo` or `--all-repos` and stops when it gets neither. Pass
`--all-repos` instead of `--repo` only when the user asks for every repository
of the owner. Never pass the template's placeholder `owner/repo`. The script
rejects it. If another value the command needs is still `TODO`, say so and
recommend `setup-project` rather than guessing. The board is required: if the
settings name none, ask the user to run
`npx agent-fleet@latest update --dry-run` and then
`npx agent-fleet@latest update` in their own terminal. The update creates or
repairs the project board on GitHub. Do not run it yourself without the user's
approval. When the user asks you to run it, follow [Updating the
installation](../../references/project-profile.md#updating-the-installation).

Run from the project root:

```bash
node .agents/skills/sprint-recap/scripts/sprint-recap.mjs --owner <owner> --project "<board title>" --timezone <IANA zone> --repo <owner/repo> [--repo <owner/repo> ...]
```

The collector needs Node.js 20 or later and the GitHub CLI. It reuses the sibling
`sprint-status/scripts/sprint-data.mjs` for the
owner, board, and iteration definition. Keep both canonical skill directories together.
Run the canonical script when invoked through a tool adapter. Do not copy the collector into adapters.

Use `--date YYYY-MM-DD` to select the iteration containing that date. A completed
iteration covers its full duration. The current iteration stops at collection time.
The date selects a sprint, not a cutoff within it. No matching iteration or a future
iteration is an error, not a reason to substitute a calendar fortnight.

When the user asks for a period other than a sprint, such as a month or a
quarter, pass `--since YYYY-MM-DD` and optionally
`--until YYYY-MM-DD` (inclusive, default today) instead of `--date`. Name that
window in the recap rather than calling it a sprint.

Dates use the time zone passed with `--timezone`. Pass the tracker settings'
sprint time zone unless the user requests another IANA time zone. When that
setting is `TODO`, ask the user for a time zone rather than letting the script
fall back to UTC. Without `--timezone`, the script uses UTC, writes a warning
to stderr, and sets `window.timezoneDefaulted` to `true`. The JSON records the
exact start-inclusive, end-exclusive UTC window.

All remote calls are read-only and use `gh` authentication. If `read:project` is
missing, tell the user to run `gh auth refresh -s read:project`. Do not work around
the scope requirement. An API failure or incomplete search is not a zero count.
The collector paginates and rejects truncated searches rather than reporting partial totals.

## Write the recap

Read the JSON before writing. Start with the sprint title or window, date range,
account, time zone, scope, and collection cutoff. When
`window.timezoneDefaulted` is `true`, say that the dates use UTC because no
sprint time zone was passed. Say "so far" for an ongoing sprint. The JSON's
`project.url` links the board when there is one.

Give a compact metrics table using these definitions:

| Metric | Evidence and counting rule |
| --- | --- |
| Issues created | Issue author is the user and creation falls within the window. Includes issues now closed. |
| PRs opened | PR author is the user and creation falls within the window. Includes drafts and PRs now merged or closed. |
| Your PRs merged | User-authored PRs whose merge falls within the window, including PRs opened before the sprint. |
| Merge actions | PRs whose recorded merger is the user and whose merge falls within the window. Includes others' PRs. |
| Reviews submitted | Submitted review records by the user on others' PRs, filtered by submission time. |
| Distinct PRs reviewed | Unique PR URLs among those reviews. Multiple reviews on one PR count once here. |
| Median hours from opening to merge | Elapsed time for your PRs merged in the window. Show the sample size. With no merges, show unavailable. |

Follow with the actual issues created and PRs opened or merged, grouped by repository
when helpful. Link every item using its returned `url`, following the
[GitHub reference rules](../../references/github-references.md).
Show creation or merge dates and distinguish current state from the event counted.
Show PRs opened before the sprint that merged during it. Combine repeated PRs into
one list entry with both events, while keeping the metric counts separate.
Show zero explicitly for the three core counts. Never add overlapping counts into
a total "achievements" score or divide merged by opened as a completion rate.

Add a short account of what the merged work changed, grounded in the linked PRs.
Read a PR body with `gh pr view <number> --repo <owner/repo> --json body,url` when its title
does not establish the outcome. Do not infer deployment, release, production impact, sole
ownership, or hours worked from a merge. Describe created issues as planning or
problem discovery, not completed implementation.

Summarise reviews and merge actions separately when present. Use `byRepository`
for a repository breakdown without repeating every metric for every repository.
State material coverage gaps. Current titles, draft flags, and states are snapshots
at collection time, including for historical recaps. A dismissed review still
counts as a submission, but its current state does not prove the original verdict.

## Add metrics only when useful

The default collector implements the metrics above. For requested additions,
consult [metric definitions and evidence requirements](references/metrics.md).
Do not present optional metrics as already collected. If the user requests a
board-only recap, resolve board membership and linked issues before filtering.
Current membership cannot prove historical membership or the original commitment.
Keep uncategorised work visible rather than treating an absent board link as proof
that the work was unplanned.

This skill produces a report. It does not change the board, publish a retrospective,
or create issues, comments, commits, or PRs.
