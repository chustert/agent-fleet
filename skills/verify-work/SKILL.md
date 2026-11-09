---
name: verify-work
description: Verify local implementation work against the originating GitHub issue and approved specification using the exact documented project commands, direct runtime evidence for each affected platform, explicit device, hardware, hosted-service, and paid-API limitations, and boundary compatibility checks, then run pr-review in a fresh-context subagent as a separate code-quality pass. Use after implementation and before pull-request preparation. Observe and report only; never fix, commit, push, deploy, create a pull request, or change issue state.
---

# Verify work

Prove that the current implementation delivers what its issue promised, then
review whether the implementation is sound engineering. Treat these as separate
questions: passing commands do not prove the acceptance criteria, and satisfying
the specification does not prove the code meets engineering standards.

The GitHub issue, its relevant comments, and any explicitly approved
issue-linked specification are authoritative. Do not create a shadow
specification, and do not require a local planning file that the project does
not use as the source of truth.

This is a non-editing quality gate. Invoking it authorizes safe local commands
and local runtime observation needed for verification. State-changing
interactions are allowed only against an explicitly identified disposable local
test environment or seeded test data. Obtain approval before mutating other
local data, and record any cleanup or reset the verification requires. This does
not authorize source or test edits, fixes, dependency changes, commits, pushes,
deployments, remote database actions, hosted testing, pull-request creation, or
issue mutations.

## Establish the exact scope

Before running checks:

1. Resolve the originating issue and read its current acceptance criteria,
   relevant comments, relationships, non-goals, and approved linked
   specification. Do not invent missing criteria; mark an outcome unverifiable
   when the expected behaviour is genuinely undefined.
2. Confirm every affected Git repository and component, branch, remote, recorded
   base ref and commit, current commit, worktree status, and complete diff from
   the base. Record pre-existing or unrelated changes and exclude them from
   conclusions.
3. Read the documents in the reading order of `docs/agents/domain.md`, any
   ADRs, and, for each affected component, its settings in
   `docs/agents/verification.md` and the platform guide it names in
   [platforms](../../references/platforms/README.md). In a workspace of
   independent repositories, also read each affected repository's own
   `AGENTS.md` and testing documentation. Handle a missing profile file, or a
   `TODO` or `None` value, as the
   [project profile](../../references/project-profile.md) describes.
4. Convert each acceptance criterion into a concrete observable claim and name
   the strongest locally available evidence for it. Preserve the source wording
   so the final result can be traced back to the issue. Include the criteria
   that came from the plan's quality decisions, such as failure, offline,
   permission, limit, compatibility, and recovery behaviour, and treat a
   deferral the plan recorded as a non-goal rather than a gap.
5. Identify commands and prerequisites before execution, including local
   services, seeded data, browser access, simulators, emulators, physical
   devices, target hardware, engine or SDK versions, signing, credentials, and
   online or paid services.

If the branch, base, issue, or affected component is ambiguous, stop rather
than verifying the wrong diff.

## Run documented commands exactly

Use the commands `docs/agents/verification.md` records for each affected
component, and the repository documentation it points to. Prefer the final
verification when one exists, then any documented focused, database, browser,
integration, build, lint, typecheck, or test command that directly supports an
acceptance claim. If the profile is missing, use the commands the repository's
own documentation and CI configuration define, and say so.

- Run each command from its documented working directory with its documented
  environment and arguments. Do not silently substitute a similar command,
  remove a required phase, or claim an improvised variant is the project's gate.
- Do not install or update tools, packages, lockfiles, runtimes, simulators,
  emulators, engines, browsers, or dependencies merely to make verification
  possible.
- Check that a command is local, relevant, and non-destructive before running it.
  Ask before a database reset, destructive fixture operation, online target, or
  other action whose state impact is not already explicitly authorized.
- Record the exact command, exit result, relevant redacted output, duration when
  useful, and the claim it supports. A passing command supports only the paths
  and assertions it actually exercises.
- If a check changes tracked or untracked project files, stop, name those paths,
  and do not clean or restore them without user direction.
- If a command fails, preserve the evidence and report the failure. Do not edit
  the implementation; fixing returns to `implement` and may require
  `diagnosing-bugs`.

