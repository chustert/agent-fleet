---
name: setup-project
description: Adapt the agent fleet to a project by inspecting its repositories, GitHub tracker and board, components, platforms, verification commands, deployments, knowledge documents, boundaries, secret files, and the project's earlier skills, including any the fleet replaced, then writing the project profile in docs/agents/ that every other skill reads and tailoring the project's AGENTS.md and CLAUDE.md. Use after installing the fleet, when a skill reports a missing or TODO profile value, or when the project's structure, board, or commands change. Reads GitHub but never changes it.
---

# Set up project

Fill the project profile so the workflow skills run in this project without
guessing. The profile is three files under `docs/agents/`, described in the
[project profile](../../references/project-profile.md):

- `issue-tracker.md`: tracker settings, board, lifecycle statuses, branch
  conventions, and the routing table;
- `domain.md`: reading order, boundaries and their local checks, ADR location,
  and quality weighting;
- `verification.md`: each component's commands, evidence, and deployments;
  services that need approval; protected files; and review-worktree setup.

When the installation includes the agent team (`.claude/agents/` exists), a
fourth file, `autonomy.md`, records what the team's engineering lead may do
without asking the user.

Then tailor the project's instruction files. The fleet installer creates
`AGENTS.md` from `templates/AGENTS.template.md` when the project has none, and
`CLAUDE.md` to import it when Claude Code is one of the installed tools. In
either file it owns only the section between the `agent-fleet:begin` and
`agent-fleet:end` markers. Everything else belongs to the project.

Invoking this skill authorizes reading the project, running read-only `git` and
`gh` queries, creating or editing the profile files, and replacing the
`TODO` placeholders the installer left in `AGENTS.md`. Editing an existing
profile file includes filling a value and adding a row, column, or section that
its template has and the file lacks. It does not authorize editing any other
file or any hand-written part of `AGENTS.md` or `CLAUDE.md`, editing or
restoring a file the fleet installed, creating labels, boards, fields, or
issues, running the fleet installer, installing tools, running builds or tests,
or opening protected files. Never edit the agent-fleet section; the installer
rewrites it. Propose any other change as a diff, and apply it only after the
user approves it. Such changes include an addition to a hand-written
`AGENTS.md`, permission deny rules, removing or narrowing a project skill, and,
in an existing profile file, a renamed row, column, or section, a setting moved
out of the row that held it, or a changed value the user wrote.

Record only what evidence supports. Write `TODO` with a short note of what would
resolve a value you could not establish, and `None` only for something you
confirmed is absent. A plausible guess recorded as fact is worse than a `TODO`,
because every later skill will trust it.

## 1. Establish the topology

1. Find the project root: the directory that holds `.agents/skills/`.
2. Classify the project as one of:
   - a single repository with one component;
   - a single repository with several components, such as a monorepo with an
     app, a server, and shared packages;
   - a workspace of independent repositories: child directories with their own
     `.git`, usually ignored by the workspace's `.gitignore`.
3. For each repository, read its remote with `git -C <path> remote get-url origin`
   and its metadata with
   `gh repo view <owner/repo> --json nameWithOwner,owner,defaultBranchRef,hasIssuesEnabled,visibility`.
   Note the current branch and whether the worktree is clean, but change
   nothing.
4. Read the existing instructions: `AGENTS.md`, `CLAUDE.md`, `README.md`,
   `CONTRIBUTING.md`, the documentation index, and any files already in
   `docs/agents/`. Existing profile files are the starting point. Update them in
   place and never discard a value the user wrote without asking.

## 2. Harvest the project's earlier skills and docs

A project may arrive with skills, scripts, or agent documents of its own. When
the installer would replace content it did not write, it reports a conflict: a
file that "exists and was not installed by the fleet", a fleet file that
"changed since the fleet installed it", or an `AGENTS.md` or `CLAUDE.md` whose
agent-fleet section "was edited by hand". It overwrites them only with
`--force` or the user's consent. The previous version stays in Git when it was
committed. A project can also keep its own skills beside the fleet's, such as a
skill with a fleet skill's name in the folder of a tool that got no adapter.
These files often hold the project facts the profile needs, so read them before
you fill it. Hand-written instructions can also still describe the project's
earlier skills. Skip this step when the installation replaced no project
content, no project skill sits beside the fleet's, and no hand-written
instruction mentions skills, adapters, or skill checks.

