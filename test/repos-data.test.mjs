import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as sd from "../skills/sprint-status/scripts/sprint-data.mjs";
import * as rd from "../skills/repos-report/scripts/repos-data.mjs";

const TODAY = "2026-10-01";

function entry({ own = 1, date = "2026-09-28", mine = true, pr = null, worktree = null, upstream = null,
  contained = false, issue = null, review = null, detached = false } = {}) {
  return {
    branch: detached ? null : "feature/1-x", detached, ownCommits: own, lastCommit: { date, mine },
    pr, worktree, upstream, containedInPr: contained, issue, reviewOf: review,
  };
}

const pr = (state, mine = true) => ({ number: 5, state, mine });
const category = (e) => rd.classify(e, TODAY, 14)[0];

describe("parsing git output", () => {
  test("worktrees with a branch, detached, and prunable", () => {
    const text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\n"
      + "worktree /w1\nHEAD bbb\ndetached\n\n"
      + "worktree /w2\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n";
    const out = rd.parseWorktrees(text);
    assert.deepEqual(out.map((w) => w.path), ["/r", "/w1", "/w2"]);
    assert.equal(out[0].branch, "main");
    assert.ok(out[1].detached);
    assert.ok(out[2].prunable);
  });

  test("status skips the original path of a rename", () => {
    assert.deepEqual(rd.parseStatus(" M a.swift\0R  new.swift\0old.swift\0?? t/b.swift\0"),
      ["a.swift", "new.swift", "t/b.swift"]);
  });

  test("branch names yield an issue or a PR number", () => {
    assert.deepEqual(rd.branchRefs("fix/242-remove-thumbnails"), [242, null]);
    assert.deepEqual(rd.branchRefs("agent/129-node-24-upgrade"), [129, null]);
    assert.deepEqual(rd.branchRefs("review/pr-189"), [null, 189]);
    assert.deepEqual(rd.branchRefs("agent/review-pr-167-admin-views"), [null, 167]);
    assert.deepEqual(rd.branchRefs("pr-167-r2"), [null, 167]);
    assert.deepEqual(rd.branchRefs("release/1.1.3"), [null, null]);
    assert.deepEqual(rd.branchRefs("feature/new-onboarding"), [null, null]);
  });

  test("GitHub remotes yield owner/repo, and other hosts nothing", () => {
    assert.equal(rd.githubSlug("https://github.com/acme/app.git"), "acme/app");
    assert.equal(rd.githubSlug("git@github.com:acme/app.git"), "acme/app");
    assert.equal(rd.githubSlug("ssh://git@github.com/acme/app"), "acme/app");
    assert.equal(rd.githubSlug("https://gitlab.com/acme/app.git"), null);
  });

  test("paths show from the folder holding the project, else from home", () => {
    const home = path.resolve(os.tmpdir(), "home");
    const parent = path.join(home, "code");
    assert.equal(rd.displayPath(path.join(parent, "app"), parent, home), "app");
    assert.equal(rd.displayPath(path.join(parent, "app-wt", "12"), parent, home), path.join("app-wt", "12"));
    assert.equal(rd.displayPath(path.join(home, "wt", "a"), parent, home), `~${path.sep}${path.join("wt", "a")}`);
    assert.equal(rd.displayPath(`${home}2`, null, home), `${home}2`);
  });
});

