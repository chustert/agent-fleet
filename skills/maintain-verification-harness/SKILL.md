---
name: maintain-verification-harness
description: Periodic audit that keeps the project's verify-<app> harness and feature map honest - parallel read-only source readers per feature, then one live pass driving every feature, ending clean, changed (one set of proven harness fixes) or blocked. Use on a schedule, after large merges, or when a verifier reports harness drift.
---

# Maintain the verification harness

A feature map rots the moment the app changes. This is the upkeep loop for the
harness `create-verification-harness` generated. The unit of rigour is the
feature: cover every feature file from source, and exercise every feature
live.

Adapted from pstack's `maintain-verification-skill`
(MIT). See `LICENSE`.

Invoking this skill authorizes editing the harness skill folder and its
adapters, and launching and driving the app locally. It does not authorize
editing product code, installing dependencies, committing, or contacting a
hosted or paid service.

## Outcomes

End with exactly one, and say which:

- **clean**: every feature got source and live coverage; nothing to change.
- **changed**: one set of proven corrections to the harness, ready for review
  as one change.
- **blocked**: coverage couldn't finish, or a proven fix couldn't be made
  safely. Say exactly what blocked it.

## Edit scope

Edit only `.agents/skills/verify-<app>/`, meaning its `SKILL.md`, `features/`
and the helper scripts it owns, and that skill's adapters. Never edit product code. A behaviour the map describes
that the app no longer does is either map drift (fix the map) or a product
regression (report it; never paper over it in the map).

## Pass

0. **Locate the target.** The harness named in the `Runtime evidence` rows of
   `docs/agents/verification.md`. If there is none, stop and recommend
   `create-verification-harness`.

1. **Index hygiene.** Read `features/README.md` and list its sibling files.
   Fix missing, extra, duplicate or dead entries.

2. **Source wave.** One read-only subagent per feature file, run side by side.
   Each explains how the feature works from source, flags likely drift with
   `file:line` citations, and returns one live-verification recipe. They never
   drive the app and never edit files. Return shape: summary, source entry
   points, likely drift or none, one recipe.

3. **Reconcile.** Every feature file has a summary back. Merge overlapping
   recipes into as few app states as practical. Spot-check cited drift. Sweep
   recent merges (`git log` since the last audit) for user-facing surfaces the
   map lacks; name a concrete source path before calling one missing.

4. **Live pass.** Required even when the source looks clean. You own all
   driving, following the harness's own launch model. Exercise every feature
   at least once, and hold three rules throughout:
   - Run Doctor before the first drive, on each fresh session, and after any
     failed drive. Where Doctor can't see the failure, reset or relaunch.
   - Evidence captured so far survives every cleanup, checked at its location.
   - Nothing a drive started outlives its use.

   A Doctor failure caused by harness drift is drift: fix it within the edit
   scope and retry once before calling the pass blocked. A feature that can't
   be reached is `verified-unreachable` only with the concrete prerequisite
   and the route attempted; a prerequisite the map omits is drift. Re-drive
   every harness fix live before keeping it.

5. **Triage.** Wrong or missing user-facing description: map drift, fix it.
   Working behaviour the harness can't drive: harness gap, fix it. App
   behaviour that's actually broken: product regression, report it to the
   user as a candidate issue, and keep it out of the harness changes.

6. **Report.** Features covered, unreachable prerequisites, confirmed drift,
   product regressions, the changed files (re-read each one first), and the
   outcome. Keep run notes in the run directory, not in the repository.
