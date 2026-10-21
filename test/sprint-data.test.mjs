import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sd from "../skills/sprint-status/scripts/sprint-data.mjs";

const NAMES = { todo: "Todo", started: "In progress", review: "In review", done: "Done" };
const realGh = sd.io.gh;
const realWarn = sd.io.warn;
const SCRIPT = fileURLToPath(new URL("../skills/sprint-status/scripts/sprint-data.mjs", import.meta.url));
// Without PATH, a gh call fails to start instead of reaching GitHub.
const OFFLINE = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
  PATH: "" };

function item(number, status, iteration = null, assignees = ["me"], state = "OPEN") {
  return {
    repo: "acme/app", number, title: `Item ${number}`, url: `https://github.com/acme/app/issues/${number}`,
    type: "Issue", state, updatedAt: "2026-09-20T00:00:00Z", status, iteration, assignees, subIssues: null,
  };
}

/** Replace every gh call with a fake that answers GraphQL by owner type. */
function fakeGh(handler) {
  const calls = [];
  sd.io.gh = (args) => {
    calls.push(args);
    return JSON.stringify(handler(args));
  };
  return calls;
}

describe("owners and boards", () => {
  beforeEach(() => sd.clearCaches());
  afterEach(() => {
    sd.io.gh = realGh;
    sd.clearCaches();
  });

  test("the owner type picks the GraphQL root", () => {
    for (const [typename, root] of [["Organization", "organization"], ["User", "user"]]) {
      sd.clearCaches();
      fakeGh(() => ({ data: { repositoryOwner: { __typename: typename, login: "x" } } }));
      assert.equal(sd.ownerRoot("x"), root);
    }
  });

  test("owner queries substitute the root", () => {
    const calls = fakeGh((args) => (args.join(" ").includes("repositoryOwner")
      ? { data: { repositoryOwner: { __typename: "User", login: "acme" } } }
      : { data: { user: { ok: 1 } } }));
    assert.deepEqual(sd.ownerQuery(sd.PROJECT_QUERY, "acme", { num: 3 }), { ok: 1 });
    const query = calls.at(-1).find((arg) => arg.startsWith("query="));
    assert.match(query, /user\(login: \$owner\)/);
    assert.doesNotMatch(query, /__ROOT__/);
  });

  test("an unknown owner stops", () => {
    fakeGh(() => ({ data: { repositoryOwner: null } }));
    assert.throws(() => sd.ownerRoot("nobody"), sd.UsageError);
  });

  test("an exact open title is required", () => {
    const nodes = [
      { number: 1, title: "Sprints", url: "u1", closed: false },
      { number: 2, title: "Sprints (old)", url: "u2", closed: false },
      { number: 3, title: "Sprints", url: "u3", closed: true },
    ];
    assert.equal(sd.pickProject(nodes, "Sprints", "acme").number, 1);
    const twice = [1, 2].map((number) => ({ number, title: "Board", url: "u", closed: false }));
    for (const found of [twice, []]) assert.throws(() => sd.pickProject(found, "Board", "acme"), sd.UsageError);
  });

  test("null variables are omitted and integers are typed", () => {
    const calls = fakeGh(() => ({}));
    sd.graphql("q", { owner: "acme", num: 3, after: null });
    const args = calls[0];
    assert.ok(args.includes("-F") && args.includes("num=3"));
    assert.ok(!args.some((arg) => arg.startsWith("after=")));
  });
});

describe("iterations", () => {
  const FIELD = {
    name: "Sprint",
    configuration: {
      completedIterations: [{ title: "S1", startDate: "2026-09-07", duration: 14 }],
      iterations: [{ title: "S2", startDate: "2026-09-21", duration: 14 },
        { title: "S3", startDate: "2026-10-05", duration: 14 }],
    },
  };

  test("current and upcoming iterations", () => {
    const [current, upcoming] = sd.currentIteration(FIELD, "2026-09-26");
    assert.equal(current.title, "S2");
    assert.equal(current.day, 6);
    assert.equal(current.end, "2026-10-04");
    assert.deepEqual(upcoming.map((u) => u.title), ["S3"]);
  });

  test("the field is chosen by name, or the first one", () => {
    const other = { name: "Quarter", configuration: FIELD.configuration };
    const nodes = [{}, other, FIELD];
    assert.equal(sd.pickIterationField(nodes).name, "Quarter");
    assert.equal(sd.pickIterationField(nodes, "Sprint").name, "Sprint");
    assert.equal(sd.pickIterationField([{}]), null);
    assert.throws(() => sd.pickIterationField(nodes, "Missing"), sd.UsageError);
  });

  test("dates are validated and added across month ends", () => {
    assert.equal(sd.addDays("2026-09-21", 13), "2026-10-04");
    assert.throws(() => sd.isoDate("2026-02-30"), sd.UsageError);
    assert.equal(sd.isoDate("2026-02-28"), "2026-02-28");
  });
});

