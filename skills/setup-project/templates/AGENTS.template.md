# {{project_name}}

<!-- The agent-fleet installer created this file. Replace every TODO, or run the setup-project skill to fill them from the project. Everything outside the agent-fleet section belongs to this project. -->

## Project intent

TODO: what this product is, who uses it, and what it must never get wrong, in two or three sentences.

## Source of truth

- Repository: {{repository}}
- TODO: where each component's code lives, which paths are legacy, and which files are the source of truth for the schema, configuration, or content. The routing table in `docs/agents/issue-tracker.md` lists the components.

## Local development

TODO: how to install dependencies and run the project locally, or a link to the guide that explains it.

## Working rules

- Branch from the latest remote default base branch as `<category>/<issue-number>-<slug>`, such as `feature/12-export-button`. Do not use tool prefixes such as `codex/` or `claude/`.
- Make the smallest relevant change, preserve unrelated work, and verify each affected component with its commands in `docs/agents/verification.md`.
- Do not commit, push, deploy, publish, open or update a pull request, apply a remote migration, or change an issue unless the user has explicitly authorized that action.
- TODO: rules specific to this project, such as a safety check before a migration or a file that must not move. Delete this line if there are none.

## Security and secrets

- Never open, print, search, copy, or diff the protected files listed in `docs/agents/verification.md`. Until that file lists them, treat the files `.agents/references/project-profile.md` names as protected. Use the committed example files instead.
- TODO: rules specific to this project, such as which keys must never reach client code. Delete this line if there are none.

## Completion checks

- Report the verification for each affected component separately, with the exact commands and results.
- For a change that crosses a boundary between separately shipped parts, state the rollout and rollback order.
- Call out any verification that needs credentials, a device or target hardware, hosted infrastructure, or explicit approval.
- Check that every GitHub object named in the report is linked.
