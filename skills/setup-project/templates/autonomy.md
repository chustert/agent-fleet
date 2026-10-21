# Autonomy policy

The engineering lead in `.claude/agents/engineering-lead.md` reads this file. It is the user's standing authorization for the agent team: the workflow skills stop at approval gates and ask the user, and the lead answers a gate on the user's behalf only for an action the `The lead may` table lists. Everything else goes to the user. Subagents never read this file as permission; the lead names the specific grant in a subagent's brief.

Without this file, the lead asks the user at every gate. `setup-project` writes it from this template after the user confirms each row. Edit it to give the team more or less room. `TODO` marks a value nobody has confirmed. `None` means the project deliberately does without it.

## The lead may

| Action | Conditions |
| --- | --- |
| Start an issue: create the local branch, assign the authenticated user, move the issue to the started status | As `start-issue` describes |
| Local edits on the issue branch, through the developer | Within the issue's scope |
| Local verification: builds, tests, the `verify-<app>` harness, local services, seeded disposable data | Never against hosted, staging or production systems |
| Commit to the issue branch | Only content the latest verdict covers; `node .agents/scripts/gate.mjs check --committed` must pass before pushing |
| Push the issue branch to `origin` | Normal push; never force, never the default branch |
| Open a draft pull request | Any time, so CI runs alongside the work |
| Create a ready-for-review pull request, or mark a draft ready | Only when `node .agents/scripts/gate.mjs check --committed` passes and the commit is pushed. The packet is saved to the run directory as the record |
| Move the closing issue to the in-review status | After the ready pull request is created, as `prepare-pr` describes |
| Draft issues with the spec writer | Drafts only; filing needs the user |
| Send the patch for the cross-model second opinion | Only through `.agents/scripts/second-opinion.mjs`, which leaves protected files out, and only when the `Command` row below names a command |
| Commit, push and open a draft pull request for harness changes | Only `harness-keeper`'s proven changes to the `verify-<app>` skill folder and its adapters, on a `chore/harness-*` branch. Never ready for review: the user reviews and merges |

## Always ask the user

- Filing, editing or closing a GitHub issue, beyond the assignment and status change of a start. `.claude/settings.json` also asks before `gh issue create`.
- Product decisions that `align-issue` or a decomposition raises.
- Merging a pull request. The user merges.
- Any hosted, staging, production or paid service, including sandboxes that send real messages or cost money.
- Installing, adding or upgrading a dependency the issue doesn't require.
- Changes to CI, branch protection, or any check: disabling, skipping or loosening a test, lint rule or gate.
- Edits to `docs/agents/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, or the files `.agents/agent-fleet.json` records, except the harness pull requests above.
- Anything irreversible: deleting branches, rewriting pushed history, migrations against a non-local database, publishing a release or package.
- Opening, printing or copying a protected file.

## Loop limits

| Setting | Value |
| --- | --- |
| Fix rounds | 4. After this many verification rounds without a pass, the lead escalates to the user. |
| Escalate early | When the same finding fails two rounds in a row, or a verdict is `BLOCKED` twice. |
| Issues at once | 1 per checkout. Use a Git worktree, with its own lead, for each further issue. |

## Cross-model review

The reviewer asks a model from another family for a second opinion through `.agents/scripts/second-opinion.mjs`, which reads the `Command` row. The command must run read-only. The script sets `PROMPT`, the review request, which names the patch file, and `OUT`, the file the reply must end up in, and runs the command from the repository root in a POSIX shell.

| Setting | Value |
| --- | --- |
| Second model | TODO: the model family and CLI, or `None` for single-model reviews. |
| Command | TODO: such as `<cli> exec -o "$OUT" "$PROMPT"`, or `None`. |
