---
name: create-issue
description: Create a grounded GitHub issue from the user's notes. Verify any factual claim added beyond the user's report against authoritative project evidence before publication, then select the repository, form, existing labels, issue type where the owner supports them, project board status, and any parent sub-issue relationship from the project's tracker settings. Use only when the user asks to create, file, or open a new issue. Do not use to edit existing issues or for discussions without creation intent.
---

# Create issue

Turn the user's information into one clear, correctly configured GitHub issue.
Preserve reported facts, distinguish observation from inference, and avoid
inventing reproduction steps, product decisions, or implementation details.

The tracker settings and routing table live in `docs/agents/issue-tracker.md`,
as the [project profile](../../references/project-profile.md) describes. If that
file is missing, or the destination repository or board it names is still
`TODO`, draft the issue but stop before creating it, and recommend
`setup-project`.

## Require creation intent

Create an issue only when the user explicitly asks to create, file, or open one.
Explicit invocation of this skill with issue content also counts as creation
intent. That request authorizes one new issue and the metadata required by this
workflow.

If the user asks only for a draft, review, or help describing a problem, stop
after presenting the draft. Do not create an issue. Do not treat an ordinary bug
report or feature discussion as authorization for an external mutation.

Use the alignment rules below when a missing answer would materially change the
issue. Uncertainty about the owning component alone does not block creation
when the tracker settings define a fallback repository.

## Ground every factual claim

Do not turn a plausible inference into a fact. General domain knowledge,
framework or engine conventions, names, and intuition are not evidence of how
this project currently behaves.

Classify the information used in the draft:

- A user-reported observation may be preserved as something the user observed.
  Do not silently upgrade it to independently verified behaviour.
- A statement about current code, data, architecture, permissions, limits,
  persistence, deletion, recoverability, synchronisation, or another technical
  mechanism is a verified fact only when an authoritative source supports it.
- Expected behaviour, acceptance criteria, and proposed solutions describe the
  desired outcome. Do not phrase them as facts about the current system.
- An unsupported idea is an assumption, hypothesis, or open question. Label it
  clearly when it helps triage, or remove it.

Before including a factual claim that the user did not supply:

1. Identify what evidence would prove the claim.
2. Inspect the component that owns the behaviour. Search the current code,
   tests, schema, migrations, committed architecture or domain documentation
   from the reading order in `docs/agents/domain.md`, and relevant existing
   issues or decisions.
3. Match the source to the claim. Use runtime evidence for observed runtime
   behaviour, code and tests for implementation behaviour, schema and
   migrations for stored data, and product documentation or decisions for
   product rules. Use official external documentation only for behaviour owned
   by an external dependency.
4. If sources disagree, describe the disagreement rather than choosing the
   convenient version.
5. If the claim cannot be verified, remove it or state exactly what remains
   unknown. Do not fill the gap with general industry or domain reasoning.

Check the claims in a subagent when that takes more than a few lookups, such as
several claims, a component you have not read yet, or a component in another
repository. Follow the [subagent rules](../../references/subagents.md). A
subagent that has not seen the draft checks each claim without leaning toward
it. Brief it with:

- each claim as a statement to confirm or refute;
- the component and repository that own each claim, and the reading order in
  `docs/agents/domain.md`;
- the limits: change nothing, create or edit no issue, and contact no service
  beyond reading GitHub issues and pull requests; and
- the report to return: for each claim, `Supported`, `Contradicted`, or
  `Not found`, with every source it inspected, such as a file and line, a
  migration, an issue link, or a log.

Leave out the rest of the draft and the answer you expect. Claims owned by
different repositories may go to separate subagents that run side by side.
When only one or two claims need checking, in a file you have already read,
check them inline.

Before a claim enters the draft, open the source the subagent cites. Treat a
`Contradicted` claim as step 4 says and a `Not found` claim as step 5 says.

Keep a lightweight evidence map while drafting. It may remain internal, but
each added factual claim must trace to the user's evidence or a source the agent
actually inspected. Include a file, symbol, migration, issue, log, or stable
GitHub link in Additional Context when that reference would help a reviewer.
Never invent a citation or imply that a source was inspected when it was not.

## Align material issue decisions

Determine whether the user's notes leave a user-owned choice that would
materially change the outcome, problem boundary, observable behaviour,
acceptance criteria, or non-goals. Always invoke `align-issue` when the user
asks to be grilled, interviewed, or challenged about the issue.

When a material choice remains, invoke `align-issue` after gathering the facts
available from the project. Give it the user's notes, the evidence map, and any
draft criteria. Do not use the interview to ask for facts that can be inspected
or for details that can safely remain `Not yet known`.

