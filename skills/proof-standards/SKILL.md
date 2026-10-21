---
name: proof-standards
description: Standards for what counts as proof when verifying agent-written work - the proof ladder, measured/inferred/guess labels, before-and-after on the real surface, benchmark questions, and the PASS, PASS+NOTES, FAIL and BLOCKED verdicts tied to one exact patch. Preloaded into the verifier; use when grading evidence or deciding whether work is proven.
---

# Proof standards

Proof means checking the real thing on the real surface. A compile, a green
suite, a plausible diff or an agent's summary is not proof that a behaviour
works. The agent that wrote the code never decides that it works.

Adapted from pstack by Lauren Tan (MIT): `principle-prove-it-works`,
`blast-radius`, `benchmark-checklist` and the Shipping playbook. See `LICENSE`.

## Check the real artifact

- Run the feature the way a user reaches it, through the project's
  `verify-<app>` harness. Read the actual value, row, file, response or
  screen, not a cached or derived representation.
- Exercise the real user path. Internal setters, test-only endpoints and
  mocks of the behaviour under test prove nothing about the user path. Mock
  only where a production boundary already isolates an external system.
- Capture the action and the resulting state, and the side effects (rows
  written, files created, requests sent), not just the final screen.
- When a check fails, suspect the way you checked before the system. When it
  passes, ask whether it could have passed with the feature broken.
- Prefer a script that re-runs the comparison over a one-time look. Keep it
  with the evidence so someone can re-run it.

## The proof ladder

Grade each fact a verdict depends on by how far down this list you got it:

1. **Said so.** An agent or a comment claims it. Worthless on its own.
2. **Pointed at it.** A real `file:line`, or the dependency's own source.
3. **Showed the bad case can't happen.** Walked the failure path step by step.
4. **Ran it.** A test or script that calls the real code and fails loudly if
   the claim is wrong.
5. **Reproduced it in the running app.** Through the harness, on the surface
   the user touches.

Runtime behaviour needs level 4 or 5 to `Pass`. A static outcome (a doc, a
config declaration, a removed file) can `Pass` at level 2 with the exact path
and hunk. Record the level next to every criterion.

## Label every claim

In the report, mark each statement:

- **measured**: you ran it and observed this output;
- **inferred**: follows from measured facts, with the reasoning shown;
- **guess**: plausible, unchecked. A guess never supports a `Pass`.

## Before and after

- **Bug fix:** reproduce the defect on the base first (red), then show it
  fixed on the branch (green), with the same steps. A fix whose bug you never
  saw fail is unproven.
- **Behaviour change:** when the criterion is about a difference, capture the
  base behaviour and the branch behaviour the same way.
- **Refactor:** the observable behaviour on the base and the branch matches
  for the paths the change touches.

Use a detached worktree for the base: `git worktree add --detach <temp> <base>`.

## Inconclusive is a failure

A result that is inconclusive, flaky, checked on the wrong surface, or checked
on a stand-in (a unit test for a UI flow, a desktop browser for a mobile
layout) does not pass. Say what would make it conclusive. Never hand the user
a check you could run yourself; human-only checks are the ones that need a
person: a physical device, target hardware, feel, or a hosted or paid service
without approval.

## Numbers

Before trusting a performance number, answer these with evidence from a run:

1. What limits the number, and why isn't it double?
2. Did every side run tuned the way production runs (release build, warm or
   cold cache stated)?
3. Does the result break a physical limit, such as bandwidth or core count?
4. Did anything error or return wrong output during the runs?
5. Does it reproduce over alternating runs, with a median and a range?
6. Does it matter end to end, on the path a user waits on?
7. Did the work actually happen inside the timed region?

The answer is faster, slower, no measurable difference, or inconclusive.

## Verdicts

A verdict covers one exact patch: the diff from the base to the working tree,
fingerprinted with `git patch-id --verbatim` by `.agents/scripts/gate.mjs`. Any
later edit changes the fingerprint and needs a new verdict. A clean rebase
keeps the same fingerprint, so the verdict survives it.

| Verdict | Means |
| --- | --- |
| `PASS` | Every criterion proven at the required level; no open P0 to P2 finding. |
| `PASS+NOTES` | As PASS, but some criteria need a person (device, feel, hosted or paid service); each is listed with exact steps. P3 findings are notes. |
| `FAIL` | A criterion failed, a P0 to P2 finding is open, or something the harness should have proven wasn't. |
| `BLOCKED` | Proof couldn't be established at all; the blocker and the command that showed it are named. |

Green CI and an approving review are inputs, not verdicts.