describe("today and the time zone", () => {
  const NOW = new Date("2026-09-26T20:00:00Z");

  test("--date comes first, then --timezone, then the machine's clock", () => {
    assert.deepEqual(sd.sprintToday("2026-09-01", null, NOW),
      { today: "2026-09-01", timezone: null, timezoneDefaulted: false });
    assert.deepEqual(sd.sprintToday(null, "Asia/Tokyo", NOW),
      { today: "2026-09-27", timezone: "Asia/Tokyo", timezoneDefaulted: false });
    const machine = sd.sprintToday(null, null, NOW);
    assert.equal(machine.timezoneDefaulted, true);
    assert.equal(machine.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    assert.equal(machine.today, sd.zoneToday(NOW, machine.timezone ?? undefined));
  });

  test("--timezone takes an IANA name", () => {
    const base = ["--owner", "acme", "--project", "Board", "--repo", "acme/app"];
    assert.equal(sd.parseArgs([...base, "--timezone", "Europe/Berlin"]).timezone, "Europe/Berlin");
    assert.equal(sd.parseArgs(base).timezone, null);
    assert.throws(() => sd.parseArgs([...base, "--timezone", "Mars/Base"]), /Unknown time zone "Mars\/Base"/);
  });
});

describe("classification", () => {
  test("a sprint board buckets items and finds unscheduled work", () => {
    const items = [item(1, "In progress", "S2"), item(2, "Todo", "S2"), item(3, "In review"), item(4, "Todo"),
      item(5, "Blocked", "S2"), item(6, "Done", "S2", ["me"], "CLOSED"), item(7, "In progress", "S2", ["someone"])];
    const out = sd.classify(items, "me", NAMES, "S2");
    const numbers = (list) => list.map((i) => i.number);
    assert.deepEqual(numbers(out.sprintItems.inProgress), [1]);
    assert.deepEqual(numbers(out.sprintItems.todo), [2]);
    assert.deepEqual(numbers(out.sprintItems.done), [6]);
    assert.deepEqual(Object.keys(out.sprintItems.otherStatuses), ["Blocked"]);
    assert.deepEqual(numbers(out.unscheduledActive), [3]);
    assert.deepEqual(numbers(out.backlogAssigned), [3, 4]);
  });

  test("the board's own status names map to the lifecycle roles", () => {
    const names = { todo: "Todo", started: "In Progress", review: "In review", done: "Done" };
    const out = sd.classify([item(1, "In Progress", "S2"), item(2, "In Progress")], "me", names, "S2");
    assert.deepEqual(out.sprintItems.inProgress.map((i) => i.number), [1]);
    assert.deepEqual(out.unscheduledActive.map((i) => i.number), [2]);
  });

  test("no current sprint leaves the sprint empty", () => {
    assert.deepEqual(sd.classify([item(1, "Todo", "S1")], "me", NAMES, null).sprintItems.todo, []);
  });

  test("the configured status and iteration fields are read", () => {
    const node = {
      content: {
        __typename: "Issue", number: 9, title: "T", url: "u", state: "OPEN", updatedAt: "x",
        repository: { nameWithOwner: "acme/app" }, assignees: { nodes: [{ login: "me" }] },
        subIssuesSummary: { total: 0 },
      },
      fieldValues: { nodes: [
        { name: "Doing", field: { name: "Stage" } },
        { name: "ignored", field: { name: "Priority" } },
        { title: "Cycle 4", field: { name: "Cycle" } },
      ] },
    };
    const flat = sd.flatten(node, "Stage", "Cycle");
    assert.deepEqual([flat.status, flat.iteration], ["Doing", "Cycle 4"]);
    assert.equal(sd.flatten(node, "Stage", null).iteration, null);
    assert.equal(sd.flatten({ content: {}, fieldValues: { nodes: [] } }, "Status", null), null);
  });
});

describe("arguments and search scope", () => {
  test("search scope uses the repositories, or the whole owner only with --all-repos", () => {
    assert.deepEqual(sd.scopeFlags("acme", ["acme/a", "acme/b"]), ["--repo=acme/a", "--repo=acme/b"]);
    assert.deepEqual(sd.scopeFlags("acme", [], true), ["--owner=acme"]);
    assert.throws(() => sd.scopeFlags("acme", []), sd.UsageError);
  });

  test("a repository or --all-repos is required, not both", () => {
    assert.throws(() => sd.parseArgs(["--owner", "acme", "--project", "Board"]), /--repo <owner\/repo>.*--all-repos/);
    assert.throws(() => sd.parseArgs(["--owner", "acme", "--project", "Board", "--repo", "acme/a", "--all-repos"]),
      /either --repo or --all-repos, not both/);
    const all = sd.parseArgs(["--owner", "acme", "--project", "Board", "--all-repos"]);
    assert.deepEqual([all.repos, all.allRepos], [[], true]);
  });

  test("each repository counts once, and a blank, malformed, or placeholder value stops", () => {
    const base = ["--owner", "acme", "--project", "Board"];
    assert.deepEqual(sd.parseArgs([...base, "--repo", "acme/app", "--repo", "acme/api", "--repo", "Acme/App"]).repos,
      ["acme/app", "acme/api"]);
    for (const value of ["", "not a repo", "acme", "acme/app/web", "`acme/app`"]) {
      assert.throws(() => sd.parseArgs([...base, "--repo", "acme/app", "--repo", value]), (error) =>
        error instanceof sd.UsageError
          && error.message.startsWith(`--repo takes a repository in the form owner/repo, not ${JSON.stringify(value)}.`));
    }
    assert.throws(() => sd.parseArgs([...base, "--repo", "owner/repo"]), /owner\/repo is the routing table's template/);
  });

  test("the command line stops with a usage error when no scope is given", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--owner", "acme", "--project", "Board"],
      { encoding: "utf8", env: OFFLINE });
    assert.equal(res.status, 1);
    assert.equal(res.stdout, "");
    assert.ok(res.stderr.startsWith(`${sd.SCOPE_REQUIRED}\n\nUsage:`), res.stderr);
  });

  test("--help prints the usage without a scope", () => {
    assert.match(sd.parseArgs(["--help"]).help, /^Usage: node sprint-data\.mjs --owner/);
    assert.equal(sd.main(["--help"]), sd.parseArgs(["--help"]).help);
  });

  test("flags map to settings with defaults", () => {
    const args = sd.parseArgs(["--owner", "acme", "--project", "Board", "--repo", "acme/a", "--repo=acme/b",
      "--started-status", "Doing"]);
    assert.deepEqual(args.repos, ["acme/a", "acme/b"]);
    assert.equal(args.allRepos, false);
    assert.equal(args.names.started, "Doing");
    assert.equal(args.names.todo, "Todo");
    assert.equal(args.statusField, "Status");
    assert.throws(() => sd.parseArgs(["--project", "Board", "--repo", "acme/a"]), sd.UsageError);
    assert.throws(() => sd.parseArgs(["--owner", "acme", "--repo", "acme/a"]), /--project is required/);
    assert.throws(() => sd.parseArgs(["--owner", "a", "--project", "B", "--repo", "a/b", "--date", "tomorrow"]),
      sd.UsageError);
  });

  test("a board problem asks the user to run the update, and gives the agent's steps", () => {
    assert.match(sd.REPAIR, /^Ask the user to run npx agent-fleet@latest update --dry-run and then npx agent-fleet@latest update in their own terminal\. /);
    assert.match(sd.REPAIR, / Do not run it yourself without the user's approval\. /);
    assert.match(sd.REPAIR, / run npx agent-fleet@latest update --dry-run --yes and show the user the plan it prints\. Run npx agent-fleet@latest update --yes only after the user approves that exact plan, with the same flags/);
    assert.match(sd.REPAIR, /Adding --force, which overwrites files changed by hand, needs its own approval\.$/);
    assert.throws(() => sd.pickProject([], "Board", "acme"), (error) => error.message.endsWith(sd.REPAIR));
  });

  test("comment excerpts collapse whitespace and stop at 400 characters", () => {
    assert.equal(sd.excerpt(" a\n\n b\tc "), "a b c");
    assert.equal(sd.excerpt("x".repeat(500)).length, 400);
  });
});

describe("collection", () => {
  /** A board with one sprint and no items, and no open PRs anywhere. */
  function board(args, { iterations = true } = {}) {
    const joined = args.join(" ");
    if (args[0] === "search") return [];
    if (joined.includes("viewer")) return { data: { viewer: { login: "me" } } };
    if (joined.includes("repositoryOwner")) return { data: { repositoryOwner: { __typename: "User", login: "acme" } } };
    if (joined.includes("projectsV2(first")) {
      return { data: { user: { projectsV2: { nodes: [{ number: 1, title: "Board", url: "u", closed: false }] } } } };
    }
    if (joined.includes("ProjectV2IterationField")) {
      const nodes = iterations ? [{ name: "Sprint", configuration: {
        iterations: [{ title: "S2", startDate: "2026-09-21", duration: 14 }], completedIterations: [] } }] : [];
      return { data: { user: { projectV2: { fields: { nodes } } } } };
    }
    if (joined.includes("items(first")) {
      return { data: { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
    }
    throw new Error(`unexpected gh ${joined}`);
  }

  const searches = (calls) => calls.filter((args) => args[0] === "search");
  const run = (...scope) => sd.collect(sd.parseArgs(["--owner", "acme", "--project", "Board", ...scope,
    "--date", "2026-09-26"]));
  let warnings;

  beforeEach(() => {
    sd.clearCaches();
    warnings = [];
    sd.io.warn = (message) => warnings.push(message);
  });
  afterEach(() => {
    sd.io.gh = realGh;
    sd.io.warn = realWarn;
    sd.clearCaches();
  });

  test("PR searches cover the listed repositories and never the whole owner", () => {
    const calls = fakeGh(board);
    assert.equal(run("--repo", "acme/app", "--repo", "acme/api").sprint.title, "S2");
    assert.equal(searches(calls).length, 3);
    for (const args of searches(calls)) {
      assert.ok(args.includes("--repo=acme/app") && args.includes("--repo=acme/api"), args.join(" "));
      assert.ok(!args.some((arg) => arg.startsWith("--owner=")), args.join(" "));
    }
  });

  test("a repository listed twice is searched once", () => {
    const calls = fakeGh(board);
    run("--repo", "acme/app", "--repo", "acme/app");
    assert.equal(searches(calls).length, 3);
    for (const args of searches(calls)) {
      assert.deepEqual(args.filter((arg) => arg.startsWith("--repo=")), ["--repo=acme/app"], args.join(" "));
    }
  });

  test("the sprint time zone picks today, without a warning", () => {
    fakeGh(board);
    // 2026-10-04 is the last day of S2 in UTC, and already 2026-10-05 in Tokyo.
    const out = sd.collect(sd.parseArgs(["--owner", "acme", "--project", "Board", "--repo", "acme/app",
      "--timezone", "Asia/Tokyo"]), new Date("2026-10-04T16:00:00Z"));
    assert.deepEqual([out.today, out.timezone, out.timezoneDefaulted], ["2026-10-05", "Asia/Tokyo", false]);
    assert.equal(out.sprint, null);
    assert.deepEqual(warnings, []);
  });

  test("without --timezone or --date, the machine's clock picks today, with a warning", () => {
    fakeGh(board);
    const out = sd.collect(sd.parseArgs(["--owner", "acme", "--project", "Board", "--repo", "acme/app"]),
      new Date("2026-09-26T12:00:00Z"));
    assert.deepEqual(warnings, [sd.MACHINE_CLOCK]);
    assert.equal(out.timezoneDefaulted, true);
    // Every time zone puts this instant inside S2.
    assert.equal(out.sprint.title, "S2");
  });

  test("--all-repos searches every repository the owner has", () => {
    const calls = fakeGh(board);
    run("--all-repos");
    assert.equal(searches(calls).length, 3);
    for (const args of searches(calls)) {
      assert.ok(args.includes("--owner=acme"), args.join(" "));
      assert.ok(!args.some((arg) => arg.startsWith("--repo=")), args.join(" "));
    }
  });

  test("a board without an iteration field asks for the update", () => {
    fakeGh((args) => board(args, { iterations: false }));
    assert.throws(() => run("--repo", "acme/app"), (error) => error instanceof sd.UsageError
      && error.message === `The board "Board" has no iteration field. ${sd.REPAIR}`);
  });
});
