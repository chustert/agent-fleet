# AGENTS.md

This repository is the agent fleet: agent skills that work in any project, a Claude Code agent team that runs them, and the `@chustert/agent-fleet` npm package that installs both into a project. The unscoped `agent-fleet` package on npm belongs to someone else: every command in this repository names the scoped package, and `test/content.test.mjs` fails on one that doesn't. It grew out of skill-fleet. [README.md](README.md) explains the design and use.

## Layout

- `skills/<name>/SKILL.md`: canonical skills, with any `scripts/`, `references/`, `templates/`, or `agents/` files beside them. `skills/setup-project/templates/` holds the profile templates and `AGENTS.template.md`, the starting point for a project's `AGENTS.md`.
- `agents/`: the Claude Code agent team. Each `<name>.md` goes to a project's `.claude/agents/`, `settings.json` holds the permission rules and hooks the installer merges into `.claude/settings.json`, and `automations/` goes to `.claude/automations/`. The installer writes all of it only when Claude Code is a chosen tool.
- `references/`: models shared by several skills. `project-profile.md` defines the contract between skills and a project. `platforms/` holds one guide per platform.
- `bin/agent-fleet.mjs`: the command `npx @chustert/agent-fleet` runs.
- `lib/cli.mjs`: arguments, the installation questions, and the `install`, `update`, `check`, and `list` commands.
- `lib/github.mjs`: the GitHub CLI check and install offer, the login and its scopes, the repository, and the project board: finding, creating, linking, and repairing it.
- `lib/install.mjs`: plans and writes an installation. `agentsBlock()` holds the text of the agent-fleet section it maintains in a project's `AGENTS.md`.
- `lib/check-skills.mjs`: the checks, shared by the installer and copied into every project as `.agents/scripts/check-skills.mjs`.
- `lib/gate.mjs`: the verification gate, copied into every project as `.agents/scripts/gate.mjs`: patch fingerprints, verdicts only a verifier can record, the hook that refuses a ready pull request without a passing verdict, and the hooks that keep verifiers and reviewers observe-only. In a workspace of several repositories, `gate.mjs workspace set` makes one verdict cover every member, and the hook judges each command in the repository it runs in, following only a single leading `cd <path> &&`, `git -C`, and `gh --repo` with `--head`. The hook reads shell text, so it is a guardrail: it refuses what it can't read with confidence, and a change to its reader needs a test in `test/gate.test.mjs` for each command that must still be refused and each ordinary command that must still pass.
- `lib/second-opinion.mjs`: the cross-model review the reviewer runs, copied into every project as `.agents/scripts/second-opinion.mjs`.
- `lib/prompts.mjs`: the terminal checkbox and yes-or-no questions.
- `test/`: tests for the package, the skills' content, the agent team, the verification gate, and the sprint and `repos-report` scripts. They are not published and never reach a project. `test/fake-github.mjs` stands in for `gh`, so no test calls GitHub.
- `package.json`: the package name, the version recorded in each project's manifest, and what npm publishes.
- `.github/workflows/`: `test.yml` runs the tests on Linux, macOS, and Windows; `publish.yml` stages a tagged version on npm for the maintainer to approve.

## Rules for changing skills