## Verify acceptance criteria directly

Assign one result to every criterion:

- `Pass`: direct evidence demonstrates the specified observable behaviour.
- `Fail`: direct evidence contradicts the criterion or exposes a blocking error.
- `Not verified`: required evidence is unavailable, unsafe, ambiguous, or needs
  credentials, hardware, a human play-test, hosted infrastructure, a paid
  third-party API, or authorization not present.

Do not use `Pass` for a behavioural or runtime criterion based only on code
inspection, compilation, a green but unrelated test suite, or an
implementation-shaped assertion. Use static inspection to explain evidence, not
to replace runtime behaviour where the criterion describes a running system.

For a static or structural criterion—such as an exact documentation change,
configuration declaration, file removal, resource reference, content-data entry,
or migration artifact—direct file and diff inspection can be sufficient. Name
the exact path, hunk, or generated representation that proves the required
static outcome.

For a partially met criterion, use `Fail` when the missing part is observable
and required. Use `Not verified` when the missing part could not be exercised.

## Gather runtime evidence for each platform

For every behaviour change, capture direct local runtime evidence on the
platform that runs it. Follow the runtime-evidence section of the component's
platform guide, using the local run command and the `Runtime evidence` row in
`docs/agents/verification.md`. That row may list one method per entry point,
such as pages, a public API, and a script embedded by other sites. Gather
evidence at every entry point the change touches. Across every platform:

1. Start or reuse the local services with the documented commands. Check the
   health of a running service before starting a duplicate.
2. Exercise the real flow as the acceptance criterion requires, such as
   navigating a page, tapping through a screen, playing a scene with the given
   inputs, sending a request, or running a command, rather than inferring the
   result from source. Use a disposable local account or seeded data for
   state-changing flows; otherwise obtain approval before modifying local data.
3. Capture evidence that fits the claim: screenshots or recordings for visual
   state, response bodies or output files for data behaviour, logs, console and
   network state, and profiler captures for performance. Store generated
   evidence in a temporary directory, harness-managed attachment storage, or
   another explicit location outside every affected Git repository. Redact
   sensitive values.
4. Treat console errors, failed requests, warnings, crashes, dropped frames, and
   broken assets as evidence; a plausible-looking result is not automatically a
   pass.
5. When a criterion needs a person, such as a physical-device check or a
   play-test of feel or difficulty, give the user exact steps and the expected
   result. Record their observation as evidence, or mark the criterion
   `Not verified` until someone performs it.

Keep these evidence categories separate in the report:

- **Automated local checks:** tests, builds, lint, type checks, and content
  validation that actually ran, with the target, scheme, variant, or
  configuration used.
- **Local runtime:** browser, simulator, emulator, editor, local server, or CLI
  observations, with the runtime, device model, and OS or engine version.
- **Physical devices and target hardware:** phones, consoles, headsets, and the
  hardware a performance budget applies to. Never claim a device pass from a
  generic build or an editor measurement.
- **Credentials and local configuration:** name the missing configuration
  category without opening, printing, or quoting any protected file listed in
  `docs/agents/verification.md`, or any other secret-bearing file.
- **Hosted infrastructure:** the deployments and other online targets listed
  under `Online, hosted, and paid services` in `docs/agents/verification.md`,
  plus any other preview, staging, or production environment, any remote
  database, and any other online service.
- **Paid third-party APIs:** the paid services listed in the same section, plus
  any other third-party API that costs money, sends real messages, or acts on
  real accounts, and its sandbox or test mode. Examples are a payments sandbox,
  email delivery, an AI API, and a store or platform service.

Local verification does not authorize contacting any online service, including
hosted infrastructure and paid third-party APIs. Explain why local evidence is
insufficient, name the target, the actions, the expected side effects and cost,
and obtain explicit permission for that specific check. An unavailable
simulator, device, hardware, credential, or service produces `Not verified` for
the affected claim, reported separately from test failures and code defects.

## Boundary compatibility

Invoke `cross-boundary-contract` whenever the work changes or depends on a
boundary between parts that ship or version separately, as listed in
`docs/agents/domain.md` or found in the code.

