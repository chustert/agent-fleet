# Verification configuration

The workflow skills read this file for the commands and evidence that prove work in each component. Record commands exactly as they run, with their working directory. Mark a command `(documented, not yet run)` until someone has run it in this checkout.

`TODO` marks a value nobody has confirmed. `None` means the project deliberately does without it.

## Components

Repeat this section for every component in the routing table of `docs/agents/issue-tracker.md`.

### TODO component (`path/`)

| Setting | Value |
| --- | --- |
| Platform | TODO: `web`, `mobile`, `desktop`, `game`, `service`, `library-cli`, or `other`. The guide is `.agents/references/platforms/<platform>.md`. |
| Test harness | TODO: the runner, or `None` and the evidence that replaces it. |
| Focused test | TODO: how to run one test or file. |
| Final verification | TODO: the exact commands, in order, and their working directory. |
| Local run | TODO: how to start it locally. |
| Runtime evidence | TODO: how to observe it working, such as "a browser at `http://localhost:3000`", "the iOS simulator", "Play Mode in the editor", or "an HTTP request to the local API". When the component has several entry points, such as pages, a public API, and a script that other sites embed, list one entry for each. |
| Prerequisites | TODO: local services, seeded data, accounts, devices, engine or SDK versions, licences. |
| Deploys | TODO: what a merge or release triggers for this component, such as "a merge to `main` deploys it to production" or "a version tag publishes it to the package registry", or `None`. |

## Local stack

TODO: services a local run needs, how to start them, and how to check their health. Write `None` when components run standalone.

## Online, hosted, and paid services

Verification never contacts these without explicit approval for the specific check. Local evidence comes first.

| Service | Needed for | Rule |
| --- | --- | --- |
| TODO: such as production, staging, preview deployments | TODO | Ask first. Never change data there. |
| TODO: such as a payments sandbox, email delivery, an AI API, a store or platform service | TODO | Ask first. Sandbox or test mode only. Note any cost. |

## Protected files

Never open, print, search, copy, or diff these files. Use the committed example files and documentation instead.

- TODO: such as `.env`, `.env.local`, signing files, keystores, `*.tfvars`

A protected file listed here may be symlinked into a new worktree of the repository that owns it, so builds and local runs work there. Link it, never copy it, and never read its contents:

- TODO, or `None`

## Sensitive paths

A pull request that touches one of these paths states at least the minimum risk tier recorded here, as `.agents/references/pr-risk-tiers.md` describes. CI workflow files are always at least Medium and need no row. Owners decide this list. In a workspace of several repositories, add a `Repository` column after `Path`: a row with a repository applies only to that repository's pull requests, and a row without one applies to all of them.

| Path | Minimum tier | Why |
| --- | --- | --- |
| TODO: such as `db/migrations/**` | TODO: `Medium` or `High` | TODO: such as "a merge applies migrations to production" |

## Risk examples

This project's own examples for each risk tier, which the risk classifier reads beside the general examples in `.agents/references/pr-risk-tiers.md`. They describe kinds of change, not paths; a path that always needs a tier belongs under `Sensitive paths`. Owners decide them.

| Tier | Examples in this project |
| --- | --- |
| Low | TODO: such as "copy and translation changes" |
| Medium | TODO: such as "offline sync and local storage" |
| High | TODO: such as "row-level security policies" |

## Review worktree setup

A fresh worktree lacks ignored local files and installed dependencies.

- Dependencies: TODO, such as "symlink `node_modules` from the main checkout when the pull request does not change `package.json` or `package-lock.json`". When the pull request changes dependency files, installing them is a dependency change: ask first.
- Generated files and caches a build needs: TODO, or `None`.
