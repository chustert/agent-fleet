---
name: prepare-pr
description: Inspect a Git branch, assess review readiness, and draft a GitHub pull request title and body behind an explicit user-approval gate, then synchronize the closing issue's review status after an approved ready PR is created. Use when the user asks to prepare, draft, or create a PR; do not use for reviewing someone else's PR.
---

# Prepare PR

Prepare a human-reviewable pull request in two distinct stages. Never create or
update a PR until the user has seen the complete proposed title and description
and explicitly approved them.

## Stage 1: Prepare without creating

Do not commit, push, create a PR, or update an existing PR during this stage
unless the user separately and explicitly authorized that exact action.

### Establish the exact change

1. Read the applicable repository instructions, with any nested instructions
   for the changed paths, and the documents in the reading order of
   `docs/agents/domain.md`, including the guide or `README.md` for each
   affected component. Also read the routing table and default base branch in
   `docs/agents/issue-tracker.md`, and each affected component's settings in
   `docs/agents/verification.md`. Handle a missing profile file, or a `TODO`
   or `None` value, as the
   [project profile](../../references/project-profile.md) describes.
2. Identify the repository, remote, current branch, intended base branch, and
   whether the repositories involved have independent Git histories. The base
   is the default base branch from the tracker settings unless the user names
   another.
3. Inspect status, commits, and the complete diff against the intended base.
   Preserve unrelated or pre-existing work.
4. Resolve the linked issue, or its parent or umbrella issue, when supplied.
   Read its current description and acceptance criteria using an available
   GitHub API or CLI.
5. Check whether the branch already has an open or draft PR. Never create a
   duplicate; prepare an update behind the same approval gate instead.
6. Stop if the base and head are the same, the diff is empty, the branch is
   ambiguous, or unrelated changes make the proposed PR boundary unsafe.
7. Reconfirm the remote repository, intended base branch, merge base, head, and
   exact diff range. Include committed, staged, unstaged, and relevant untracked
   files in the assessment so the proposed PR neither omits intended work nor
   silently absorbs unrelated changes.

### Multiple repositories

- Treat repositories with independent Git histories as independent PR
  boundaries. For coordinated work across repositories, prepare one PR packet
  per repository, obtain approval for each packet, and commit, push, and create
  each PR from within its owning repository.
- Cross-link companion work through the shared umbrella issue and any existing
  companion issue or PR URLs. State compatibility, dependency, and rollout
  order in each PR. Never invent a future PR URL. If reciprocal PR links require
  updating the first PR after the second exists, include that later PR-body
  update in the approval packet before performing it.
- In a coordination workspace, create a PR for the workspace repository only
  when that repository itself has a relevant diff. Changes inside independent
  child repositories do not justify an empty parent PR.
- Do not create a PR for any repository with no relevant change. Do not combine
  independent histories into one commit or PR.

### Changes that cross a boundary

- When the diff changes a boundary between parts that ship or version
  separately, include the change note from `cross-boundary-contract` in the
  PR's `Notes` section, or the required note the contracts document in
  `docs/agents/domain.md` defines: the contract before and after, the version
  combinations that must keep working, the rollout and rollback order, and any
  migration, backfill, reindex, data conversion, environment variable, or
  release it needs.
- State what merging triggers for each affected component, as its `Deploys`
  row in `docs/agents/verification.md` records, such as an automatic
  deployment. Also state which steps merging does not perform, such as applying
  a migration to a hosted database, submitting an app build, or publishing a
  package. Do not perform those steps as part of this skill.
- Recommend splitting the PR when a migration, the code that uses it, and a
  later cleanup cannot safely ship together.

### Assess review readiness

- Summarize changed-file count, additions/deletions, migrations, generated,
  binary, asset, or lock files, and distinct concerns. Flag a PR that mixes
  independently useful changes or is difficult to review, and recommend a split
  before creation. Do not block solely on an arbitrary line-count threshold.
- Check that the implementation matches the issue and that documentation,
  tests, migration notes, compatibility, rollout, and rollback are addressed
  where relevant. Judge the documentation against the guides read in step 1,
  and flag any guide whose description of behaviour, commands, or setup the
  diff makes wrong.
- Run safe, relevant local verification from `docs/agents/verification.md` in
  proportion to risk. Ask before destructive resets, hosted-environment tests,
  deployments, or other external state changes. Never claim an unrun check
  passed.
- Record the commands, results, and code state covered by verification. Final
  test evidence must apply to the exact content proposed for the PR, including
  any relevant generated, migration, lock, or documentation changes.
- Do not install dependencies, expose protected files, rewrite history,
  force-push, or clean unrelated changes as part of preparation.
- If a check changes files, report those files and include them in the readiness
  assessment instead of silently discarding them.

### Draft the PR

Propose all of the following in one review packet:

- repository and base <- head branches;
- PR title;
- draft or ready-for-review status, with a short reason;
- issue links and whether each one closes or is only related;
- changed-file/addition/deletion summary and any split recommendation;
- commit and push status, including the exact actions still required;
- complete PR description using the repository's template or the default below;
- an outcome-focused summary, issue links, verification evidence, compatibility
  and rollout notes, known limitations, and practical reviewer instructions;
- any suggested labels, reviewers, or companion PRs, without applying them;
- the exact actions that approval will authorize, including moving each issue
  closed by a ready-for-review PR to the in-review status on the board the
  tracker settings name.

Do not add or require screenshots, screen recordings, or empty visual-evidence
sections as part of the PR body prepared by this skill, unless the repository's
own template requires them.