If `align-issue` runs, wait for the user to confirm its alignment record before
creating the issue. Treat confirmed decisions as user-supplied intent. If no
material user-owned decision remains, keep the fast path and proceed without an
alignment round.

The user may explicitly ask to create the issue with named questions still
open. Record those questions only when the issue remains truthful and useful
for triage. Stop when an unanswered decision would make the requested outcome
or acceptance criteria misleading.

## Route the issue

Treat a repository URL or an explicit `owner/repository` name as authoritative
only when the user identifies it as the destination for the new issue. A parent,
related issue, or pull-request URL does not select the destination repository.
If the user names a repository the routing table does not list, confirm it
before filing there.

Otherwise use the routing table in `docs/agents/issue-tracker.md`:

- Identify the component that owns the change and the repository that component
  belongs to. In a single repository, name the owning component in the
  Description or Additional Context when it helps triage.
- Route to a component the profile marks as legacy or inactive only when the
  user explicitly targets it.
- When the owner remains uncertain, use the fallback repository from the
  tracker settings, and name the components that may be involved in the
  Description or Additional Context. Do not guess another repository.

Create one issue by default. Follow the profile's rule for work that spans
components, such as a single issue or an umbrella issue. Do not create
companion or child issues unless the user explicitly asks for separate
implementation issues.

## Choose the issue form

Look for the destination repository's own issue forms and templates in
`.github/ISSUE_TEMPLATE/`. When one matches the kind of work, use its headings,
required fields, and default labels, and leave out its instruction text.
Otherwise use the defaults below.

Use the bug report form for a defect, regression, crash, incorrect result, or
other behaviour that differs from an existing expectation.

Use the feature request form for new product behaviour, a user-facing
enhancement, or a capability that does not exist yet.

Use the blank form when the user requests it or when the work is documentation,
research, coordination, maintenance, infrastructure, or another task that does
not fit the bug or feature form.

The GitHub title field is the template's `Title`. Do not repeat `# Title` or its
instruction text in the issue body.

### Bug report body

```markdown
## Description

Clear description of what went wrong and where it was observed.

## Current Behaviour

What happens today.

## Expected Behaviour

What should happen instead.

## Steps to Reproduce

1.
2.
3.

## Acceptance Criteria

- [ ]
- [ ]
- [ ]

## Additional Context

Screenshots, videos, environment notes, related issues, or anything else that helps.
```

### Feature request body

```markdown
## Description

What should be built and why it matters.

## Problem / Motivation

The problem this solves or the opportunity it unlocks.

## Proposed Solution

How you imagine this working from a user or product perspective.

## Acceptance Criteria

- [ ]
- [ ]
- [ ]

## Additional Context

Mockups, related issues, constraints, or anything else that helps.
```

### Blank body

Use the structure supplied by the user. Add headings only when they make the
issue easier to understand. Do not force a bug or feature structure onto a
different kind of work.

## Write the issue

Create a short, specific title that describes the outcome or failure. Do not add
type prefixes such as `[Bug]` when an issue type or label already records the
kind of work.

Turn the user's notes into the selected form:

1. Preserve concrete names, versions, environments, platforms, devices, builds,
   error messages, and observed behaviour. Attribute reported observations to
   the user unless they were independently verified.
2. Separate current behaviour from expected behaviour.
3. For a bug, give the smallest reproducible sequence supported by the
   evidence. If reproduction is incomplete, say what remains unknown instead
   of fabricating steps.
4. For a feature, describe the proposed experience and constraints without
   turning the issue into an unapproved implementation plan.
5. Write acceptance criteria as observable outcomes. Each checkbox must be
   independently verifiable and must not merely say that code or tests exist.
6. Put supplied screenshots, recordings, logs, environment notes, constraints,
   and related issues in Additional Context. A local file path is not a usable
   GitHub attachment. Upload the file only when the active GitHub interface
   supports it and the user's creation request clearly includes that file.
7. Exclude passwords, tokens, secret-bearing files, private customer or player
   data, and other sensitive information. If safe redaction would remove
   information needed to understand the issue, stop and ask for a sanitized
   description.
8. Remove template instructions and empty placeholders from the final body.
   Keep a required section with a plain statement such as "Not yet known" only
   when that absence is itself useful to triage.

Keep each prose paragraph, bullet, checklist item, and numbered step on one
physical line in the Markdown source. Do not hard-wrap issue body text to a
fixed column width. Use source line breaks only for Markdown structure, such as
headings, blank lines, separate list items, and code blocks, or when a deliberate
hard line break is part of the content. Let GitHub wrap long lines for the
reader's viewport.

## Preflight GitHub configuration

Resolve all required metadata before creating the issue:

1. Verify the selected repository exists and the authenticated account can
   create issues in it.
