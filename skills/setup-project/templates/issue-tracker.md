# Issue tracker configuration

GitHub is the source of truth for this project's work items. The workflow skills in `.agents/skills/` read this file for tracker settings instead of hard-coding them. Resolve project, field, item, and option identifiers from GitHub every time; never record them here.

The agent-fleet installer creates this file and fills every tracker setting it can read from GitHub, including the project board it creates or links. The board is required, because the workflow moves every issue across it. When the board changes, or a skill finds it missing or incomplete, ask the user to run `npx agent-fleet@latest update --dry-run` and then `npx agent-fleet@latest update` in their own terminal. The update creates or repairs the project board on GitHub. Do not run it yourself without the user's approval. When the user asks you to run it, follow "Updating the installation" in `.agents/references/project-profile.md`. The update never rewrites this file. It records the board in `.agents/agent-fleet.json` and prints the value for the `Project board` row, and `setup-project` records it here.

`TODO` marks a value nobody has confirmed. `None` means the project deliberately does without it, which the board rows never allow.

## Tracker settings

| Setting | Value |
| --- | --- |
| Default repository | TODO: `owner/repo`. A bare issue number refers to this repository. |
| Owner type | TODO: `Organization` or `User`. GitHub issue types exist only for organizations. |
| Issue types | TODO: `Resolve from GitHub` when the organization uses them, otherwise `None`. |
| Fallback repository | TODO: where a new issue goes when its owning component is unclear. |
| Project board | TODO: the board's exact title, its owner, and its URL. |
| Status field | TODO: the single-select field that holds the lifecycle status, usually `Status`. |
| Lifecycle statuses | TODO: new → `Todo`; started → `In progress`; in review → `In review`; done → `Done`. |
| Iteration field | TODO: the iteration field's name, usually `Sprint`. |
| Sprint time zone | TODO: an IANA time zone, such as `Europe/Berlin`. |
| Default base branch | TODO: `main`. |
| Branch format | `<category>/<issue-number>-<slug>`, such as `feature/12-export-button`. |
| Labels | Use existing labels only. Typical mapping: TODO defect → `bug`, new capability → `enhancement`, documentation → `documentation`. |

## Routing

Each row is a component: a unit of ownership and verification. In a single repository the path column separates components. In a workspace of independent repositories each repository is usually one component.

| Component | Repository | Local path | Owns |
| --- | --- | --- | --- |
| TODO | `owner/repo` | `.` | TODO: what this component is responsible for, in the project's own words |

Mark a legacy or inactive component in its `Owns` cell, such as "Legacy API. Route work here only when an issue explicitly targets it." Give a repository that holds only planning or umbrella issues the local path `None`.

Work that spans components: TODO, such as "one issue in the default repository, unless it is too large for one reviewable pull request" or "an umbrella issue in `owner/planning` with a linked implementation issue in each affected repository".

Do not route work to a repository this table does not list. Inspect and register it first with `setup-project`.

## Operations

- Read issues and pull requests to understand scope and acceptance criteria.
- Link every issue, pull request, comment, or project item you name, following `.agents/references/github-references.md`.
- Before creating, editing, labelling, assigning, commenting on, or closing an issue, present the intended change unless the user's current request already authorizes it.
- Use the repository's existing labels. Do not create labels without explicit approval.
- Pull requests are not a triage request surface by default.

## Specifications

A longer specification may live in the repository when needed, but it links to the owning issue and does not create a parallel backlog.
