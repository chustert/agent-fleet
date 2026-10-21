---
name: repos-report
description: Report every local branch and worktree in each of the project's local repositories, opening with icon-coded at-a-glance tables per repository, then grouped into active work, empty issue branches, other people's work, and dormant branches that are safe to remove or need a decision, plus a map of where each open sprint issue lives locally. Use when the user asks which branches or worktrees are active or dormant, where an issue is being worked on, or what can be cleaned up. It fetches and prunes remote-tracking refs in each clone unless run with --no-fetch, and changes no local branch, worktree, or working-tree file.
allowed-tools: Bash, Read, Grep, Glob
---

# Repos report

Produces the same structured overview every time: for each local repository,
which branches and worktrees hold live work and which are dormant, and for each
open sprint issue on the board named in `docs/agents/issue-tracker.md`, where
its code lives. Every report opens with the icon-coded **At a glance** tables,
and the same icons mark every later section.

## 1. Collect the data

Read the tracker settings and the routing table in
`docs/agents/issue-tracker.md`, following the
[rules for reading the profile](../../references/project-profile.md), and map
them to flags:

| Tracker setting | Flag |
| --- | --- |
| Each `Local path` in the routing table, except `None` | `--path <local path>`, repeated |
| Project board owner | `--owner <owner>` |
| Project board title | `--project "<exact title>"` |
| Status field | `--status-field "<name>"`, when it is not `Status` |
| Iteration field | `--iteration-field "<name>"`, when the board has several |
| Lifecycle statuses | `--todo-status`, `--started-status`, `--review-status`, `--done-status`, when they differ from `Todo`, `In progress`, `In review`, and `Done` |
| Sprint time zone | `--timezone <IANA zone>`, on every run |

