# Models

The skills read this file whenever they start an agent: the role agents of `lead-issue`, and the helper subagents that `verify-work`, `pr-review`, `create-issue`, `prepare-pr` and `maintain-verification-harness` start. A skill you run yourself runs on your conversation's model, which this file cannot change.

Each row lists models in order of preference. The skill that starts the agent takes the first entry the host can start right now at that effort, as "Choose the model" in `.agents/references/subagents.md` describes. It never swaps in a model or effort the row does not list, and it records what it started.

Write each entry as `<model>, <effort>`, such as `<model name> <version>, High`, and put the provider first when the model's name alone could mean more than one. Separate entries with `; then`. `Same as the lead` means the model and effort of the conversation that starts the agent. When no entry is available, a row that ends with `Same as the lead` falls back to it, and any other row stops and asks the user. A missing row means `Same as the lead`. `setup-project` fills this file from the models the user's coding tools offer, after the user confirms each row.

## Roles

`Reviewer` is also the row for the independent review that `verify-work` and `pr-review` run in a subagent.

| Role | Models, first available wins |
| --- | --- |
| Developer | Same as the lead |
| Verifier | Same as the lead |
| Reviewer | Same as the lead |
| UX designer | Same as the lead |
| Spec writer | Same as the lead |
| Harness keeper | Same as the lead |

## Helper subagents

| Task | Models, first available wins |
| --- | --- |
| Area review | Same as the lead |
| Claim check | Same as the lead |
| Risk tier | Same as the lead |
| Feature audit | Same as the lead |

`Area review` is one area of a large diff in `pr-review`. `Claim check` is the check of a draft's factual claims in `create-issue`. `Risk tier` is the pull request risk classifier in `prepare-pr`. `Feature audit` is one feature file in `maintain-verification-harness`'s source wave.
