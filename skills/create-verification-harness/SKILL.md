---
name: create-verification-harness
description: Generate the project's verify-<app> skill, a scripted harness that launches the real app, health-checks it, drives it the way a user does and captures evidence, plus a feature map with one file per user-facing feature. Prove the harness once end to end before handing it over. Use when a project has no scripted way to prove UI, CLI or service behaviour, or when a verifier keeps improvising the same drive.
---

# Create a verification harness

Every project needs a scripted way to drive the real app and prove behaviour:
launch it, exercise a feature the way a user would, and capture evidence. This
skill writes that as the project's own skill, `verify-<app>`, and proves it
works. Its reader is the next agent, reading it cold in the middle of a
verification, with no setup conversation.

Adapted from pstack's `create-verification-skill`, by Lauren Tan (MIT). See
`LICENSE`.

Invoking this skill authorizes writing the harness skill folder and its
adapters, and launching the app locally to prove it. It does not authorize
installing dependencies, editing product code, changing the project profile,
committing, or contacting a hosted or paid service. Propose those instead.

## 1. Interview the repository, not the user

Start from the [project profile](../../references/project-profile.md):
`docs/agents/verification.md` for each component's platform, local run,
runtime evidence, prerequisites, local stack and protected files, and
`docs/agents/domain.md` for the reading order. Read the `Runtime evidence`
section of each component's guide in [platforms](../../references/platforms/README.md).
Then answer from the code, and ask only what you can't observe:

- **Surface:** what a user touches: pages, screens, commands, endpoints, an
  embedded script. A repository can have several components; one harness
  covers them, with one Launch per component when needed.
- **Run:** the documented local run, ports, environment variables, seed data
  and auth. Never read a protected file to find them; use committed examples.
- **Drive:** what can operate it programmatically. Prefer what the project
  already has: an end-to-end or UI test harness, a test target, a scripted
  session, a debug port, a documented request. Then the generic recipe the
  platform guide's `Runtime evidence` section points to.
- **Observe:** screenshots, recordings, terminal transcripts, response bodies,
  logs, exit codes, database rows.
- **Isolate:** whether two instances can run side by side (ports, data
  directories, devices, profiles). If not, the harness says so and refuses to
  drive a shared instance rather than corrupting someone's session.

If the checkout doesn't build or start as it is, report exactly why before
writing anything. A harness written against a broken base teaches wrong steps.

## 2. Write the skill

Write `.agents/skills/verify-<app>/SKILL.md`, where `<app>` is a short name for
the product. Give it frontmatter with `name: verify-<app>` and a `description`
that names the app, its surfaces, and when to use it, then these sections,
each grounded in what the interview found, with no placeholders left:

- **Launch:** the exact command that starts the app for verification from an
  empty data directory, with migrations and seed data, and how to tell it's
  ready. Ready means usable, not just that a process answers. Include
  teardown. For a short-lived CLI, Launch builds once, and each drive runs in
  its own isolated session.
- **Doctor:** one read-only check that answers "is this instance worth
  driving?": process up, right build, port owned by this run, seed present,
  auth valid. Run it first, and again after anything surprising.
- **Drive:** the recipe with real selectors and commands from this
  repository. Prefer stable handles, such as accessibility labels, test IDs,
  route paths and prompt strings, over coordinates and tab order.
- **Evidence:** what to capture for a proof, and where. Default to the evidence
  directory the verifier names, or the run directory that
  `node .agents/scripts/gate.mjs paths` prints when that script exists;
  otherwise a temporary directory outside the repository. State the proof
  standards from `proof-standards`: the real user path, the action and its
  resulting state, side effects checked, and mocks only at a real production
  boundary. When the safe path is a dry run or test mode, observe what it
  actually skips.
- **Cleanup:** tear down only what this run started; never kill a process by
  name. Cleanup removes instances and scratch data, never evidence.
- **Helpers:** each script the harness ships lives in its folder, is
  executable, and has its exact invocation in the skill body.
- **Not reachable here:** what this harness can't verify, such as a physical
  device, target hardware, a hosted service or a paid API, so a verifier
  reports those as checks for a person instead of guessing.

Give the skill an adapter in the skill folder of each tool the installation
records in `.agents/agent-fleet.json`, in the same form as the fleet's own
adapters beside it: the same frontmatter fields, and a body that points to the
canonical file. Then run `node .agents/scripts/check-skills.mjs`; a project's
own skill must pass its frontmatter and link checks.

## 3. Seed the feature map

Create `.agents/skills/verify-<app>/features/README.md` as an index, plus one
file per user-facing feature you can identify, starting with the three to five
most important, from routes, screens, commands, menus or docs. Use the shape in
[the feature template](references/feature-template.md). Each file answers,
from the user's point of view: what the feature is, every way to reach it, how
to drive it with the harness, and what observable end state proves it works.

If the seed data lacks a precondition that a journey needs, the journey reports
a failure and the reason goes in that feature's `Gotchas`. Never weaken a
journey to make it pass. A proof that drives one convenient entry point is
incomplete when the map lists others.

## 4. Prove the harness before handing it over

Follow its own instructions end to end once: Launch, Doctor, drive one mapped
feature, capture evidence, clean up, then confirm the evidence still exists
where the skill says. Fix what fails, and run the harness's cleanup after
every failed attempt so nothing is left running. A harness that was never run
is a draft, not a deliverable.

If you proved it on a stand-in for the real target, such as a simulator for a
device or a local stack for a hosted one, list each step the stand-in covered
that the real target won't. Those stay unverified.

## 5. Hand over

Report:

- the harness path, the features mapped, and the proof run with its evidence
  path;
- the proposed profile change, for the user to approve: point each
  component's `Runtime evidence` row in `docs/agents/verification.md` at the
  harness, such as "the `verify-<app>` skill: Launch, Doctor, then the matching
  file in `.agents/skills/verify-<app>/features/`", and update `Local run` and
  `Prerequisites` to match;
- each dependency, seed-data change or control CLI the harness needs outside
  its folder, as a separate proposal;
- the recommendation to run `maintain-verification-harness` on a schedule.