Use `Closes` only when this PR fully satisfies that issue and GitHub can resolve
the exact repository-qualified reference. Use `Part of` for a parent or umbrella
issue or a larger initiative. Never invent an issue number or imply automatic
closure for partially completed work.

Write an outcome-focused description, not a list of commit subjects. Record
only verification actually performed. Put pending reviewer steps under
`How to test practically`, with prerequisites, actions, expected outcomes,
negative or regression scenarios when relevant, and cleanup if testing changes
local data. For work that needs a device, target hardware, or a play-test, give
the reviewer those steps with the expected observation.

Keep each prose paragraph, bullet, checklist item, and numbered step on one
physical line in the Markdown source. Do not hard-wrap PR body text to a fixed
column width. Use source line breaks only for Markdown structure, such as
headings, blank lines, separate list items, and code blocks, or when a deliberate
hard line break is part of the content. Let GitHub wrap long lines for the
reader's viewport.

When the repository has its own pull-request template, such as
`.github/pull_request_template.md` or a file in `.github/PULL_REQUEST_TEMPLATE/`,
fill in that template's sections and leave out its instruction comments.
Otherwise use this default:

```markdown
## Summary

<!-- If applicable: -->
Closes #XXX
Part of #XXX

<!-- Briefly summarise what this PR does. -->

## Why

<!-- Describe why we have this PR. -->

## Changes

-
-
-

## Verification

- [x] <!-- Check actually run and passed -->
- [ ] <!-- Check not run or still requiring a reviewer -->

## How to test practically

<!-- Walk the reviewer through prerequisites, the happy path, relevant permission/error/regression scenarios, expected results, and cleanup. -->

## Notes

<!-- Review hotspots, deliberate non-goals, compatibility, migrations, rollout/rollback, companion PRs, or decisions that are not obvious. -->
<!-- State relevant known limitations explicitly. -->
```

After presenting the packet, stop and ask the user to approve or amend it. A
general earlier request to work on the feature is not approval to create the PR.
The approval request must name committing, pushing, and running `gh pr create`
as separate proposed actions when each is required. One consolidated response
may authorize all named actions, but approval of the PR wording alone does not.

## Stage 2: Create only after approval

Treat approval as authorization only for the exact actions listed in the review
packet. If committing or pushing is required, perform it only when it was
explicitly included in that approved action list or separately authorized.
Do not commit, push, or run `gh pr create` unless the latest approval explicitly
authorizes that applicable action for the exact repository and PR packet.

Immediately before creating or updating the PR:

1. Recheck the remote repository, intended base branch, merge base, head,
   status, exact diff range, and existing PR state. Ensure unrelated work is
   still excluded.
2. Confirm the proposed title and description still match the current head. If
   code, commits, verification, issue scope, or branch state changed materially,
   regenerate the packet and obtain approval again.
3. Confirm that every required verification result applies to the exact content
   that will be committed. Rerun required checks if the implementation changed
   after verification, results are stale, or repository instructions require a
   final run. A commit that only records the already verified staged content
   does not by itself require duplicating an expensive test run.
4. Ensure all intended changes are committed and the approved head branch is on
   the expected remote. Push normally and set upstream if needed; never
   force-push unless the user separately requests it.
5. Write the approved body to a temporary file outside the repository and use
   that file with the GitHub CLI or API to avoid shell-quoting corruption.
6. Create the PR against the approved base in the approved draft/ready state.
   Do not add labels, reviewers, assignees, milestones, or issue comments unless
   explicitly authorized.
7. Read the created PR back from GitHub and verify its number, URL, repository,
   base, head, title, body, draft/ready status, and the absence of accidental
   hard-wrapped lines in prose and list items.
8. When the verified PR is ready for review, move each issue named by an
   approved closing reference such as `Closes` to the option mapped to the
   in-review lifecycle role, usually `In review`, on the board the tracker
   settings name. Resolve the project item, status field, and
   option from GitHub instead of hard-coding identifiers. Read the current
   status first; if it is already the in-review status, verify it without
   issuing a redundant update. Do not change parent, umbrella, or related-only
   issues referenced with `Part of`, and do not change issue status for a draft
   PR. If the closing issue is not on the configured board, appears on several
   applicable boards, has no in-review option, or cannot be updated, stop rather
   than adding it to a board or guessing; report the unresolved status clearly
   while keeping the verified PR intact. If the settings name no board, or
   GitHub no longer has it, say so and ask the user to run
   `npx agent-fleet@latest update --dry-run` and then
   `npx agent-fleet@latest update` in their own terminal. The update creates or
   repairs the project board on GitHub. Do not run it yourself without the
   user's approval. When the user asks you to run it, follow [Updating the
   installation](../../references/project-profile.md#updating-the-installation).

If creation fails or GitHub reports an existing PR, do not retry in a way that
could create duplicates. Report the exact state and propose the smallest next
step.

## Handoff

Always reply with a clickable link to the verified PR, formed as the
[GitHub reference rules](../../references/github-references.md) specify, and
state its number and draft/ready status. Link each closing issue, companion PR,
and parent or umbrella issue the reply names. In the PR body itself, use the
plain `#number` or `owner/repo#number` autolink instead.

For a ready PR, also name each closing issue and confirm that its board status
is the in-review status, or why that transition
could not be completed. If the user asked to open or show the PR and an
appropriate browser/page-opening capability is available, open the verified URL
as well; the link in the response is still required.

Do not merge, approve, request changes, mark ready, close, or delete the PR as
part of this skill unless the user explicitly asks for that separate action.
After the PR is created and verified and any approved closing-issue status is
synchronized, report the handoff and stop. Do not merge locally or remotely,
rebase after creation, delete the local or remote branch, or clean unrelated
working-tree changes unless the user separately requests that action.
