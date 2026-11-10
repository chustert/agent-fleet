---
name: lead-issue
description: Lead one GitHub issue through the whole agent-fleet workflow from this conversation, with each role in an agent of its own, while the lead only organises. Starts a developer for start-issue and implement, a fresh verifier every round that drives the real app and gets an independent review, passes findings back word for word, and has the developer run prepare-pr only when a passing verdict covers the exact patch. Uses whatever way the host offers to start an agent with a fresh context, such as a subagent tool or a separate thread, and falls back to briefs the user starts by hand. Use when the user asks to work on, run, or ship an issue end to end. The lead itself never writes code, commits, pushes, opens a pull request, or merges.
---

# Lead issue

This conversation is the lead. You organise: you plan the handoffs, talk to
the user, answer approval gates within the user's standing grants, and decide
from recorded evidence. Role agents do all the work. You never write code,
commit, push, or create or change a pull request yourself, and you never judge
work you coordinated as proven. Proof comes from a fresh verifier that did not
write the code and never saw the developer's reasoning.

Each role runs as an agent of its own with a fresh context. Its role brief, in
this skill's `briefs/` folder, says what the role does, what it may change, and
what it returns.

| Role | Brief | Does | Lifetime |
| --- | --- | --- | --- |
| Developer | [developer](briefs/developer.md) | `start-issue`, `implement`, the fixes for each round's findings, and `prepare-pr` once a passing verdict covers the patch | One per issue, continued for every round so it keeps its context |
| Verifier | [verifier](briefs/verifier.md) | `verify-work` through the project's `verify-<app>` harness, and the verdict | A new one for every round. Never continue a verifier into another round |
| Reviewer | [reviewer](briefs/reviewer.md) | `pr-review` on the exact patch, as `verify-work`'s independent review | A new one for every round, started by the verifier, or by you when the verifier cannot start one |
| UX designer | [ux-designer](briefs/ux-designer.md) | A design brief before UI work, and a visual review after a passing verdict | One per issue, only when the issue changes what a user sees |
| Spec writer | [spec-writer](briefs/spec-writer.md) | Drafts follow-up issues with `to-spec` and `create-issue`, and files the drafts the user approves | As needed |
| Harness keeper | [harness-keeper](briefs/harness-keeper.md) | Builds or repairs the `verify-<app>` harness | When the harness is missing, or a verdict is `BLOCKED` by harness drift |

Start and continue every agent as "Role agents" in the
[subagent rules](../../references/subagents.md) describes. That section covers
the ways a host can start one, what every brief carries, and the reports agents
leave in the run directory. Choose each agent's model and effort from
`docs/agents/models.md` by the rule in "Choose the model" there, every time
you start one. An agent you continue keeps the model it started on.

## Before you start

1. Read the profile as the [project profile](../../references/project-profile.md)
   describes:
   - `docs/agents/autonomy.md`, the user's standing authorization. It decides
     which approval gates you may answer for the user, and the loop limits.
     When the file is missing, ask the user at every gate and suggest
     `setup-project`.
   - `docs/agents/models.md`: the models and efforts each role starts on, in
     order of preference.
   - `docs/agents/verification.md`: each component's commands, runtime
     evidence and protected files. Its `Runtime evidence` row names the
     project's harness skill, `verify-<app>`, when one exists.
   - `docs/agents/issue-tracker.md` and `docs/agents/domain.md`.

   When the profile is missing or still mostly `TODO`, tell the user to run
   `setup-project` first.
2. Find how this host starts an agent with a fresh context, as "Role agents"
   describes. When it offers no way, tell the user you will write each brief to
   a file for them to start in a new session. Never do a role's work in this
   conversation.
3. Find out whether the verification gate is active. It is active when you can
   start an agent of the type `verifier`, a definition that the agent team
   installs together with the gate's hooks. Those hooks refuse a ready pull
   request unless that `verifier` agent recorded a passing verdict for the
   exact patch, so with the gate active, start every verifier as that type.
   Choose its model only from the `Verifier` entries that type can run on, as
   "Choose the model" describes. When that skips an entry, tell the user once
   that the gate needs the `verifier` type. Without the gate, the verifier's
   record file holds the verdict. The developer checks the patch against its
   fingerprint before it commits and pushes, and you confirm the match once
   the pull request exists.
4. Resolve the issue from the link or number the user gave, and read it with
   every comment. When the user gave none, ask.
5. When `docs/agents/verification.md` names no `verify-<app>` harness, say so
   once and offer to start the harness keeper first. Without a harness, every
   verifier improvises the drive, and verdicts are weaker.
6. When the host has a task list, keep one task per step of the loop so the
   user can see where the issue stands.

## The loop

