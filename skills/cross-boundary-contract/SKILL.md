---
name: cross-boundary-contract
description: Plan or implement a change that crosses a boundary between parts that ship, deploy, or version separately, such as an API and its clients, a schema and the code that reads it, apps already installed on users' devices, a library and its dependants, a game's save files or network protocol, webhooks, or independent repositories, while keeping every version combination that can meet during rollout working.
---

# Cross-boundary contract change

A boundary is any interface where the two sides can run different versions at
the same time. Each side can pass its own checks while the combination breaks.
Apply this workflow whenever a change alters or depends on one, including when
the edit itself touches only one side.

## Find the boundary

1. From the reading order in `docs/agents/domain.md`, read the root
   `AGENTS.md`, the architecture overview, the contracts document, and the
   component guide or `README.md` on each side. Also read the `Boundaries`
   table in `docs/agents/domain.md` and the routing table in
   `docs/agents/issue-tracker.md`. In a workspace of independent repositories,
   read each affected repository's own `AGENTS.md` and any nested instructions
   for the paths involved. Handle a missing profile file, or a `TODO` or `None`
   value, as the [project profile](../../references/project-profile.md)
   describes.
2. If the project records no boundary for the area, find it from the code and
   the platform guides in [platforms](../../references/platforms/README.md).
   Typical boundaries are:
   - APIs, RPC, and their clients, including direct third-party callers;
   - database, file, and cache schemas and the code that reads them;
   - message, event, queue, and webhook payloads, including retries;
   - clients you cannot update at once: installed mobile and desktop apps,
     browser tabs running an old bundle, scripts embedded on pages you do not
     control, and game clients;
   - persisted user data: save files, local databases, documents, settings;
   - multiplayer protocols and server-authoritative state;
   - library and SDK public APIs, CLI flags and output formats, plugin and mod
     interfaces;
   - configuration, feature flags, environment variables, and asset or model
     manifests shared between deployable parts;
   - authentication and authorization rules enforced by one side and relied on
     by the other.

## Write the contract down before editing

3. Record the current contract and the proposed contract: shape, units,
   encodings, defaults, ordering, error semantics, and versioning. Identify the
   producer, every consumer, the stored data, and who controls when each side
   releases.
4. List every version combination that can meet: old producer with new
   consumer, new producer with old consumer, old stored data read by new code,
   and new data read by old code after a rollback. For clients in users' hands,
   assume old versions stay in use unless the project enforces a minimum
   version.

## Choose a compatible transition

5. Prefer an additive expand, migrate, and contract sequence: accept the old and
   new forms, apply any migration before the code that reads it, ship the
   producer and consumer changes, and remove the old form only in a later change
   once nothing deployed depends on it. Version persisted formats and keep a
   reader for every version still in use. For a library, follow its versioning
   policy: a breaking change needs a major version and a migration note.
6. Keep each intermediate state safe to deploy and to roll back. Read each
   affected component's `Deploys` row in `docs/agents/verification.md` for what
   a merge or release triggers. Note which merges deploy automatically and which
   steps need an explicit action, such as a remote migration, a store
   submission, or a package publish. Do not perform those actions as part of
   this workflow.

## Implement and verify each side

7. Keep changes in the component or repository that owns them. In a workspace
   of independent repositories, never stage one repository's changes in
   another, and keep branches, commits, and pull requests separate but linked.
8. Add or update contract tests on each side where a harness exists, and update
   the project's normal documentation, such as the contracts document, API
   reference, changelog, or format notes. Do not use agent files as the only
   technical specification.
9. Verify each side with its commands in `docs/agents/verification.md`. Then run
   the smallest local check across the boundary. Start from the boundary's
   `Local check` in the `Boundaries` table of `docs/agents/domain.md`, which
   records how to run both sides together locally. Cover the version
   combinations that check does not reach with an old payload fixture against
   the new consumer, an old save file loaded by the new build, or the previous
   client against the new local server. When the boundary has no row in the
   table, or its `Local check` is `None`, cover every combination that way. Do
   not infer compatibility from two independently green suites. Mark a
   combination that cannot run locally `Not verified` and name the missing
   environment or artifact.

## Report

10. In the plan, the handoff, and each pull request, write a change note. It
    states the contract before and after, the combinations that must keep
    working, the rollout and rollback order, any migration, backfill, reindex,
    data conversion, environment variable, or release it needs, the
    verification on each side and across the boundary, and any external
    verification still missing. When the contracts document defines its own
    change-note template, fill in that template and add any of these items it
    lacks. Link the issue and every related issue or pull request wherever you
    name it, per the
    [GitHub reference rules](../../references/github-references.md). Inside
    GitHub text use the plain `#number` or `owner/repo#number` autolink.
11. When step 2 found a boundary that the `Boundaries` table in
    `docs/agents/domain.md` or the contracts document does not record yet,
    propose recording it. Write the proposed `Boundaries` row, with its
    producer, consumers, the versions that can meet, and a `Local check` or
    `None`, and the proposed contracts-document entry, and show both as a diff
    in the report for the user to approve. Do not edit either file yourself in
    this workflow: a profile change needs the user's approval, as the
    [project profile](../../references/project-profile.md) describes, and the
    contracts document belongs to the project.

Do not commit, push, deploy, release, publish, or apply a remote migration as
part of this workflow.