describe("classification", () => {
  test("uncommitted changes are active even on a merged branch", () => {
    const e = entry({ pr: pr("MERGED"), contained: true, upstream: { unpushed: 0, behind: 0 },
      worktree: { dirty: 3, newestEdit: "2026-09-30" } });
    assert.deepEqual(rd.classify(e, TODAY, 14), [rd.ACTIVE, ["3 uncommitted files, newest edit 2026-09-30"]]);
  });

  test("an open PR splits by author", () => {
    assert.equal(category(entry({ pr: pr("OPEN") })), rd.ACTIVE);
    assert.equal(category(entry({ pr: pr("OPEN", false) })), rd.OTHERS);
  });

  test("a merged PR that holds every commit is merged", () => {
    assert.equal(category(entry({ own: 4, pr: pr("MERGED"), contained: true })), rd.MERGED);
  });

  test("an unverifiable merge is not called safe", () => {
    assert.equal(category(entry({ own: 4, date: "2026-08-01", pr: pr("MERGED"), contained: null })), rd.UNMERGED);
  });

  test("an empty branch is a placeholder only for an open issue", () => {
    assert.equal(category(entry({ own: 0, issue: { state: "OPEN", isIssue: true } })), rd.PLACEHOLDER);
    assert.equal(category(entry({ own: 0, issue: { state: "OPEN", isIssue: false } })), rd.EMPTY);
    assert.equal(category(entry({ own: 0 })), rd.EMPTY);
  });

  test("recent unmerged commits are active and old ones dormant", () => {
    assert.equal(category(entry({ date: "2026-09-20" })), rd.ACTIVE);
    assert.equal(category(entry({ date: "2026-09-20", mine: false })), rd.OTHERS);
    assert.equal(category(entry({ date: "2026-09-01" })), rd.UNMERGED);
  });

  test("a closed PR is unmerged however recent", () => {
    assert.deepEqual(rd.classify(entry({ pr: pr("CLOSED") }), TODAY, 14),
      [rd.UNMERGED, ["PR closed without merging", "local only"]]);
  });

  test("a review checkout follows the reviewed PR", () => {
    const review = { number: 189, state: "MERGED", mine: false, contained: true };
    assert.deepEqual(rd.classify(entry({ review }), TODAY, 14), [rd.MERGED, ["review checkout of merged PR #189"]]);
    assert.equal(category(entry({ review: { ...review, state: "OPEN" } })), rd.OTHERS);
    assert.equal(category(entry({ date: "2026-08-01", review: { ...review, contained: false } })), rd.UNMERGED);
  });

  test("a missing worktree wins", () => {
    assert.equal(category(entry({ worktree: { missing: true, dirty: 0 } })), rd.MISSING);
  });

  test("push state gives reasons", () => {
    const unpushed = entry({ date: "2026-08-01", upstream: { unpushed: 1, behind: 0 } });
    assert.deepEqual(rd.classify(unpushed, TODAY, 14), [rd.UNMERGED, ["1 commit not pushed"]]);
    assert.deepEqual(rd.classify(entry({ date: "2026-08-01", detached: true }), TODAY, 14), [rd.UNMERGED, []]);
  });
});

describe("issue map", () => {
  const repos = [{
    repo: "acme/app",
    entries: [
      { branch: "feature/12-export", issueRef: 12, pr: null, category: "active", reasons: [], ownCommits: 2,
        worktree: { display: "~/wt/12", dirty: 1 } },
      { branch: "fix/login", issueRef: null, category: "others", reasons: [], ownCommits: 1, worktree: null,
        pr: { number: 30, url: "u30", state: "OPEN", closes: [{ repo: "acme/api", number: 7, url: "u7" }] } },
      { branch: null, detached: true, category: "missing", reasons: ["worktree folder is gone"] },
    ],
  }];
  const item = (repo, number, extra = {}) => ({ repo, number, title: `T${number}`, url: `u${number}`,
    status: "In progress", iteration: "S1", assignees: ["me"], subIssues: null, ...extra });

  test("an issue lives where a branch names it or an open PR closes it", () => {
    const [named, closed, elsewhere] = rd.issueLocations([item("Acme/App", 12), item("acme/api", 7),
      item("acme/web", 3)], repos);
    assert.deepEqual(named.locations.map((l) => [l.branch, l.worktree, l.dirty]), [["feature/12-export", "~/wt/12", 1]]);
    assert.ok(named.localClone);
    assert.deepEqual(closed.locations.map((l) => l.pr.number), [30]);
    assert.ok(!closed.localClone);
    assert.deepEqual(elsewhere.locations, []);
  });

  test("an open sub-issue's branch counts for its parent", () => {
    const children = [{ repo: "acme/app", number: 12, state: "OPEN" }, { repo: "acme/app", number: 13, state: "CLOSED" }];
    const [parent] = rd.issueLocations([item("acme/app", 11, { subIssues: { total: 2, completed: 1, children } })], repos);
    assert.deepEqual(parent.locations.map((l) => l.branch), ["feature/12-export"]);
  });
});