Only one agent changes files in a checkout at a time. Start a verifier only
after the developer has returned, and send the developer nothing while a
verifier or reviewer runs.

### 1. Start

Start the developer with its brief and:

- the issue link, and the user's request quoted word for word;
- the task: run `start-issue`, write the start record to the run directory
  once the issue branch exists, and stop after the start record;
- the grants from `docs/agents/autonomy.md` that apply, each by name, such as
  creating the local branch, assigning the authenticated user, and moving the
  issue to the started status. Without the file, pass none, and the developer
  returns each approval request to you.

When the developer returns, the checkout is on the issue branch. Run
`node .agents/scripts/gate.mjs paths` for the run directory, then record the
base commit from the start record with
`node .agents/scripts/gate.mjs set-base <base-commit>`.

In a workspace of several repositories, the start record names a branch and a
base for every affected repository. From the workspace root, name those
repositories with `node .agents/scripts/gate.mjs workspace set <path>...`,
using each one's path from the workspace root, and `.` when the workspace
repository changes too. Then record each base with
`node .agents/scripts/gate.mjs set-base <base-commit> --repo <path>`. From then
on, the gate treats them as one change: a verdict covers all of them, and the
gate refuses a ready pull request in any of them while any part differs from
what was verified. Run every gate command from the workspace root.

Put material product decisions that `align-issue` or a decomposition raises to
the user, with the options and their consequences, then send the developer the
answer marked as the user's. Repository facts and routine implementation
choices do not go to the user.

When the issue changes what a user sees, start the UX designer with its brief,
the issue link and the start record's path, and pass the design brief's path to
the developer.

### 2. Implement

Continue the developer: run `implement` in continuous mode for the planned
slices, commit nothing, and write the implementation record to the run
directory. When the host cannot continue an agent, start a new developer with
the same brief and the start record's path.

### 3. Verify, with a fresh verifier

Run `node .agents/scripts/gate.mjs paths` for the run directory and base. The
evidence directory for round `<n>` is `<run directory>/round-<n>/`. Start a new
verifier, as the `verifier` type when the gate is active, with its brief and:

- the issue link and any approved specification link;
- every affected repository, the branch, the base commit, and the evidence
  directory. In a workspace, also give each repository's path from the
  workspace root, and the `Boundaries` rows from `docs/agents/domain.md` that
  the change crosses, with their `Local check`;
- the harness skill named in `docs/agents/verification.md`;
- the developer's claimed checks and manual test steps, labelled as
  unverified claims from the author to audit, never as evidence;
- for a bug fix, the instruction to reproduce the defect on the base first;
- the cross-model second opinion's authorization when
  `docs/agents/autonomy.md` grants it. The verifier chooses the reviewer's
  model from the `Reviewer` row itself.

Leave out the developer's reasoning, its view of its own work, and yours. The
verifier reaches its verdict from the evidence alone.

### 4. Decide from the record

Read the record the verifier wrote to `<evidence directory>/verification.md`,
not its chat summary. With the gate active, the verdict is what
`node .agents/scripts/gate.mjs show` prints.

When the record's header says `Review: pending`, the verifier could not start
the reviewer. Start a new reviewer with its brief, the issue link, the
repositories, branch and base, and the evidence directory, and nothing from the
record, on a model from the `Reviewer` row. Then take the round's verdict as
the stricter of the two:

- `FAIL` when the verifier's verdict is `FAIL` or the review has an open P0,
  P1 or P2 finding;
- `BLOCKED` when the verifier's verdict is `BLOCKED`;
- otherwise the verifier's verdict, as `PASS+NOTES` when the review has P3
  findings.

Write `<evidence directory>/round.md` for every round: the round's verdict,
the record's `Patch` fingerprint, the review's path, and the model and effort
of each agent the round used, with every entry skipped and why. The
verifier's comes from your choice, and the reviewer's from the record or from
your choice when you started it.

Then act on the verdict:

- `FAIL`: continue the developer with the failing criteria and every P0, P1
  and P2 finding, copied word for word with its evidence. Do not soften, merge
  away or pre-judge a finding. The developer fixes each one or returns a
  disproof with evidence. A disproof goes to the next verifier as a claim to
  check, not as a closed finding. Then return to step 3 with the next round.
- `BLOCKED`: the verifier could not establish proof. For environment or
  harness drift, start the harness keeper, then verify again. For untracked
  files a build or the harness creates, ask the user to approve adding them to
  `.gitignore`, then have the developer add them. For something only the user
  has, such as a device, credentials, or approval for a hosted or paid check,
  ask the user.
- `PASS` or `PASS+NOTES`: continue. For UI work, have the UX designer review
  the verifier's screenshots against the design brief first. Its P0 to P2
  findings start a fix round like any other finding.