1. Find the replaced files. Use the conflicts the installer printed when the
   user still has its output. Otherwise read them from Git. Every committed
   install and update changed `.agents/agent-fleet.json`, so
   `git log --reverse --format=%H -- .agents/agent-fleet.json` lists them,
   oldest first. List the files each one changed with
   `git show --name-status --format= <commit>`. Only an `M` entry can have
   replaced content, and only for `AGENTS.md`, `CLAUDE.md`, or a path the
   commit's manifest lists under `files`. For each commit after the first,
   call the one before it in the list `<previous>`, and read its manifest
   with `git show <previous>:.agents/agent-fleet.json`.
   - In the first commit, each such file replaced a project file, except
     `AGENTS.md` and `CLAUDE.md`, which only gained the agent-fleet section.
   - In a later commit, a file replaced project content when the manifest in
     `<previous>` does not list it under `files`, such as a project skill
     that a newer fleet version replaced with a skill of the same name. The
     same holds when `git diff --name-only <previous> <commit>~1` lists the
     file, because the project had edited the fleet's version by hand. Any
     other `M` entry is the fleet updating its own file.
   - In a later commit, `AGENTS.md` or `CLAUDE.md` lost content only when its
     agent-fleet section, between the `agent-fleet:begin` and
     `agent-fleet:end` markers, changed between `<previous>` and
     `<commit>~1`. The installer keeps the rest of either file.

   When the installation is not committed yet, `git status` lists the changed
   files. Treat them as one more commit, with `HEAD` in place of
   `<commit>~1`.
2. Read each previous version with `git show <commit>~1:<path>`. A file the
   installer reported that has no previous version in Git was never
   committed, and the overwrite destroyed it. Ask the user what it held, and
   report the file as lost when nobody knows. List the project's skills from
   before the fleet with
   `git ls-tree -r --name-only <commit>~1 -- .agents/skills/` for the first
   commit, and the same for each tool's skill folder, such as
   `.claude/skills/`. Also read the project's own skills that still sit
   beside the fleet's, and the rules about skills, adapters, and skill checks
   in the hand-written parts of `AGENTS.md` and `CLAUDE.md` and in any other
   document in `docs/agents/`. Step 9 compares those rules with the
   agent-fleet section.
3. Collect the project facts they hold: commands and their working
   directories, paths, services, safety rules, board and status names, time
   zones, and the steps that gather runtime evidence.
4. Propose a profile row for each fact, or an `AGENTS.md` line for a rule that
   applies to every task. When no template row fits, propose it under the
   closest profile section, and say in the summary that no template row
   covers it, so no skill reads it yet.
5. When a fact differs from a value already in the profile, including one the
   installer recorded, show both values with their sources and ask the user
   which is right. Such a fact is not already covered.
6. A project skill that does a fleet skill's job competes with it: a tool can
   load either one for the same request, and the project skill runs the old
   workflow. Compare each project skill's name and `description` with the
   fleet skills'. For a project skill with a fleet skill's name, or with a
   description that covers the same requests, such as a project's own
   boundary-change skill beside `cross-boundary-contract`, propose one of two
   changes as a diff for approval: remove it with its adapters, or narrow it to
   what the fleet skill does not cover and move its project facts into the
   profile.
7. Report every fact in the summary of step 10 as one of:
   - moved, with the row it went to;
   - already covered, with the file and section that cover it;
   - dropped, with the reason, such as a step of the old workflow that a
     fleet skill now performs.

Never edit or restore a fleet file to keep a fact. The installer owns those
files and reports any change to them as a conflict on the next update.

## 3. Read the tracker

The installer has already made sure the project is a GitHub repository, that
`gh` is installed and logged in with the `repo` and `project` scopes, and that
a project board is linked to the repository with the workflow's `Status`
options and an iteration field. It recorded the repository, owner type, board,
lifecycle statuses, iteration field, sprint time zone, and base branch in
`docs/agents/issue-tracker.md`. Keep those values unless the user chose a
different one in step 2; fill the rest. The installer took the sprint time
zone from the clock of the machine it ran on, so mark it proposed until the
user confirms it. Run read-only queries and record names, not IDs.