describe("at a glance", () => {
  const data = (entries, { rootBranch = "main", behind = 0, notLocal = [] } = {}) => ({ repositories: [{
    repo: "acme/app", entries, localDefaultBehind: behind,
    rootCheckout: { branch: rootBranch, display: "code/app", dirty: 0 }, openPrsNotLocal: notLocal,
  }] });
  const row = (branch, category, { worktree = null, own = 1, ...extra } = {}) => ({
    branch, head: "abc1234", category, reasons: [], ownCommits: own,
    lastCommit: { date: "2026-09-30", author: "kay", mine: false }, worktree, pr: null, issue: null, ...extra,
  });

  test("the root on the default branch, and dormant branches collapsed into counts", () => {
    const out = rd.renderOverview(data([row("a", rd.MERGED), row("b", rd.EMPTY, { own: 0 }), row("c", rd.UNMERGED)],
      { behind: 1 }));
    assert.ok(out.startsWith("## At a glance\n\n🟢 your active work"));
    assert.ok(out.includes("| 🏠 | `code/app` (main checkout) | `main` | — | — | local copy 1 commit behind origin |"));
    assert.ok(out.includes("| ⚪ | no worktree | 2 merged or empty branches | — | — | safe to delete |"));
    assert.ok(out.includes("| 🟠 | no worktree | 1 never-merged branch | — | — | decide before deleting |"));
  });

  test("worktrees sort by category, and an issue its PR closes is linked once", () => {
    const url = "https://github.com/acme/app/issues/9";
    const pr = { number: 12, url: "https://github.com/acme/app/pull/12", state: "OPEN",
      closes: [{ repo: "acme/app", number: 9, url }] };
    const issue = { repo: "acme/app", number: 9, url, state: "OPEN", isIssue: true };
    const wt = (name) => ({ display: `worktrees/${name}`, isMain: false, dirty: 0 });
    const out = rd.renderOverview(data([
      row("old", rd.EMPTY, { worktree: wt("z-old"), own: 0 }),
      row("fix/9-x", rd.OTHERS, { worktree: wt("y-fix"), pr, issue }),
    ]));
    const rows = out.split("\n").filter((line) => line.includes("worktrees/"));
    assert.ok(rows[0].startsWith("| 🔵 | `worktrees/y-fix`"));
    assert.equal(rows[0].split(url).length - 1, 1);
    assert.ok(rows[0].includes("2026-09-30 · kay"));
    assert.equal(rows[1], "| ⚪ | `worktrees/z-old` | `old` | — | — | — |");
  });

  test("every category has an icon", () => {
    for (const category of [rd.ACTIVE, rd.PLACEHOLDER, rd.OTHERS, rd.MERGED, rd.EMPTY, rd.MISSING, rd.UNMERGED]) {
      assert.ok(rd.ICONS[category], category);
    }
  });
});

