# Subagents

A subagent is a separate agent that the host starts with a fresh context. It
sees only the brief it is given, does one task, and returns a report. It never
sees the conversation, the parent's reasoning, or the code the parent wrote and
then discarded.

That fresh context is the point. A reviewer that watched the code being written
already holds the author's reasons, so it tends to repeat them. A researcher
that shares the drafter's context tends to confirm the draft. A subagent starts
from the evidence alone.

Skills that use subagents link this file instead of restating it. Use a
subagent only where a skill says to. Every subagent starts cold and reads its
context again, so it costs more than doing the work inline.

| Skill | Subagent task |
| --- | --- |
| `verify-work` | Run `pr-review` against the verified diff, without the verification's conclusions. |
| `pr-review` | Review one area of a large diff for engineering standards, while the parent owns the whole-diff checks. |
| `create-issue` | Check the factual claims a draft adds against the project's code and records. |
| `prepare-pr` | Pick the pull request's risk tier from the diff, as the [risk tiers](pr-risk-tiers.md) define. |

The tasks in this table are read-only. `lead-issue` also starts agents for
whole roles, such as a developer that edits the issue branch.
[Role agents](#role-agents) describes how those differ.

## Check that the host can start one

Apply these rules by capability, not by tool name. The host may call the
capability an agent, a subagent, a task, or something else. Use it only when
it gives the new agent a fresh context and returns the agent's report to you.

Do the work inline instead when:

- the host cannot start a subagent with a fresh context;
- you are a subagent yourself and the host does not let subagents start more;
- the user asked you not to use subagents; or
- the skill that would start one forbids it.

When a skill asks for an independent result and you do the work inline, say so
in the report. Do not describe inline work as independent.

## Choose the model

Before you start any agent, a helper subagent or a role agent, choose its model
and effort from `docs/agents/models.md`. The rule is the same for every skill,
so the same file gives the same choice on every run:

1. **Find the row.** A role agent uses its role's row. A helper subagent uses
   the row the skill names; the independent review in `verify-work` and
   `pr-review` uses `Reviewer`. When the file or the row is missing, the row
   is `Same as the lead`.
2. **Find what the host can start now.** Read the models and efforts from the
   host's own list, such as a capabilities or model listing, for every way it
   offers to start an agent. Do not decide from memory or from the model's
   name alone. An entry is available when one of those ways can start that
   exact model at that exact effort. A way that takes only a model family
   matches an entry that names a version only when the host shows which
   version the family starts.
3. **Take the first available entry**, in the row's order. Never use a model
   or an effort the row does not list: another version, a nearby effort, or a
   similar model is not a match.
4. **When nothing is available,** use your own model and effort if the row
   ends with `Same as the lead`. Otherwise stop and ask the user which model to
   use, and start nothing on a guess.
5. **When the agent must run as a project agent type,** as `lead-issue`
   requires of the verifier while the verification gate is active, consider
   only the entries that type can run on, in the same order.
6. **Record the choice.** Put the model and effort you started the agent on,
   and each earlier entry you skipped with the reason, in the record the skill
   keeps for that work. When you skipped the row's first entry, tell the user
   once per run.

Start the agent the way that can run the chosen entry, as
[Role agents](#role-agents) describes. When the user starts it, name the model
and effort in your request. When you do the work inline because the host
cannot start an agent, the row does not apply; say in the report that the work
ran inline on your own model.

## Write a self-contained brief

The subagent knows only what the brief says. Write it so that an engineer who
has never seen the conversation could do the task from it alone:

1. The task, the skill to follow, and where the task stops. Name the skill and
   its file, such as `.agents/skills/pr-review/SKILL.md`.
2. The exact scope: each repository, the base ref and commit, the head commit
   or worktree path, and the paths included and excluded.
3. The sources to read: the issue or specification as a GitHub link, the
   profile files in `docs/agents/`, and any file the task depends on.
4. The evidence already gathered that the subagent may reuse, such as commands
   run and their results, with enough detail to check its relevance.
5. The limits from the next section.
6. The shape of the report you need back.

Leave out whatever would steer the result. For an independent review, that
means your own view of the code, the verdicts you reached, and the reasons the
code was written as it was. For research, it means the answer you expect.

## Pass every limit on

A subagent gets no permission that the skill which started it does not have.
State the limits in the brief, because the subagent cannot see the skill that
started it:

- what it may change, which for every task in the table above is nothing;
- that it must not commit, push, post to GitHub, create or edit issues, or move
  board items, even when the skill it follows would otherwise allow that;
- that it must not contact an online, hosted, or paid service, apart from the
  read-only GitHub queries its task needs, such as reading an issue or a pull
  request;
- that it must not open, print, or quote the protected files listed in
  `docs/agents/verification.md`, or any other secret-bearing file. Name those
  files in the brief. When `docs/agents/verification.md` is missing, or its
  protected files are still `TODO`, name the files that the
  [project profile](project-profile.md) treats as protected until then, so
  that no brief goes out without the list; and
- that it must stop and report back when a step needs the user's approval,
  instead of asking or going ahead.

A subagent usually cannot talk to the user. When its report asks for an
approval, put the request to the user yourself, then run the approved step or
start a new subagent with the answer in its brief.

## Run subagents side by side only for read-only work

Several subagents may run at once only when none of them writes anything. Two
agents that write to one working tree can overwrite each other's changes.

Commands that start services, bind ports, write build output, or change a local
database also share state. Run those once, before starting the subagents, and
pass the results in each brief.

## Check what comes back

A subagent's report is evidence to weigh, not a result to forward:

- Open the file and line behind every finding you will call `P0` or `P1`, and
  every claim you will present as a verified fact. Drop or downgrade what the
  source does not support.
- Merge findings that describe the same defect, and keep the clearest evidence.
- Treat a missing section, a scope the subagent did not cover, or a step it
  skipped as a gap in coverage, not as a pass.
- Stay responsible for the final report. Say which parts ran in subagents and
  which ran inline.

## Role agents

`lead-issue` runs each role of the workflow as an agent of its own: a
developer, a fresh verifier every round, a reviewer, and others. A role agent
differs from the read-only subagents above in three ways. Its role brief, in
`.agents/skills/lead-issue/briefs/`, says what it may change. It may run across
several messages, as the developer does from the start of an issue to its last
fix round. And it may run in a separate thread or session, so the work it hands
back lives in files, not only in its reply.

### Ways to start one

Use the first way the host offers:

1. **An agent that reports back.** The host starts an agent with a fresh
   context in the same checkout and returns its report to you, as a subagent
   or task tool does.
2. **A separate thread or session.** The host lets you start another
   conversation with a fresh context, read what it returns, and send it more
   messages. Start it in the same checkout unless the brief names another,
   such as the harness keeper's worktree.
3. **The user starts it.** When the host offers neither, write the brief to
   `<run directory>/briefs/<role>-r<round>.md`, ask the user to start a new
   session in the same checkout, on the model and effort you chose, with the
   instruction to read that file and follow it, and wait for the user to say
   it finished. Then read the report
   the brief named.

Use the second way instead of the first when the model you chose, as
[Choose the model](#choose-the-model) describes, is one that only a separate
thread can run, such as a model from another provider. When the project
defines an agent type for the role, such as the agent team's `verifier`, start
the role as that type: the host may enforce checks the definition carries.
`lead-issue` says when a role must use its type.

### What every brief carries

Start the brief with the role brief's path and the instruction to read and
follow it. Then add the facts for this run:

- the issue link, every affected repository, the branch, and the base commit;
- the run directory that `node .agents/scripts/gate.mjs paths` prints, and the
  evidence directory for a verification round;
- the task for this message and where it stops;
- the grants from `docs/agents/autonomy.md` that apply, each by name;
- the protected files, named as [Pass every limit on](#pass-every-limit-on)
  requires; and
- the report to write, its path in the run directory, and what to return.

Leave out whatever would steer the result, as
[Write a self-contained brief](#write-a-self-contained-brief) describes.

### Hand work back through files

Every role agent writes its report to the run directory and returns the path
with a short summary. The run directory lives in the repository's Git
directory, which every worktree of the repository shares. A report there
survives a separate thread or session, and a replacement agent can pick up from
it.

### Continue or start fresh

Continue an agent by sending it a follow-up when the host allows that, as the
developer is continued for every fix round. When the host does not, start a new
agent with the same role brief and the paths of the earlier reports. Never
continue a verifier or a reviewer into another round; each round gets new
ones.

### One writer at a time

Only one role agent changes files in a checkout at a time, and no agent
verifies or reviews while the developer is working. Read-only role agents may
run side by side only under the rules in
[Run subagents side by side only for read-only work](#run-subagents-side-by-side-only-for-read-only-work).