- Check the recorded board against GitHub: `gh project field-list <number>
  --owner <owner> --format json` lists its `Status` options and iteration field.
  If the board is missing, unlinked, or lacks an option or the iteration field,
  do not repair it here. Ask the user to run
  `npx agent-fleet@latest update --dry-run` and then
  `npx agent-fleet@latest update` in their own terminal. The update creates or
  repairs the project board on GitHub. Do not run it yourself without the
  user's approval. When the user asks you to run it, follow [Updating the
  installation](../../references/project-profile.md#updating-the-installation).
  Continue with the rest.
- If `docs/agents/issue-tracker.md` predates the installer and names no board,
  take the board the installer set up from `github.board` in
  `.agents/agent-fleet.json`: its `owner`, `number`, `title`, and `url`. The
  installer never changes an existing `docs/agents/issue-tracker.md`. Confirm
  the board with `gh project field-list <number> --owner <owner> --format json`,
  and record it in the `Project board` row as
  `` `<title>` owned by `<owner>`: <url> ``. Ask for the update, as the
  previous item describes, only when the manifest names no board or GitHub no
  longer has it. The board is required; never record `None` for it.
- Issue types, for an organization only:
  `gh api graphql -f query='query($l:String!){organization(login:$l){issueTypes(first:25){nodes{name description isEnabled}}}}' -f l=<owner>`.
  Keep `Resolve from GitHub` when enabled types exist, otherwise record `None`.
- Labels: `gh label list --repo <owner/repo> --limit 200 --json name,description`.
  Propose the mapping from kinds of work to existing labels.
- Issue forms and the pull-request template: list `.github/ISSUE_TEMPLATE/` and
  `.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE/`. The
  skills use them when present, so note that they exist.
- The fallback repository starts as the default repository. In a workspace of
  several repositories, propose where issues with an unclear owner belong, and
  the rule for work that spans components; the user confirms.

## 4. Map components and platforms

Identify components from the directory structure and the manifests. Read file
names and manifest contents; do not run anything.

| Signal | Suggests |
| --- | --- |
| `package.json` with a web framework such as Next.js, React, Vue, Svelte, or Vite; `index.html` | `web` |
| `*.xcodeproj`, `*.xcworkspace`, or `Package.swift` with app targets; `build.gradle` with `com.android.application`; `pubspec.yaml`; React Native or Expo configuration | `mobile` |
| Electron or Tauri configuration; a macOS app target; WinUI, WPF, or Qt projects | `desktop` |
| `ProjectSettings/ProjectVersion.txt` (Unity), `*.uproject` (Unreal), `project.godot` (Godot), a game framework dependency | `game` |
| Server frameworks, `Dockerfile`, `docker-compose.yml`, database migrations, Terraform or other infrastructure code | `service` |
| Published package metadata, library products or targets, `bin` entries, CLI frameworks | `library-cli` |

A component can span two platforms, such as a web app with its own API routes.
Record the primary one and name the other. Mark a component as legacy or
inactive only when the project's documentation says so.

Build the routing table: component, repository, local path relative to the
project root, and what it owns, in the project's own words where the
documentation has them.

## 5. Find the verification commands and deployments

For each component, find the documented commands. Sources, in order of
authority: `AGENTS.md`, the README and contributing or testing guides, CI
workflows in `.github/workflows/`, and task runners such as `package.json`
scripts, `Makefile`, `justfile`, Gradle tasks, `xcodebuild` schemes, fastlane
lanes, or the engine's command line.

- Record each command exactly, with its working directory. Prefer what CI runs
  as the final verification.
- Record the test harness, or `None` and the evidence that replaces it, such as
  a build, lint, or runtime check.
- Record how to run one focused test.
- Record the local run command and the runtime evidence method, starting from
  the defaults in the component's platform guide in
  [platforms](../../references/platforms/README.md). When the component has
  several entry points, such as pages, a public API, and a script that other
  sites embed, record one runtime evidence entry for each.
- Record prerequisites: local services, seeded data, accounts, simulators,
  devices, engine or SDK versions, and licences.
- Record what a merge or release triggers in the `Deploys` row. Look in the
  deployment documentation, the contracts document, the release workflows in
  `.github/workflows/`, and hosting configuration committed in the
  repository, such as a host's configuration file. Many hosts report their
  deployments to GitHub, so `gh api repos/<owner>/<repo>/deployments` and
  `gh api repos/<owner>/<repo>/environments` can show where merges go. A host
  can deploy every merge with nothing in the repository to show it. Ask the
  user about settings stored on the host, such as automatic deploys, and
  never query the host. Write `None` only when the user or the sources
  confirm that nothing deploys.
- Do not run builds or tests to discover commands. Mark each command
  `(documented, not yet run)` until someone runs it in this checkout.

## 6. Find services, protected files, and worktree needs

- Protected files: find secret-bearing files by name only, such as ignored
  `.env` files other than examples, signing files and keystores,
  `*.xcconfig` files holding secrets, service-account JSON, cloud credentials,
  and `*.tfvars`. Use `git check-ignore` and `git ls-files` to tell an ignored
  local file from a committed example. Never open, print, search, or diff a
  protected file. List the ones a fresh worktree needs as symlink candidates.
- Online, hosted, and paid services: derive them from committed example
  environment files, configuration, and documentation. Variable names are
  enough to identify a payment provider, email delivery, an AI API, a hosted
  database, analytics, a store, or a platform service. Record each with the
  rule that verification needs explicit approval before contacting it.
- Review-worktree setup: which ignored files a fresh worktree needs, and which
  dependency directories can be reused when a pull request does not change the
  lockfile.
- Propose Claude Code deny rules for the protected files, as `Read(...)` and
  `Edit(...)` entries in `.claude/settings.json`, shown as a diff for approval.

## 7. Find the knowledge documents and boundaries

- Record the paths of the glossary, architecture overview, component guides,
  contracts document, and ADR directory, or `None`. Do not write these
  documents here. List a significant gap, such as a multi-component project
  with no architecture overview, as a recommendation.
- List the boundaries between parts that ship or version separately, using the
  kinds `cross-boundary-contract` names. A project that ships as one unit and
  keeps no data across releases records `None`. For each boundary, record the
  producer, the consumers, which versions can meet during rollout, and the
  `Local check`: how to exercise both sides together locally, such as a local
  run in which one side calls the other.
- Find the local check in the contracts document, the component guides, and
  the local stack setup. When they do not describe one, ask the user rather
  than guess. Write `None` only when the user or the sources confirm that the
  two sides cannot run together locally.
- Propose the `Quality weighting` paragraph from what the product is and the
  starting points in the
  [software quality characteristics](../../references/software-quality-characteristics.md).
  Mark it proposed until the user confirms it.

## 8. Write the profile

- Create a missing profile file from the matching template in this skill's
  `templates/` directory, then fill it.
- Update an existing file in place, but compare it with its template first.
  Skills and their scripts look up settings by the row names and table
  columns the templates use, so a skill treats a row under another name as
  missing. Look for:
  - a row name that differs, such as `Repository` where the template has
    `Default repository`;
  - a setting folded into another row, such as statuses listed in the
    `Status field` row instead of a `Lifecycle statuses` row;
  - a template row or section the file lacks, such as `Deploys` in a
    component section;
  - a table that lacks a template column, such as a Boundaries table without
    `Local check`, or a routing table without `Repository` and `Local path`.

  Add a missing row, column, or section directly, with the value you found or
  `TODO`. Propose the renames and moved settings as a diff, and apply it only
  after the user approves. Keep every value the user wrote, and keep sections
  the template does not have.
- Write `autonomy.md` only when the agent team is installed, and only with
  the user's confirmation, because it grants the engineering lead standing
  authorization. Start from the template, which lists the usual grants and the
  actions that always go to the user. Fill `Cross-model review` with the
  command of a model CLI from another family that the user has installed and
  logged in, run read-only, or `None`. Never add a grant the user did not
  confirm. Until the user confirms, leave the file missing, so the lead keeps
  asking at every gate.
- Keep the profile a configuration record, not a copy of the documentation.
  Link the architecture, contracts, and testing guides rather than restating
  them.
- Keep each prose paragraph, bullet, and table row on one source line.
- Apply `technical-writing` and `unslop`.

## 9. Tailor AGENTS.md and CLAUDE.md

`AGENTS.md` is what every coding agent reads first, on every task, so it holds
only instructions that are always relevant. Detailed facts stay in the profile
and the project's documentation, and `AGENTS.md` points to them.

When the installer created `AGENTS.md`, replace each `TODO` from the evidence
gathered above:

- **Project intent:** what the product is, who uses it, and what it must never
  get wrong. Take it from the README, the product documentation, or
  `gh repo view <owner/repo> --json description`. Leave the `TODO` when those
  sources do not say; do not invent a purpose from the code.
- **Source of truth:** where each component's code lives, which paths are
  legacy, and which files are the source of truth for the schema,
  configuration, or content. Name the paths and let the routing table carry
  ownership.
- **Local development:** the install and run commands the documentation gives,
  or a link to the guide. Do not restate the verification commands; they live
  in `docs/agents/verification.md`.
- **Working rules** and **Security and secrets:** the project-specific rules
  the documentation and code make clear, such as a check to run before a
  migration or a key that must never reach client code. Delete a placeholder
  line when there is nothing to add.

When `AGENTS.md` was written by hand before the fleet arrived, leave its
structure alone. Compare it with the sections of the template, and propose only
the always-relevant instructions it lacks, as a diff for approval.

Then compare the hand-written parts of `AGENTS.md` and `CLAUDE.md`, and any
other document in `docs/agents/`, with the agent-fleet section. Look for a rule
that contradicts the section, such as one to edit the skill adapters by hand or
to run a checker other than `node .agents/scripts/check-skills.mjs`, and for a
rule that points to a skill, script, or reference file the fleet replaced, such
as link rules in a project document that
`.agents/references/github-references.md` now holds. An agent that follows
such a rule runs the old workflow, and a hand edit to a fleet file stops the
next update with a conflict. Propose removing or rewording each one, as a diff
for approval.

In a workspace of independent repositories, the workspace `AGENTS.md` covers
the workspace and its boundaries, and each child repository keeps its own
`AGENTS.md`. Read those; do not copy them into the workspace file.

Check `CLAUDE.md` when Claude Code is one of the installed tools. It must import
`AGENTS.md` with the line `@AGENTS.md`. When a hand-written `CLAUDE.md` repeats
instructions that `AGENTS.md` also holds, propose moving them into `AGENTS.md`
so the two cannot drift, as a diff for approval.

## 10. Confirm with the user

Present a compact summary:

- the topology and the routing table;
- the tracker, board, lifecycle mapping, iteration field, time zone, base
  branch, fallback repository, and cross-component rule;
- every fact harvested from the project's earlier skills and docs, marked
  moved, already covered, or dropped with a reason, and the facts that no
  template row covers;
- every replaced file that was lost because nobody committed it;
- per component: platform, test harness, commands, marking which are
  documented only, and what a merge or release deploys;
- protected files by name, and the services that need approval;
- knowledge documents found, gaps, boundaries with their local checks, and the
  proposed quality weighting;
- what `AGENTS.md` now says about the project's intent, source of truth, and
  rules, and the source of each statement;
- with the agent team: each grant `autonomy.md` would give the engineering
  lead, the actions that always go to the user, the loop limits, and the
  second-opinion command, for the user to confirm or narrow;
- every remaining `TODO`, in the profile or in `AGENTS.md`, and the question
  that would resolve it;
- the rows, columns, and sections added to existing profile files;
- proposed changes that need approval, as diffs awaiting approval: renamed
  rows, columns, or sections and moved settings in an existing profile file,
  deny rules, additions to a hand-written `AGENTS.md`, hand-written rules that
  contradict the agent-fleet section or point to replaced files, and project
  skills to remove or narrow because they share a fleet skill's name or job.

Ask the user to confirm or correct the judgement calls: routing ownership,
fallback repository, quality weighting, the project intent, the autonomy
grants, and anything marked proposed. Apply the corrections.

## 11. Check the installation

Run `node .agents/scripts/check-skills.mjs` from the project root when it
exists, and report the result. Recommend a smoke test in each coding agent the
team uses: ask it to name the product, the tracker, the board, the protected
files, and the verification commands for one component, then to list the
project skills. In Claude Code, `/memory` shows whether `CLAUDE.md` imports
`AGENTS.md`.

Stop after the profile and `AGENTS.md` are written and confirmed. Do not create
issues, branches, labels, boards, or commits.