describe("arguments", () => {
  test("saved data renders without collecting or a board", () => {
    assert.deepEqual(rd.parseArgs(["--from-json", "report.json", "--format", "overview"]),
      { fromJson: "report.json", format: "overview" });
    assert.throws(() => rd.parseArgs(["--from-json", "report.json", "--format", "html"]), /json or overview/);
    assert.throws(() => rd.main(["--from-json", path.join(os.tmpdir(), "no-such-report.json")]), sd.UsageError);
  });

  test("board flags map to settings with defaults", () => {
    const args = rd.parseArgs(["--owner", "acme", "--project", "Board", "--path", ".", "--path=api",
      "--started-status", "Doing", "--active-days", "7"]);
    assert.deepEqual(args.paths, [".", "api"]);
    assert.equal(args.activeDays, 7);
    assert.ok(args.fetch);
    assert.equal(args.board.names.started, "Doing");
    assert.equal(args.board.statusField, "Status");
  });

  test("the board is required unless the issue map is skipped", () => {
    assert.throws(() => rd.parseArgs(["--owner", "acme"]), /--no-sprint/);
    const args = rd.parseArgs(["--no-sprint", "--no-fetch"]);
    assert.equal(args.board, null);
    assert.ok(!args.fetch);
    assert.throws(() => rd.parseArgs(["--no-sprint", "--active-days", "two"]), sd.UsageError);
    assert.throws(() => rd.parseArgs(["--no-sprint", "--date", "2026-02-30"]), sd.UsageError);
  });

  test("--timezone takes an IANA name", () => {
    assert.equal(rd.parseArgs(["--no-sprint", "--timezone", "Europe/Berlin"]).timezone, "Europe/Berlin");
    assert.equal(rd.parseArgs(["--no-sprint"]).timezone, null);
    assert.throws(() => rd.parseArgs(["--no-sprint", "--timezone", "Mars/Base"]), /Unknown time zone "Mars\/Base"/);
  });
});

/**
 * A GitHub remote kept on disk. Its path ends in github.com/acme/app.git, so
 * the collector reads acme/app from it exactly as from a real remote URL.
 */
