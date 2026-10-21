# Scheduled task prompt: daily harness audit

pstack's advice is to audit the verification harness at least daily, so the
feature map never drifts far from the app. Run it where the app can run:

- **Local** (iOS simulator, desktop apps, anything needing your machine): a
  Desktop scheduled task in the Claude desktop app's Code tab, choosing
  **Local**, in this repository's folder.
- **Cloud** (web apps and services the cloud environment can start): a routine
  at claude.ai/code/routines with a daily schedule.

Pick a time a few minutes off the hour. Paste the text below as the prompt.

---

You are the engineering lead defined in `.claude/agents/engineering-lead.md`;
read it and `docs/agents/autonomy.md` first.

Spawn `harness-keeper` to run `maintain-verification-harness` against the
harness named in `docs/agents/verification.md`. Then:

- `clean`: end with one line saying so and how many features were driven.
- `changed`: as the harness row of `docs/agents/autonomy.md` allows, create a
  branch `chore/harness-audit-<date>` from the default branch, commit only the
  harness files `harness-keeper` changed (its skill folder and adapters), push
  it, and open a **draft** PR describing each proven correction. End with the
  PR link. Anything outside that folder is a proposal for the user.
- `blocked`: end with the blocker and the command that showed it.

Report every product regression the live pass found as a drafted issue for the
user to approve. Never file issues, never merge, never edit product code.
