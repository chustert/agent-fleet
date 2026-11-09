# Pull request risk tiers

Every pull request states a risk tier, so a reviewer knows how much care it
needs before they read the diff. This file defines the tiers and how a change
gets one. `prepare-pr` applies it and records the result in the PR's `Risk`
section. Other skills link this file instead of restating it.

The tier is information for the reviewer. It does not set how many people
must approve the pull request.

## The change sets the tier, not the author

The author does not choose the tier. A classifier reads the diff in a
fresh-context subagent, as the [subagent rules](subagents.md) describe, so it
does not inherit the author's reasons for the change. It picks a tier from the
table below and cites the evidence in the diff. Then the path rules below
apply, and the pull request takes the higher of the two tiers. Nobody lowers
the result afterwards, neither the author nor the agent drafting the pull
request.

## Tiers

| Tier | Examples |
| --- | --- |
| Low | Documentation, copy, internal-only features, additive changes behind a flag |
| Medium | Ordinary product changes, and changes to sensitive areas such as caching, synchronisation, an auto-updater, or system prompts |
| High | The highest-risk code, such as authentication, authorisation, payments, data migrations, or anything that can lose or corrupt user data |

When a change sits between two tiers, pick the higher one. A change to a
contract at a boundary between parts that ship or version separately, as
`cross-boundary-contract` defines one, is never Low.

## Paths that set a minimum tier

A diff that touches a sensitive path is at least that path's minimum tier,
whatever the classifier decides:

- Every CI workflow file, such as `.github/workflows/**`, is at least Medium.
  CI workflows run with repository secrets and decide whether every other
  change passes.
- Every path the project lists under `Sensitive paths` in
  `docs/agents/verification.md` is at least the minimum tier recorded there.
  The project's owners decide that list; `setup-project` proposes entries and
  records only the ones they confirm.

While that list is missing or still `TODO`, apply the CI rule alone, and say in
the `Risk` section that the project's sensitive paths are not configured.
