---
name: sprint-status
description: Report the user's current GitHub sprint - issues assigned to them in the active iteration of the project board, what is in progress vs still outstanding, a short code-state note on each in-progress item, and the PR review queue in both directions. Use when the user asks about their sprint, standup, what they are working on, what is outstanding, or which PRs need reviewing.
allowed-tools: Bash, Read, Grep, Glob
---

# Sprint status

Produces a standup-style briefing from the project board named in
`docs/agents/issue-tracker.md`, plus the state of the code behind each
in-flight item.

## 1. Collect the data

Read the tracker settings and the routing table in
`docs/agents/issue-tracker.md`, following the
[rules for reading the profile](../../references/project-profile.md), and map
them to flags. The board is required: if the settings name none, say so and ask
the user to run `npx agent-fleet@latest update --dry-run` and then
`npx agent-fleet@latest update` in their own terminal. The update creates or
repairs the project board on GitHub. Do not run it yourself without the user's
approval. When the user asks you to run it, follow [Updating the
installation](../../references/project-profile.md#updating-the-installation).
If another value the command needs is still `TODO`, say so and recommend
`setup-project` rather than guessing.

| Tracker setting | Flag |
| --- | --- |
| Project board owner | `--owner <owner>` |
| Project board title | `--project "<exact title>"` |
| Status field | `--status-field "<name>"`, when it is not `Status` |
| Iteration field | `--iteration-field "<name>"`, when the board has several |
| Lifecycle statuses | `--todo-status`, `--started-status`, `--review-status`, `--done-status`, when they differ from `Todo`, `In progress`, `In review`, and `Done` |
| Sprint time zone | `--timezone <IANA zone>`, on every run |
| Each distinct repository in the routing table's `Repository` column, skipping rows whose `Component` is still `TODO` | `--repo <owner/repo>`, repeated |
| Default repository, when the routing table has no `Repository` column or every row's `Component` is still `TODO` | `--repo <owner/repo>`, once |

The script needs `--repo` or `--all-repos` and stops when it gets neither. Pass
`--all-repos` instead of `--repo` only when the user asks for every repository
of the owner. Never pass the template's placeholder `owner/repo`. The script
rejects it.

Run the script that ships with this skill, from the project root:

```bash
node .agents/skills/sprint-status/scripts/sprint-data.mjs --owner <owner> --project "<board title>" --timezone <IANA zone> --repo <owner/repo> [--repo <owner/repo> ...]
```

The script needs Node.js 20 or later and the GitHub CLI, and nothing else.
Tool adapters in `.claude/skills/`, `.cursor/skills/`, and `.kiro/skills/` do
not carry a copy of the script. Always run the canonical path above, and do not
reimplement the queries inline.

This prints JSON and does all the GitHub work: detects whether the owner is an
organization or a user, finds the board by its exact title, resolves which
iteration contains today's date, filters the board to items assigned to the
authenticated user, buckets them by lifecycle status, and pulls the PR review
queue for the listed repositories, or for all of the owner's with
`--all-repos`. Pass `--date YYYY-MM-DD` to report on a different sprint.

Today's date picks the sprint, and the script reads it in the time zone passed
with `--timezone`. When the sprint time zone setting is `TODO`, ask the user for
a time zone. Without `--timezone` or `--date`, the script reads the date from
the machine's clock, writes a warning to stderr, and sets `timezoneDefaulted`
to `true`. The machine's date can differ from the team's and pick the wrong
sprint.

If it exits asking for the `read:project` scope, tell the user to run
`gh auth refresh -s read:project` — do not try to work around it. If it reports
that it found no board with that title, or several, or that the board has no
iteration field, say so and point at the tracker settings. Ask the user to run
`npx agent-fleet@latest update --dry-run` and then
`npx agent-fleet@latest update` in their own terminal. The update creates or
repairs the project board on GitHub. Do not run it yourself without the user's
approval. When the user asks you to run it, follow [Updating the
installation](../../references/project-profile.md#updating-the-installation).
Do not substitute another project.

Read the JSON before writing anything. The fields that matter:

| Field | Meaning |
| --- | --- |
| `today` / `timezone` | The date that picked the sprint, and the time zone it was read in. `timezoneDefaulted` is `true` when the machine's clock decided |
| `sprint` | Active iteration, with `day` N of `duration`. `null` when no iteration contains today |
| `upcoming` | The next iterations. When `sprint` is `null` and this is empty, the board's sprints have run out: tell the user to add iterations in the board's Sprint field settings |
| `sprintItems.inProgress` / `.inReview` / `.todo` | The user's open items in this sprint |
| `sprintItems.otherStatuses` | Open items in statuses outside the lifecycle mapping, such as `Blocked` or `No status` |
| `unscheduledActive` | **Started but in no iteration** — always surface this, see §3 |
| `backlogAssigned` | Assigned, open, no iteration. Count only, unless asked |
| `<item>.subIssues` | Parent-issue progress: `total`, `completed`, `children` across repositories |
| `prs.awaitingMyReview` | Review formally requested from the user |
| `prs.mineAwaitingOthers` | The user's own open PRs |
| `prs.mentioningMe` | Open PRs mentioning the user without a review request |

Every item and PR in the JSON carries a `url`. Use it. Do not rebuild a URL from
the repository and number when the script already returned one.

## 2. Establish the code state

For every item in `inProgress`, `inReview`, and `unscheduledActive`, spend a
little effort finding out where the
code actually is. Keep it to a quick pass — the goal is one or two factual
sentences per item, not a review.

Find each item's local checkout from the `Local path` column of the routing
table in `docs/agents/issue-tracker.md`, relative to the project root. When the
table gives the default repository no local path, use the project root, which
holds `.agents/skills/`, as its checkout, but only if the root's `origin`
remote is that repository. Otherwise the repository has
no checkout. A local path of `None` also means no checkout. Report an item
whose repository has no checkout from GitHub alone.

Useful signals, cheapest first:

```bash
# Branches naming the issue number, and how far along they are
git -C <repo> branch -a --list '*<issue>*'
git -C <repo> log --oneline origin/<base>..<branch> | head
git -C <repo> status --porcelain          # uncommitted work in flight

# Issue body, when the code state needs context
gh issue view <n> --repo <owner/repo> --json body,title
```

Sub-issues are already in the JSON under each item's `subIssues` (`total`, `completed`,
and `children`, each child with its own `url`). Do not go looking for them
with `gh issue list --search 'parent-issue:...'` — that qualifier returns nothing.

The script already fetched each of the user's PRs into `detail` — branch, diff size,
`mergeable`, `reviewDecision`, `closes`, and the last comment. Use that rather than
re-querying. Each entry in `closes` carries `repo`, `number`, and `url`, and
`lastComment` carries the `url` of that comment, so both can be linked without another
query.

Ground every claim in something observed. "[app#179](https://github.com/acme/app/pull/179)
is mergeable, 8 files, awaiting a reviewer" is useful; "making good progress" is not. If an item has no branch, no PR, and
no recent commits, say it has not been started in the code yet — that is a real and
useful finding.

## 3. Judgement calls that matter

These are the things a plain board dump gets wrong. Check each one.

- **Started work outside the sprint.** `unscheduledActive` is work the user is actually
  doing that no iteration covers, so a naive sprint report misses today's real activity.
  Report it in its own section and note it is unscheduled.
- **Parent issues.** An item can sit in the started status for a while because it tracks
  sub-issues. Report progress as sub-issues completed, and say which one is live now.
- **Sub-issues outside the parent's sprint.** When a parent is in the sprint but its
  sub-issues are not, the sprint board understates the work. Flag it once.
- **Statuses outside the lifecycle.** Items in `otherStatuses`, such as `Blocked`, need a
  line each; do not drop them.
- **Stalled PRs.** A PR of the user's with no requested reviewer is not waiting on
  review — it is waiting on the user to request one. Say so, and distinguish that from
  `CONFLICTING`, which is waiting on a rebase.
- **Comment-level asks.** `prs.mentioningMe` catches PRs where someone asked the user
  something without a formal review request. Check whether the last comment is a question
  directed at them and still unanswered.
- **Co-assigned items.** When `assignees` holds more than the user, name the other person
  rather than implying sole ownership.

## 4. Report

Terminal markdown, tight, in this order. Drop any section that is empty except
**Needs your review** and **Outstanding**, which should say "nothing" explicitly.
Use the board's own status names in headings when they differ from the defaults.
When no iteration contains today, say so under the board's title instead of the
sprint heading. When `timezoneDefaulted` is `true`, say under the heading that
the machine's clock picked the sprint, because no sprint time zone was passed.

Every issue and PR reference is a markdown link to its `url`, per the
[GitHub reference rules](../../references/github-references.md).
This report is the main place the user picks up work from, so an unlinked number
here is a real cost. Link a sub-issue, comment, branch comparison, or project
board the same way whenever the report names one.

```
## <Sprint> · day N of D  (<start> → <end>)

### In progress
- **[repo#123](https://github.com/owner/repo/issues/123)** Title — code state in one or two sentences.

### In review
- **[repo#123](https://github.com/owner/repo/issues/123)** Title — where it is stuck, and on whom.

### Started, not in the sprint          ← only when unscheduledActive is non-empty
- **[repo#123](https://github.com/owner/repo/issues/123)** Title — code state, and that it is unscheduled.

### Outstanding this sprint
- **[repo#123](https://github.com/owner/repo/issues/123)** Title — not started.

### Needs your review
- **[repo#456](https://github.com/owner/repo/pull/456)** Title by author — age, size.

### Your PRs waiting on others
- **[repo#456](https://github.com/owner/repo/pull/456)** Title — reviewer or lack of one, mergeable state, last activity.
```

Close with a single line naming the one thing most worth doing next, linked. If that item is not a GitHub issue (for example, a PR), also recommend and link the GitHub issue that should be worked on next, so it can be picked up immediately with the start-issue skill. Also mention the number of assigned backlog issues outside the current sprint. If any fact cannot be established, say so rather than filling the gap.
