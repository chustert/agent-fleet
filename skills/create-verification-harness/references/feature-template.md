# <Feature name>

<One or two sentences, from the user's point of view: what the feature lets
them do, and the second place they can confirm it worked.>

## Sub-features

- `<feature-sub-1>` <what it does>.
- `<feature-sub-2>` <what it does>.

## How to get to it (user POV)

- <Every entry point: a button, a keyboard shortcut, a deep link, a menu, a
  CLI command, an API route.>

## Driving it with verify-<app>

Preconditions:

- <Doctor reports the expected URL, build and disposable data directory.>
- <Seed state the journey needs, such as "no record titled X exists".>

- **<Step name>.** <What the user does.> Run `<exact harness command>`.
  <The observable result that means this step worked.>
- **<Step name>.** <…>
- **Confirm persistence.** <Reach the result from a second view, or after a
  reload or relaunch.> Run `<command>`. <What proves it was stored.>
- **Proof.** Run `<screenshot / snapshot / response capture command>` into the
  evidence directory. <What the artifacts show.>

## Gotchas

- <Traps a cold reader would fall into: focus rules, trimming, async saves,
  "a success toast alone is not proof; reopen the record".>
- <Cleanup of fixtures this journey created; evidence is kept.>