Verify every affected component and repository independently, then exercise the
smallest available compatibility path across the shared boundary. Start from
the boundary's `Local check` in the `Boundaries` table of
`docs/agents/domain.md`, which records how to run both sides together locally.
When the boundary has no row in the table, or its `Local check` is `None`,
exercise each combination with old payload fixtures, earlier stored data, or
earlier builds instead. Record:

- the producer and consumer, and which versions of each can meet during
  rollout, including clients already installed on users' devices;
- current and proposed contract shapes and error semantics;
- old-producer/new-consumer and new-producer/old-consumer expectations, and old
  stored data read by the new code, such as an earlier save file or an earlier
  client build against the new server;
- schema, migration, backfill, reindexing, seed, environment-variable, auth,
  offline, and rollback implications;
- exact contract or integration evidence obtained; and
- the safe rollout order and rollback order.

If the full combination cannot run locally, mark it `Not verified` and state the
missing environment or artifact. Do not infer compatibility from two
independent green test suites.

## Run the independent code review

After freezing the acceptance matrix and command evidence, run `pr-review`
against the same exact diff and base in a subagent, following the
[subagent rules](../../references/subagents.md). This context has watched the
work being built and checked, so a review run here would not be independent.
Start it on a model from the `Reviewer` row of `docs/agents/models.md`, chosen
as those rules describe.

Brief the subagent with:

- the issue or specification source, as a GitHub link;
- every affected repository, its base ref and commit, its current commit, its
  worktree path, and whether the review covers uncommitted changes;
- the affected paths and the exclusions recorded above;
- the commands you ran and their results, and the runtime observations with
  their artifact paths, so that `pr-review` can reuse the evidence that fits
  its checks; and
- the limits: review only, change nothing, post nothing, contact no online
  service, and report back any check that needs approval.

Leave out the acceptance matrix verdicts, your view of the code, and anything
said about why the code was written as it was. `pr-review` reaches its own
verdict on both axes.

When the host cannot start a subagent, run `pr-review` inline and state in the
report that the review was not independent. The exception is a brief that says
another agent runs the review when you cannot, as a `lead-issue` verifier's
brief does. Then follow that brief and leave the code review section pending
instead. When the subagent's report asks for an approval, put the request to
the user rather than running the step yourself.

The review must keep two axes distinct:

1. **Spec satisfaction:** missing or partial requirements, incorrect behaviour,
   and unrequested scope.
2. **Engineering standards:** repository conventions and the 16 operational,
   revision, and transition quality characteristics in the
   [software quality characteristics](../../references/software-quality-characteristics.md),
   which `pr-review` applies.

Do not let a good result on one axis cancel findings on the other. Do not repair
review findings inside this workflow. If the target is local work, keep the
review local. If the user explicitly selected a GitHub pull request, the
subagent follows `pr-review`'s PR workflow but returns the report to you, and
you post it as `pr-review`'s `Publish the GitHub PR report` step describes.
Otherwise do not post anything remotely.

## Report and stopping point

Return one self-contained verification record containing:

1. **Verdict and scope:** issue, affected components and repositories,
   branches, base commits, diff range, relevant exclusions, and whether the work
   is ready to proceed. Link the issue and every other GitHub object named
   anywhere in the record, per the
   [GitHub reference rules](../../references/github-references.md).
2. **Acceptance criteria:** a traceable `Pass`, `Fail`, or `Not verified` matrix
   with evidence for every criterion.
3. **Documented commands:** exact commands and results, grouped by component.
4. **Runtime evidence:** observations and artifact paths for each platform,
   without embedding sensitive data.
5. **Limitations:** device, hardware, play-test, credential, hosted
   infrastructure, and paid third-party API results or withheld checks, as
   separate categories.
6. **Compatibility:** contract evidence plus rollout and rollback order for
   changes that cross a boundary.
7. **Code review:** the separate Spec and Engineering Standards results from
   `pr-review`, including findings and unverified risks, and whether the review
   ran in a subagent, inline, or is pending for another agent, and the model
   and effort it ran on.
8. **Next action:** return failures to `implement`, request missing evidence, or
   state that the verified local work is ready for approved PR preparation.

Do not edit code, tests, documentation, specifications, issues, or workflow
status. Do not commit, push, deploy, publish, create or merge a pull request, or
move an issue to the in-review status.