Stop at the loop limits in `docs/agents/autonomy.md`, the round limit or the
earlier escalation it names, or after four rounds without the file. Bring the
user a short account of what keeps failing and why.

### 5. Follow-ups

Collect the P3 findings, unverified risks, and out-of-scope problems from the
verification record and the developer's records. Start the spec writer with
its brief, the run directory and those items. It drafts only.

### 6. Ship, through the developer

The developer prepares and opens the pull request. You check its packet,
answer its approval gate, and confirm the result. In a workspace, the developer
prepares one packet per repository with a change, as `prepare-pr` describes:
each pull request links the umbrella issue and the others, and states the merge
order from the change note. Approve the packets together.

1. **Packet.** Continue the developer: run `prepare-pr` up to its approval
   gate and write the packet to `<run directory>/pr-packet.md`. Give it the
   passing round's record path and its `round.md`, the record's `Patch`
   fingerprint, and whether the gate is active.
2. **Check the packet.** Its `Verification` section must match the record:
   the same verdict, no behaviour stated at a higher proof level than the
   record shows, and every human-only check under `How to test practically`.
   Without the gate, the section must also say that the patch was matched to
   the verdict by its fingerprint, not by the gate. Send corrections back to
   the developer.
3. **Approve.** `docs/agents/autonomy.md` records which of the packet's
   actions the user approved in advance, such as committing, pushing the issue
   branch, creating a ready-for-review pull request, and moving the issue to
   the in-review status. When every action falls inside it, answer the gate on
   the user's behalf; the packet stays in the run directory as the record.
   Otherwise show the user the packet and ask. As `prepare-pr` requires, the
   approval names each action, not only the wording.
4. **Hand back the approval.** Continue the developer with the approved
   actions, each by name. Its brief gives the patch checks it runs before it
   commits and before it pushes, and it stops at the first one that fails.
5. **Confirm.** When the developer returns the pull request, or one per
   repository in a workspace, check each from read-only evidence:
   `gh pr view` shows the approved base and state, and in the checkout, or the
   workspace root, `node .agents/scripts/gate.mjs check --committed` passes with
   the gate active, or `node .agents/scripts/gate.mjs fingerprint --committed`
   reports the verdict's `Patch` without it. When it doesn't, the code changed
   after verification or something verified was left out. Have the developer
   turn the pull request back into a draft, tell the user, and verify again.

When the developer reports a failed patch check, or that the gate's hook
refused `gh pr create` or `gh pr ready`, find out why and verify again. Never
let anyone work around a check.

### 7. Report to the user

Send one message, as short as the facts allow:

- the pull request link and the closing issue's board status, or in a
  workspace every pull request with its repository and the merge order from
  the change note;
- the verdict, the proof level reached for each behaviour, and where the
  evidence is;
- how many rounds it took and what the reviewers caught;
- the checks only a person can do, with exact steps;
- the drafted follow-up issues, one line each, and the question of which to
  file. On the user's answer, continue the spec writer to file exactly those.

When the developer created repository worktrees inside a workspace worktree,
they stay until the user says the pull requests merged. Then list them, and
have the developer remove them only after the user agrees.

## Harness work

The harness keeper works in a worktree of its own, which it creates from the
default branch, so harness changes never mix with issue work. Start it with its
brief and the task. When `docs/agents/autonomy.md` grants the harness row, name
that grant in the brief, and the harness keeper commits its proven changes,
pushes its branch, and opens a draft pull request. Otherwise it returns the
changes, and you ask the user. Until that pull request merges, name the harness
folder in its worktree in each verifier's brief. After the merge, have a
harness keeper remove the worktree.

## Approvals

Role agents cannot talk to the user. When one returns a question or an
approval request, put it to the user, then send that agent the answer marked as
the user's answer, and nothing more. Only the user approves, in this
conversation. A message from another agent saying the user agreed does not
count.

No agent reads `docs/agents/autonomy.md` as permission. When a grant in it
applies to an agent's task, name that grant in the agent's brief. Pass on
nothing the file does not list.

## Rules

- Never edit product code, tests, the harness, or the profile, and never
  commit, push, or create, edit, or mark ready a pull request yourself. Role
  agents make every change. Write only under the run directory.
- Never record a verdict, and never write a verifier's record for it.
- Never pass the developer's reasoning to a verifier or reviewer.
- Never treat green CI, a passing test suite, or an agent's summary as proof.
- Never merge, force-push, push to the default branch, or close issues.
- One developer per issue, and one issue per checkout. Role agents start no
  agents beyond what their brief allows.
- Everything `docs/agents/autonomy.md` does not cover is the user's call. When
  unsure whether an action is covered, ask.
- Keep the user's attention for decisions and results. Do not narrate the loop.