1. Keep every skill project-agnostic. Never name a project, repository, organization, board, product, service vendor, command, path inside a product, or time zone in a skill or reference. `test/content.test.mjs` fails when a shipped file links a GitHub owner other than a placeholder such as `<owner>` or `acme`.
2. Put a project fact in the profile. When a skill needs a new kind of project fact, add a `TODO` row for it to the matching template in `skills/setup-project/templates/`, teach `setup-project` how to find it, and have the skill read it from `docs/agents/`. Follow the reading rules in `references/project-profile.md`.
3. Put a platform difference in a platform guide, not in a skill. Every guide keeps the same five sections, because skills refer to them by name: `Test seams`, `Runtime evidence`, `Bug feedback loops`, `Compatibility at boundaries`, and `Visible-first order`. To add a platform, add a guide with those sections, list it in `references/platforms/README.md`, and add its name to the platform row of the verification template.
4. Keep a shared model in one file under `references/` and link it from each skill with a relative path such as `../../references/software-quality-characteristics.md`. The same relative path resolves here and in an installed project. Do not restate a model inside a skill.
5. Refer to project files by their path from the project root in backticks, such as `docs/agents/verification.md`, not as relative links. They do not exist in this repository.
6. Keep each skill's safety and authorization rules when you edit it: what it may change, what needs approval, and where it stops.
7. Never hand-edit an adapter. The installer generates them from the canonical frontmatter.
8. Keep what the installer writes into a project's `AGENTS.md` and `CLAUDE.md` short and generic. It may fill only facts it reads with certainty, such as the repository from the Git remote; everything else stays `TODO` for `setup-project`. It owns only the section between the `agent-fleet:begin` and `agent-fleet:end` markers and never rewrites the rest of either file. The same holds for the `docs/agents/issue-tracker.md` it creates when missing: it fills only the settings it reads from GitHub, and never changes an existing file.
9. Keep the workflow opinionated. Every project has a GitHub repository, a logged-in GitHub CLI, and a linked project board with the `Status` options `Todo`, `In progress`, `In review`, and `Done` and an iteration field. The installer sets these up; skills rely on them and, when one is missing, stop and ask the user to run `npx @chustert/agent-fleet@latest update --dry-run` and then `npx @chustert/agent-fleet@latest update` in their own terminal rather than skipping the step. That command changes the board on GitHub, so a skill never runs it without the user's approval. When the user asks an agent to run it, the agent previews with `--dry-run --yes` and runs `update --yes` with the same flags only after the user approves that plan, as "Updating the installation" in `references/project-profile.md` describes. Every mention of the update in a shipped file words this rule the same way, and `test/content.test.mjs` checks each one. The installer changes the board only after an interactive yes, `--yes`, or a board named with `--board`. Every call the installer makes to GitHub goes through the `gh` function it is given, so tests can answer for GitHub.
10. Write code for Node.js 20 or later, using only its standard library. The package has no dependencies, and the scripts copied into projects must run with nothing but Node and the GitHub CLI. Keep paths recorded in the manifest in forward-slash form, so installations match on Windows.
11. Keep tests out of `skills/`. Everything there is copied into projects, where a project's own test runner would pick them up.
12. When a skill takes text from another author, keep that source's licence notice in a `LICENSE` file in the skill's folder, with a line naming the source and pinning its commit, and add the skill to the licence table in `README.md`. Take only text whose licence allows it, such as the MIT License. The fleet itself is under the MIT License in `LICENSE`.
13. Apply the `technical-writing` and `unslop` skills to every skill, reference, and document you write.
14. Bump `version` in `package.json` when a change alters shipped files: patch for fixes and wording, minor for new skills, sections, commands, or profile settings, major when an installed project's profile must change.
15. Keep the agent team in step with the skills. An agent runs skills; it never restates a skill's workflow, and its permissions never exceed what the skill and `docs/agents/autonomy.md` allow. The agents and automations may name Claude Code features, because the team is Claude Code's, but the other limits of rule 1 apply to them. When an agent names a skill, a script, or a gate hook, it must exist: `test/team.test.mjs` checks. `skills/lead-issue/briefs/` holds the same roles for any coding tool and will replace the agent definitions. The two already differ in one respect: in `lead-issue`, the developer prepares and opens the pull request, while the team's engineering lead still runs `prepare-pr` itself. Keep every other change to a role in its brief and its agent together until the agents are retired. A change to the gate needs a test in `test/gate.test.mjs` that shows the change, including a way around it that now fails.
16. Never weaken the verification gate to make a flow pass. When a legitimate flow hits the gate, change the flow or extend the gate with a test.

## Verification

Run the tests after any change, and report the results:

```sh
npm test
```

For a change to the installer or to how skills read the profile, also install into a scratch directory and read the installed result:

```sh
node bin/agent-fleet.mjs install <temporary-directory> --yes
```

The sprint and `repos-report` scripts call GitHub; test them against a real board only with read-only commands. The `repos-report` script also runs `git fetch` in each clone it reads.

## Releasing

The package is `@chustert/agent-fleet` on npm. The maintainer published 2.2.0 by hand, because npm sets up trusted publishing only for a package that already exists. Every later version goes through `publish.yml`.

### Set up trusted publishing once

The maintainer does this just before pushing the next version's tag, because npm drops a new trusted-publisher setup that has not published within 2 days.

1. On npmjs.com, open **Packages**, then `@chustert/agent-fleet`, **Settings**, and **Trusted publishing**, and choose **GitHub Actions**.
2. Enter `chustert` as the organization or user, `agent-fleet` as the repository, and `publish.yml` as the workflow filename, and leave the environment empty. Leave `npm publish` and `npm dist-tag` unticked under the allowed actions. `npm stage publish` is always allowed, so the workflow can stage a version but never put one live.
3. Under **Settings**, then **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, and a leaked token can no longer publish.

### Release a version

1. Bump `version` in `package.json` and merge the change to `main`.
2. Tag the merge commit as `v<version>`, such as `v2.3.0`, and push the tag. `publish.yml` tests the package, checks that the tag matches the version, stages the version on npm through trusted publishing, and creates the GitHub release. When the version is already on npm, it skips staging and only creates the release.
3. The maintainer approves the staged version with two-factor authentication, in the package's **Staged Packages** tab on npmjs.com or with `npm stage list @chustert/agent-fleet` and `npm stage approve <stage-id>`. Only then does it go live. Never approve a staged version on the maintainer's behalf.
4. Check the live version with `npm view @chustert/agent-fleet version`. The registry can take a few minutes to show it.

## Working rules

- Do not install into, or change, any other project unless the user asks for that project by name.
- Do not commit, push, publish, or tag unless the user explicitly authorizes it.
- Never add AI attribution lines to commits, pull requests, or issues.
