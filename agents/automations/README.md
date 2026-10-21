# Automations for the agent team

The agent team runs in an interactive session: `claude --agent engineering-lead`.
These optional automations start work without you at the terminal. Each file
is a prompt or template to paste into the place it names. None of them runs
until you set it up.

| File | What it does | Where it runs |
| --- | --- | --- |
| `issue-intake.md` | Works on an issue handed over by `agent-issue.yml` | A Claude Code routine in the cloud |
| `agent-issue.yml` | A GitHub Actions workflow that hands an issue to that routine when an allowed person adds the `agent-ready` label | Copy it to `.github/workflows/` |
| `chat-triage.md` | Triages customer issue reports from a team chat channel and sends you a digest | A Claude Code routine with your chat's connector |
| `harness-maintenance.md` | The daily audit of the `verify-<app>` harness | A local Desktop scheduled task, or a routine |

Run each where the app can run. A cloud routine can build and drive web apps
and services. Anything that needs your machine, such as a mobile simulator or a
desktop app, needs a local session: start the lead and ask it to check for open
issues labelled `agent-ready` every 30 minutes and work them one at a time. It
uses `/loop`, which lasts as long as the session.

Routines, their API trigger and their limits are a research preview, so the
setup steps may change. Routines run as your account: their commits, pull
requests and messages appear as you.