The board is required: if the settings name none, say so and ask the user to
run `npx agent-fleet@latest update --dry-run` and then
`npx agent-fleet@latest update` in their own terminal. The update creates or
repairs the project board on GitHub. Do not run it yourself without the user's
approval. When the user asks you to run it, follow [Updating the
installation](../../references/project-profile.md#updating-the-installation).
If another value the command needs is still `TODO`, say so and recommend
`setup-project` rather than guessing. When the routing table has no local paths
yet, omit `--path`. The script then reports on the project root's repository
alone, and the report says that other clones may be missing.

Run the script that ships with this skill, from the project root. Save the
JSON, then render the at-a-glance tables from it, so the data is collected only
once:

```bash
node .agents/skills/repos-report/scripts/repos-data.mjs --owner <owner> --project "<board title>" --timezone <IANA zone> [--path <local path> ...] > /tmp/repos-report.json
node .agents/skills/repos-report/scripts/repos-data.mjs --from-json /tmp/repos-report.json --format overview
```

The script needs Node.js 20 or later, Git, and the GitHub CLI, and nothing
else. Tool adapters in `.claude/skills/`, `.cursor/skills/`, and
`.kiro/skills/` do not carry a copy of the script. Always run the canonical path
above, and do not reimplement the queries inline. The script imports the
sibling `sprint-status/scripts/sprint-data.mjs` for the board, so keep both
canonical skill directories together.

A path inside a repository counts as that repository, so components that share
one clone produce one section. By default the script runs `git fetch --prune`
in each clone, which updates its remote-tracking refs and deletes those whose
branch is gone from GitHub. When a merged PR's head commit is missing locally,
it also fetches `refs/pull/<n>/head`. Neither fetch changes a local branch, a
worktree, or a file in a checkout. `--no-fetch` skips both.

Flags:

| Flag | Use |
| --- | --- |
| `--no-fetch` | Skip every fetch, for example offline. Say in the report that remote state may be stale |
| `--active-days N` | Unmerged commits newer than N days count as active (default 14) |
| `--no-sprint` | Skip the issue map, when the user asks only about branches. Needs no board flags |
| `--date YYYY-MM-DD` | Map the issues of the sprint that contains this date |

Today's date picks the sprint and the active window, and the script reads it in
the time zone passed with `--timezone`. When the sprint time zone setting is
`TODO`, ask the user for a time zone. Without `--timezone` or `--date`, the
script reads the date from the machine's clock, writes a warning to stderr, and
sets `timezoneDefaulted` to `true`. Say so in the report, because the machine's
date can differ from the team's and pick the wrong sprint.

When `sprint.error` asks for the `read:project` scope, tell the user to run
`gh auth refresh -s read:project`. When it says the board is missing, is
ambiguous, or has no iteration field, ask the user to run
`npx agent-fleet@latest update --dry-run` and then
`npx agent-fleet@latest update` in their own terminal. The update creates or
repairs the project board on GitHub. Do not run it yourself without the user's
approval. When the user asks you to run it, follow [Updating the
installation](../../references/project-profile.md#updating-the-installation).
Either way, write the report without the issue map and say why it is missing.

## 2. Read the JSON

| Field | Meaning |
| --- | --- |
| `repositories[]` | One per clone, in report order |
| `.rootCheckout` | Branch and uncommitted-file count of the clone's own checkout |
| `.localDefaultBehind` | How far the local default branch trails `origin` |
| `.entries[]` | One per local branch, plus one per detached or missing worktree |
| `.openPrsNotLocal` | Open PRs in that repository with no local branch or worktree |
| `skippedRepositories` | Paths from `--path` that are not in a Git checkout. Name them in the report |
| `sprint.issues[]` | Open sprint items assigned to the user, plus started items outside the sprint (`unscheduled`) |
| `sprint.issues[].locations` | Local branches named after the issue or one of its open sub-issues, or whose open PR closes one |

Each entry carries `category`, and `reasons` with the facts behind it:
uncommitted files, unpushed commits, "local only", a closed PR, a stale local
copy. `pr` is the branch's PR, `reviewOf` the PR a review checkout such as
`review/pr-189` points at, `issue` the open issue named in the branch, and
`worktree` its checkout with `display` path and `dirty` count.

| Icon | Category | Meaning | Report section |
| --- | --- | --- | --- |
| 🟢 | `active` | Yours: uncommitted changes, your open PR, or your unmerged commits within the active window | Active |
| 🟡 | `placeholder` | No commits of its own, named after an open issue | Created for an issue but still empty |
| 🔵 | `others` | Someone else's open PR, or their recent unmerged commits | Other people's open work you have locally |
| ⚪ | `merged` | Its PR merged and holds every commit on the branch, checked against the PR head so squash merges count | Dormant, safe to remove |
| ⚪ | `empty` | No commits of its own and no open issue behind it | Dormant, safe to remove |
| ⚫ | `missing` | Worktree folder is gone; Git lists it as prunable | Dormant, safe to remove |
| 🟠 | `unmerged` | Commits that never merged and are older than the window, a closed PR, or a merge that could not be verified | Dormant and never merged |

🏠 marks a clone's own checkout when it sits on the default branch. The icons
come from `ICONS` in `scripts/repos-data.mjs`. Change them there and in this
table together.

Use the categories as given. Do not re-sort entries by ahead or behind counts.
Those counts overstate squash-merged branches, and the script has already
checked them.

## 3. Judgement calls

- **Empty branch without an issue number.** An `empty` branch in a worktree,
  such as `feature/new-onboarding`, can move to "Created for an issue but still
  empty" only when evidence ties it to an open issue: the issue body or a
  comment names the branch, or a sprint issue plainly describes it. State the
  evidence. Otherwise leave it dormant.
- **The clone's own checkout.** It cannot be removed. When its branch is
  `merged` or `empty`, say to switch it back to the default branch instead.
- **Two branches on one commit.** When entries share `head`, say which one
  duplicates the other, for example a local-only branch sitting on an open PR's
  commit.
- **Stale local copies.** A reason like "local copy 20 commits behind its
  upstream" means the branch is live on GitHub but the local copy is old. Say to
  pull it before use.
- **Unpushed commits.** Bold any unpushed or local-only commits in a dormant
  entry, because deleting that branch loses them.
- **Issue rows with no location.** Write "none" and give the code state from
  what is already known: the issue's linked PRs, or its last comment when
  needed. For a repository with no local clone (`localClone` false), say so.
  Keep it to one quick `gh issue view` per row.
- **Co-assigned issues.** Name the other assignees rather than implying sole
  ownership.

## 4. Report

Terminal markdown in exactly this structure.

**At a glance is mandatory.** Every report includes it, including one limited
by `--path`, run with `--no-fetch`, or missing the issue map. Paste the
`--format overview` output verbatim, legend included. Do not edit, reorder, or
re-render its rows, and never draw the tables by hand. If the render command
fails, show its error in place of the section and say the report is incomplete.
The section gives one row per checkout and per branch with live work, and
collapses dormant branches with no worktree into counts that the per-repository
sections below expand.

**Use the same icons everywhere.** Prefix each per-repository subsection
heading with its category icon, as in the template. In the issue map, give each
row the icon of its most active location, in the order 🟢 🔵 🟡 🟠 ⚪ ⚫, or ➖ when
it has no local location. Use no other icons, so each one keeps a single
meaning.

Every issue and PR named is a markdown link to the `url` in the JSON, per the
[GitHub reference rules](../../references/github-references.md). The bulk lists
of dormant branches name branches only, so they need no links.

Within a repository section, keep **Active** even when empty and write
"nothing". Drop any other empty subsection. Show worktree paths with `display`.
When many share a parent folder, name the folder once and list the folder names.

```
<Two or three sentences: where real work is in flight, and how much is removable.>

Branches are sorted by PR state, not ahead/behind counts, because squash merges make
merged branches still look "ahead" of the default branch. No local branch, worktree, or file has
been removed or changed.

<At a glance: the --format overview output, verbatim.>

## Where each open issue lives

| | Issue | Status | Location | Code state |
|---|---|---|---|---|
| 🟢 | [repo#N](https://github.com/owner/repo/issues/N) Title | In progress / In review / Todo; "not in the sprint" when unscheduled | worktree path or branch, or "none" | uncommitted files, commits, PR, or "not started" |

---

## <repository name>

**🟢 Active:** <table, or "nothing".> <One line on the root checkout: its branch, and how
far the local default branch is behind.>

| Location | Branch | Issue | State |
|---|---|---|---|

**🟡 Created for an issue but still empty:**
- `<worktree>` → `<branch>`, for [repo#N](https://github.com/owner/repo/issues/N). <commits and base>

**🔵 Other people's open work you have locally:**
| Location | Branch | State |
|---|---|---|
<Then one line on open PRs in this repository that are not checked out locally.>

**⚪ Dormant worktrees (safe to remove):** <⚫ in the first column for a missing folder>
| | Worktree | Branch | PR / notes |
|---|---|---|---|

**⚪ Dormant branches with no worktree, PR merged (N):** `a`, `b`, …
**⚪ Dormant branches with no commits of their own:** `c`, …

**🟠 Dormant and never merged (you need to decide on these before deleting):**
| Branch | Owner | Last commit | Notes |
|---|---|---|---|

---

**Cleanup:** <What could be removed, counted per repository: merged and empty
worktrees, missing worktrees to prune, merged branches. Name what to keep until the
user decides, above all any branch with unpushed commits.>
```

Apart from the fetch, this skill only reports. Removing a worktree or branch
needs the user's separate, explicit approval. When they give it, use
non-forcing commands (`git worktree remove`, `git worktree prune`,
`git branch -d`). Stop and report any refusal rather than retrying with
`--force` or `-D`.