describe("a clone with branches in every state", () => {
  const realGh = sd.io.gh;
  const ghCalls = [];
  let dir;
  let app;
  let shas;

  const env = (name, date) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.com`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.com`,
    GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` });

  function git(cwd, args, { name = "me", date = "2026-08-01" } = {}) {
    const res = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args],
      { encoding: "utf8", env: env(name, date) });
    assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  }

  const commit = (cwd, message, options) => {
    git(cwd, ["commit", "-q", "--allow-empty", "-m", message], options);
    return git(cwd, ["rev-parse", "HEAD"]);
  };

  function fakeGh(args) {
    const joined = args.join(" ");
    const issue = (number) => ({ title: `Issue ${number}`, html_url: `https://github.com/acme/app/issues/${number}`,
      state: "open" });
    const answer = (() => {
      if (joined.includes("viewer")) return { data: { viewer: { login: "me" } } };
      if (joined.startsWith("pr list") && joined.includes("closingIssuesReferences")) {
        return [{ number: 6, closingIssuesReferences: [
          { number: 4, url: "https://github.com/acme/app/issues/4", repository: { owner: { login: "acme" }, name: "app" } },
        ] }];
      }
      if (joined.startsWith("pr list")) {
        return [
          { number: 2, title: "Merged work", url: "https://github.com/acme/app/pull/2", state: "MERGED", isDraft: false,
            headRefName: "feature/2-merged", headRefOid: shas.prHead, author: { login: "me" } },
          { number: 6, title: "Their work", url: "https://github.com/acme/app/pull/6", state: "OPEN", isDraft: false,
            headRefName: "feature/6-other", headRefOid: shas.other, author: { login: "other" },
            updatedAt: "2026-09-28T10:00:00Z" },
        ];
      }
      if (/^api repos\/acme\/app\/issues\/[13]$/.test(joined)) return issue(Number(joined.at(-1)));
      if (joined.startsWith("api repos/")) throw new sd.UsageError("gh api failed: Not Found (HTTP 404)");
      if (joined.includes("repositoryOwner")) return { data: { repositoryOwner: { __typename: "User", login: "acme" } } };
      if (joined.includes("projectsV2(first")) {
        return { data: { user: { projectsV2: { nodes: [
          { number: 1, title: "app Sprints", url: "https://github.com/users/acme/projects/1", closed: false },
        ] } } } };
      }
      if (joined.includes("ProjectV2IterationField")) {
        return { data: { user: { projectV2: { fields: { nodes: [{ name: "Sprint", configuration: {
          iterations: [{ title: "Sprint 1", startDate: "2026-09-21", duration: 14 }], completedIterations: [],
        } }] } } } } };
      }
      if (joined.includes("items(first")) {
        const node = (number, status, iteration, repo = "acme/app", assignee = "me") => ({
          content: { __typename: "Issue", number, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`,
            state: "OPEN", updatedAt: "2026-09-30T00:00:00Z", repository: { nameWithOwner: repo },
            assignees: { nodes: [{ login: assignee }] }, subIssuesSummary: { total: 0 } },
          fieldValues: { nodes: [{ name: status, field: { name: "Status" } },
            ...(iteration ? [{ title: iteration, field: { name: "Sprint" } }] : [])] },
        });
        return { data: { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          node(1, "In progress", "Sprint 1"), node(3, "Todo", "Sprint 1"), node(4, "In review", null),
          node(9, "Todo", "Sprint 1", "acme/api"), node(10, "In progress", "Sprint 1", "acme/app", "other"),
        ] } } } } };
      }
      throw new Error(`unexpected gh ${joined}`);
    })();
    return JSON.stringify(answer);
  }

  before(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "repos-report-")));
    const origin = path.join(dir, "github.com", "acme", "app.git");
    const url = origin.replaceAll("\\", "/");
    const seed = path.join(dir, "seed");
    app = path.join(dir, "app");
    shas = {};
    fs.mkdirSync(origin, { recursive: true });
    git(origin, ["init", "-q", "--bare", "-b", "main"]);
    git(dir, ["init", "-q", "-b", "main", seed]);
    fs.mkdirSync(path.join(seed, "web"));
    fs.writeFileSync(path.join(seed, "web", "README.md"), "web\n");
    git(seed, ["add", "-A"]);
    commit(seed, "Start");
    git(seed, ["push", "-q", url, "main"]);

    // PR 2: pushed as a branch, reviewed once more, squash-merged, and its branch deleted.
    git(seed, ["switch", "-q", "-c", "feature/2-merged"]);
    shas.merged = commit(seed, "Work on #2", { date: "2026-09-10" });
    git(seed, ["push", "-q", url, "feature/2-merged"]);
    shas.prHead = commit(seed, "Review fixes", { date: "2026-09-12" });
    git(seed, ["push", "-q", url, "HEAD:refs/pull/2/head"]);
    git(seed, ["switch", "-q", "main"]);
    commit(seed, "Squash merge #2", { date: "2026-09-13" });

    // PR 6: someone else's open work that nobody checked out here.
    git(seed, ["switch", "-q", "-c", "feature/6-other"]);
    shas.other = commit(seed, "Their work", { name: "other", date: "2026-09-28" });
    git(seed, ["switch", "-q", "main"]);
    git(seed, ["push", "-q", url, "main", "feature/6-other"]);

    // --no-local, so the clone lacks objects no branch reaches, as a clone from GitHub does.
    git(dir, ["clone", "-q", "--no-local", url, app]);
    git(app, ["config", "user.name", "me"]);
    git(app, ["config", "user.email", "me@example.com"]);
    git(app, ["branch", "-q", "--track", "feature/2-merged", "origin/feature/2-merged"]);
    git(app, ["branch", "-q", "--no-track", "feature/3-placeholder", "origin/main"]);
    git(app, ["switch", "-q", "-c", "old-experiment"]);
    commit(app, "An idea", { date: "2026-06-01" });
    git(app, ["switch", "-q", "main"]);
    git(app, ["worktree", "add", "-q", "--no-track", "-b", "feature/1-active", path.join(dir, "wt", "1-active"),
      "origin/main"]);
    fs.writeFileSync(path.join(dir, "wt", "1-active", "draft.txt"), "draft\n");
    git(app, ["worktree", "add", "-q", "--no-track", "-b", "feature/5-gone", path.join(dir, "wt", "5-gone"),
      "origin/main"]);
    fs.rmSync(path.join(dir, "wt", "5-gone"), { recursive: true, force: true });

    // After the clone: the remote branch of PR 2 goes, and main moves on.
    git(seed, ["push", "-q", url, "--delete", "feature/2-merged"]);
    commit(seed, "Later work", { date: "2026-09-20" });
    git(seed, ["push", "-q", url, "main"]);

    sd.clearCaches();
    sd.io.gh = (args) => {
      ghCalls.push(args);
      return fakeGh(args);
    };
  });

  after(() => {
    sd.io.gh = realGh;
    sd.clearCaches();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const byBranch = (report) => Object.fromEntries(report.repositories[0].entries.map((e) => [e.branch, e]));

  // Runs first, because the fetching run below adds the PR head to the clone.
  test("without fetching, a squash merge cannot be confirmed", () => {
    const args = rd.parseArgs(["--no-sprint", "--no-fetch", "--path", "app", "--date", TODAY]);
    const merged = byBranch(rd.collect(args, dir))["feature/2-merged"];
    assert.equal(merged.category, rd.UNMERGED);
    assert.equal(merged.containedInPr, null);
  });

  test("every branch lands in its category, and each sprint issue finds its branch", () => {
    // app/web is a folder inside the clone, like a component of a monorepo.
    const args = rd.parseArgs(["--owner", "acme", "--project", "app Sprints", "--path", "app", "--path", "app/web",
      "--path", "missing", "--date", TODAY]);
    const report = rd.collect(args, dir);
    assert.deepEqual(report.skippedRepositories, ["missing"]);
    assert.equal(report.repositories.length, 1);
    const [repo] = report.repositories;
    assert.equal(repo.repo, "acme/app");
    assert.deepEqual(repo.rootCheckout, { branch: "main", display: path.join(path.basename(dir), "app"), dirty: 0 });
    assert.equal(repo.localDefaultBehind, 1);

    const entries = byBranch(report);
    assert.deepEqual(Object.fromEntries(Object.entries(entries).map(([name, e]) => [name, e.category])), {
      "feature/1-active": rd.ACTIVE,
      "feature/2-merged": rd.MERGED,
      "feature/3-placeholder": rd.PLACEHOLDER,
      "feature/5-gone": rd.MISSING,
      "old-experiment": rd.UNMERGED,
    });
    assert.equal(entries["feature/1-active"].worktree.dirty, 1);
    assert.ok(entries["feature/2-merged"].upstream.gone);
    assert.equal(entries["feature/2-merged"].pr.number, 2);
    assert.equal(entries["feature/3-placeholder"].issue.url, "https://github.com/acme/app/issues/3");
    assert.deepEqual(entries["old-experiment"].reasons, ["local only"]);
    assert.deepEqual(repo.openPrsNotLocal.map((p) => p.number), [6]);

    const issues = Object.fromEntries(report.sprint.issues.map((i) => [`${i.repo}#${i.number}`, i]));
    assert.deepEqual(Object.keys(issues).sort(), ["acme/api#9", "acme/app#1", "acme/app#3", "acme/app#4"]);
    assert.deepEqual(issues["acme/app#1"].locations.map((l) => [l.branch, l.category]), [["feature/1-active", rd.ACTIVE]]);
    assert.deepEqual(issues["acme/app#3"].locations.map((l) => l.branch), ["feature/3-placeholder"]);
    assert.ok(issues["acme/app#4"].unscheduled);
    assert.deepEqual(issues["acme/app#4"].locations, []);
    assert.ok(!issues["acme/api#9"].localClone);
    assert.equal(report.sprint.current.title, "Sprint 1");
  });

  test("saved data renders as the at-a-glance tables", () => {
    const saved = path.join(dir, "report.json");
    const args = rd.parseArgs(["--no-sprint", "--no-fetch", "--path", "app", "--date", TODAY]);
    fs.writeFileSync(saved, JSON.stringify(rd.collect(args, dir)));
    const out = rd.main(["--from-json", saved, "--format", "overview"]);
    const rows = out.split("\n").filter((line) => /^\| \S+ \| /.test(line));
    assert.deepEqual(rows.map((line) => line.split(" | ")[0].slice(2)), ["🏠", "🟢", "⚫", "🟡", "🔵", "⚪", "🟠"]);
    const shown = (...parts) => path.join(path.basename(dir), ...parts);
    assert.ok(out.includes(`| 🏠 | \`${shown("app")}\` (main checkout) | \`main\` | — | — | `
      + "local copy 1 commit behind origin |"));
    assert.ok(rows[1].startsWith(`| 🟢 | \`${shown("wt", "1-active")}\` | \`feature/1-active\` | `
      + "[app#1](https://github.com/acme/app/issues/1) | — | 1 uncommitted file"));
    assert.ok(out.includes("| 🟡 | no worktree | `feature/3-placeholder` | [app#3](https://github.com/acme/app/issues/3) "
      + "| — | — |"));
    assert.ok(out.includes("| 🔵 | not checked out | `feature/6-other` | [app#6](https://github.com/acme/app/pull/6) open "
      + "| 2026-09-28 · other | — |"));
    assert.ok(out.includes("| ⚪ | no worktree | 1 merged or empty branch | — | — | safe to delete |"));
  });

  test("the issue map reads the board and searches no owner's repositories", () => {
    ghCalls.length = 0;
    const args = rd.parseArgs(["--owner", "acme", "--project", "app Sprints", "--path", "app", "--no-fetch",
      "--date", TODAY]);
    assert.equal(rd.collect(args, dir).sprint.issues.length, 4);
    assert.ok(ghCalls.some((call) => call.join(" ").includes("items(first")));
    assert.deepEqual(ghCalls.filter((call) => call[0] === "search" || call.some((arg) => arg.startsWith("--owner="))),
      []);
  });

  test("a board problem leaves the branch report and asks for the update with approval", () => {
    const args = rd.parseArgs(["--owner", "acme", "--project", "Missing board", "--path", "app", "--no-fetch",
      "--date", TODAY]);
    const report = rd.collect(args, dir);
    assert.equal(report.repositories.length, 1);
    assert.ok(report.sprint.error.endsWith(sd.REPAIR), report.sprint.error);
    assert.match(report.sprint.error, /Ask the user to run npx agent-fleet@latest update --dry-run and then /);
    assert.match(report.sprint.error, /Do not run it yourself without the user's approval\./);
  });

  test("the sprint time zone picks today; without it the machine's clock does, with a warning", () => {
    const realWarn = sd.io.warn;
    const warnings = [];
    sd.io.warn = (message) => warnings.push(message);
    try {
      // Already 2026-10-02 in Tokyo, still 2026-10-01 in UTC.
      const now = new Date("2026-10-01T16:00:00Z");
      const zoned = rd.collect(rd.parseArgs(["--no-sprint", "--no-fetch", "--path", "app",
        "--timezone", "Asia/Tokyo"]), dir, now);
      assert.deepEqual([zoned.today, zoned.timezone, zoned.timezoneDefaulted], ["2026-10-02", "Asia/Tokyo", false]);
      assert.deepEqual(warnings, []);
      const machine = rd.collect(rd.parseArgs(["--no-sprint", "--no-fetch", "--path", "app"]), dir, now);
      assert.equal(machine.timezoneDefaulted, true);
      assert.deepEqual(warnings, [sd.MACHINE_CLOCK]);
    } finally {
      sd.io.warn = realWarn;
    }
  });
});