2. Search open and recently closed issues in that repository for the proposed
   title, distinctive terms, and any supplied error text. If an existing issue
   likely covers the same work, show the candidate and ask whether to use it or
   create another. Do not create a duplicate by default.
3. Fetch the repository's current labels with their descriptions. Choose the
   smallest relevant set from labels that already exist, guided by the label
   mapping in the tracker settings. Do not create, rename, or guess a label. Do
   not use status or priority labels unless the user requested them and the
   repository already provides them.
4. Set an issue type only when the tracker settings say the owner uses them.
   Issue types exist only for organizations. Fetch the types currently enabled
   for that organization and select the closest exact type by meaning. A defect
   normally maps to Bug, a new capability to Feature, coordination or
   maintenance to Task, and a broad umbrella to Epic when those types exist.
   The available names and descriptions are authoritative. Do not confuse the
   issue type with its labels. For a user-owned repository, or when the
   settings record `None`, let labels carry the classification.
5. Resolve the project board the tracker settings name, with that exact title
   owned by the named owner, its status field, and the exact option mapped to
   the new-issue lifecycle role, usually `Todo`. Resolve every project, field,
   and option ID dynamically; never hard-code one. The board is required: if the
   settings name none, or GitHub no longer has it, stop and ask the user to run
   `npx agent-fleet@latest update --dry-run` and then
   `npx agent-fleet@latest update` in their own terminal. The update creates or
   repairs the project board on GitHub. Do not run it yourself without the
   user's approval. When the user asks you to run it, follow [Updating the
   installation](../../references/project-profile.md#updating-the-installation).
6. If the user supplied a parent, resolve it to an unambiguous issue URL and
   verify that it exists. The new issue must be added as a sub-issue of that
   parent. A full URL or repository-qualified reference is authoritative. A
   bare issue number refers to the default repository in the tracker settings
   only when the user clearly indicated that relationship; otherwise ask which
   repository owns the parent.

Stop before creation if the repository is inaccessible, no suitable existing
label can be selected, a configured issue type, board, or status option cannot
be resolved, or an explicitly requested parent cannot be verified. Report the
specific configuration that blocked creation.

## Create and configure the issue once

Prefer a native GitHub issue capability when it can set and verify every
required field. Otherwise use the authenticated GitHub CLI or API. When using
the CLI, inspect the installed command help instead of assuming a particular
version. Current clients may support `--label`, `--type`, `--project`, and
`--parent` directly.

Use an explicit repository, title, body file, selected labels, the selected
issue type when one applies, the board, and the verified parent when
present. Add the new issue as a sub-issue of that parent
through the GitHub parent relationship. Do not pass an assignee. Do not add a
milestone unless the user explicitly requested one.

Create the issue exactly once and capture its URL, number, node ID, and
repository. Then resolve the issue's board item and set its status to the
resolved new-issue option. If project automation already
set that option, verify it without issuing a redundant update.

If creation succeeds but a later metadata update fails, repair the same issue.
Never repeat the create operation to recover from a project, status, type,
label, or parent failure. Report any field that remains incomplete.

Do not assign the creator or another person. Do not move the issue to the
started status; assignment and that lifecycle transition belong to
`start-issue` when work actually begins.

## Verify the created issue

Read the issue and its board item back from GitHub. Confirm:

- the URL points to the intended repository and issue number;
- the issue is open and its title and body match the final draft;
- user-reported observations remain attributed unless the agent independently
  verified them;
- every factual claim added beyond the user's report has a source the agent
  inspected, and no inference is presented as verified fact;
- prose paragraphs, bullets, checklist items, and numbered steps contain no
  accidental hard-wrapped lines;
- the selected existing labels, and the issue type when one applies, are
  present;
- the assignee list is empty;
- the new issue identifies the supplied parent and the parent lists the new
  issue as a sub-issue when requested; and
- the issue belongs to the board with the new-issue status.

If an external automation adds an assignee or changes another field after
creation, report the observed result. Do not silently remove or overwrite
automation-managed data.

## Reply

Lead with the clickable issue link, formed as the
[GitHub reference rules](../../references/github-references.md) specify. Link
every other GitHub object the reply names, including the parent issue,
sub-issues, and any issue or pull request cited as grounding. Inside the issue
body itself, use the plain `#number` or `owner/repo#number` autolink instead.

Also report the repository and owning component, selected form, issue type
when one applies, labels, board status, parent and sub-issue relationship when
present, the project sources used to ground added factual claims, and any
attachment or configuration that could not be applied. When the owner is
uncertain, report the components that may be involved instead of the owning
component.

Stop after creation and verification. Do not start implementation, create a
branch, assign anyone, move the issue to the started status, add comments, or
create related issues unless the user separately asks for that work.
