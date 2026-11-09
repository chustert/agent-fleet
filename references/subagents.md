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
