#!/usr/bin/env node
/**
 * Collect sprint and review state for the authenticated GitHub user.
 *
 * Emits JSON on stdout. All GitHub access goes through `gh`, so it uses
 * whatever account `gh auth status` reports. Board queries need the
 * `read:project` scope.
 *
 * Nothing here names a project. The skill reads the owner, board, repositories,
 * field names, lifecycle statuses, and sprint time zone from the project's
 * docs/agents/issue-tracker.md and passes them as flags. The owner can be an
 * organization or a user; the script detects which. Only Node's standard
 * library is used.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs as parseFlags } from "node:util";

const OWNER_QUERY = `
query($login: String!) {
  repositoryOwner(login: $login) { __typename login }
}`;

// __ROOT__ becomes `organization` or `user`, depending on the owner.
export const PROJECTS_QUERY = `
query($owner: String!, $title: String!) {
  __ROOT__(login: $owner) {
    projectsV2(first: 50, query: $title) {
      nodes { number title url closed }
    }
  }
}`;

export const PROJECT_QUERY = `
query($owner: String!, $num: Int!) {
  __ROOT__(login: $owner) {
    projectV2(number: $num) { number title url closed }
  }
}`;

const ITEMS_QUERY = `
query($owner: String!, $num: Int!, $after: String) {
  __ROOT__(login: $owner) {
    projectV2(number: $num) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            __typename
            ... on Issue {
              number title url state createdAt updatedAt
              repository { nameWithOwner }
              assignees(first: 10) { nodes { login } }
              subIssuesSummary { total completed }
              subIssues(first: 30) {
                nodes {
                  number title url state
                  repository { nameWithOwner }
                  assignees(first: 10) { nodes { login } }
                }
              }
            }
            ... on PullRequest {
              number title url state createdAt updatedAt
              repository { nameWithOwner }
              assignees(first: 10) { nodes { login } }
            }
          }
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title startDate duration
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}`;

const ITERATION_QUERY = `
query($owner: String!, $num: Int!) {
  __ROOT__(login: $owner) {
    projectV2(number: $num) {
      fields(first: 50) {
        nodes {
          ... on ProjectV2IterationField {
            name
            configuration {
              iterations { title startDate duration }
              completedIterations { title startDate duration }
            }
          }
        }
      }
    }
  }
}`;

/** A problem the user can fix. The command line prints its message and exits with 1. */
export class UsageError extends Error {}

/** Swappable in tests: every GitHub call goes through io.gh, and every warning through io.warn. */
export const io = {
  warn(message) {
    process.stderr.write(`Warning: ${message}\n`);
  },
  gh(args) {
    const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (res.error) {
      throw new UsageError(res.error.code === "ENOENT"
        ? "The GitHub CLI (gh) is not installed or not on PATH."
        : `gh failed to start: ${res.error.message}`);
    }
    if (res.status !== 0) {
      const err = (res.stderr ?? "").trim();
      if (err.includes("read:project")) {
        throw new UsageError("Missing the read:project scope. Run:\n  gh auth refresh -s read:project");
      }
      throw new UsageError(`gh ${args.slice(0, 2).join(" ")} failed: ${err}`);
    }
    return res.stdout;
  },
};

export function gh(args) {
  return io.gh(args);
}

export function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue; // An omitted nullable variable is null.
    args.push(Number.isInteger(value) ? "-F" : "-f", `${key}=${value}`);
  }
  return JSON.parse(gh(args));
}

/** YYYY-MM-DD, validated as a real calendar date. */
export function isoDate(value, label = "date") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (!date || date.toISOString().slice(0, 10) !== value) {
    throw new UsageError(`${label} must be a date in the form YYYY-MM-DD, not ${JSON.stringify(value)}.`);
  }
  return value;
}

export function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}

export function checkTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new UsageError(`Unknown time zone ${JSON.stringify(timeZone)}. Use an IANA name, such as Europe/Berlin.`);
  }
  return timeZone;
}

/** The wall-clock fields of an instant in the time zone, or in the machine's zone when it is undefined. */
export function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"),
    second: get("second") };
}

/** Today's date in the time zone, as YYYY-MM-DD. */
export function zoneToday(now, timeZone) {
  const p = zoneParts(now, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export const MACHINE_CLOCK = "No --timezone was passed, so today's date comes from this machine's clock, not "
  + "the sprint time zone in docs/agents/issue-tracker.md.";

/**
 * The date that picks the sprint: --date, else today in --timezone, else today
 * on the machine's clock. The caller warns when the machine's clock decides.
 */
export function sprintToday(date, timeZone, now = new Date()) {
  if (date) return { today: date, timezone: timeZone, timezoneDefaulted: false };
  if (timeZone) return { today: zoneToday(now, timeZone), timezone: timeZone, timezoneDefaulted: false };
  const machine = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  return { today: zoneToday(now, machine ?? undefined), timezone: machine, timezoneDefaulted: true };
}

const USAGE = `Usage: node sprint-data.mjs --owner <owner> --project <number or exact title>
  (--repo <owner/repo> ... | --all-repos) [--timezone <IANA zone>]
  [--status-field <name>] [--iteration-field <name>] [--todo-status <name>]
  [--started-status <name>] [--review-status <name>] [--done-status <name>]
  [--date YYYY-MM-DD]

The project is the board named in docs/agents/issue-tracker.md. Pass --repo for
each repository in its routing table. --all-repos covers every repository the
owner has instead. Pass that file's sprint time zone as --timezone. Without it
or --date, today's date comes from this machine's clock and the script warns.`;
// The update rule, worded as .agents/references/project-profile.md words it in "Updating the installation".
export const REPAIR = "Ask the user to run npx agent-fleet@latest update --dry-run and then "
  + "npx agent-fleet@latest update in their own terminal. The update creates or repairs the project board on "
  + "GitHub. Do not run it yourself without the user's approval. If the user asks you to run it, run "
  + "npx agent-fleet@latest update --dry-run --yes and show the user the plan it prints. Run "
  + "npx agent-fleet@latest update --yes only after the user approves that exact plan, with the same flags, such "
  + "as --board or --tools for a choice the user made. Adding --force, which overwrites files changed by hand, "
  + "needs its own approval.";
export const SCOPE_REQUIRED = "Pass --repo <owner/repo> for each repository to cover, or --all-repos to cover "
  + "every repository the owner has.";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLACEHOLDER = "owner/repo";

/** The repositories a command covers, each once: the listed ones, or all of the owner's with --all-repos. */
export function repoScope(repos, allRepos, usage) {
  if (repos.length && allRepos) throw new UsageError(`Pass either --repo or --all-repos, not both.\n\n${usage}`);
  if (!repos.length && !allRepos) throw new UsageError(`${SCOPE_REQUIRED}\n\n${usage}`);
  const distinct = new Map();
  for (const repo of repos) {
    if (!REPOSITORY.test(repo)) {
      throw new UsageError(`--repo takes a repository in the form owner/repo, not ${JSON.stringify(repo)}.`
        + `\n\n${usage}`);
    }
    if (repo.toLowerCase() === PLACEHOLDER) {
      throw new UsageError(`${PLACEHOLDER} is the routing table's template placeholder. Pass the default repository `
        + "from docs/agents/issue-tracker.md instead.");
    }
    // GitHub names are case-insensitive, so acme/App and acme/app are one repository.
    if (!distinct.has(repo.toLowerCase())) distinct.set(repo.toLowerCase(), repo);
  }
  return { repos: [...distinct.values()], allRepos };
}

export function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseFlags({
      args: argv,
      options: {
        owner: { type: "string" },
        project: { type: "string" },
        repo: { type: "string", multiple: true, default: [] },
        "all-repos": { type: "boolean", default: false },
        "status-field": { type: "string", default: "Status" },
        "iteration-field": { type: "string" },
        "todo-status": { type: "string", default: "Todo" },
        "started-status": { type: "string", default: "In progress" },
        "review-status": { type: "string", default: "In review" },
        "done-status": { type: "string", default: "Done" },
        date: { type: "string" },
        timezone: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${USAGE}`);
  }
  if (values.help) return { help: USAGE };
  if (!values.owner) throw new UsageError(`--owner is required.\n\n${USAGE}`);
  if (!values.project) throw new UsageError(`--project is required.\n\n${USAGE}`);
  return {
    owner: values.owner,
    project: values.project,
    ...repoScope(values.repo, values["all-repos"], USAGE),
    statusField: values["status-field"],
    iterationField: values["iteration-field"] ?? null,
    names: {
      todo: values["todo-status"],
      started: values["started-status"],
      review: values["review-status"],
      done: values["done-status"],
    },
    date: values.date ? isoDate(values.date, "--date") : null,
    timezone: values.timezone === undefined ? null : checkTimeZone(values.timezone),
  };
}

const ownerRoots = new Map();

/** The GraphQL root field for the owner: organization or user. */
export function ownerRoot(owner) {
  if (!ownerRoots.has(owner)) {
    const node = graphql(OWNER_QUERY, { login: owner }).data.repositoryOwner;
    if (!node) throw new UsageError(`No GitHub organization or user named ${JSON.stringify(owner)}.`);
    ownerRoots.set(owner, node.__typename === "Organization" ? "organization" : "user");
  }
  return ownerRoots.get(owner);
}

export function clearCaches() {
  ownerRoots.clear();
  projects.clear();
}

export function ownerQuery(query, owner, variables = {}) {
  const root = ownerRoot(owner);
  const data = graphql(query.replaceAll("__ROOT__", root), { owner, ...variables });
  return data.data[root];
}

const projects = new Map();

/** Accept a board number or its exact title. Never guess between boards. */
export function resolveProject(owner, project) {
  const key = `${owner}\u0000${project}`;
  if (!projects.has(key)) {
    if (/^\d+$/.test(String(project))) {
      const found = ownerQuery(PROJECT_QUERY, owner, { num: Number(project) }).projectV2;
      if (!found) throw new UsageError(`No project #${project} owned by ${owner}.`);
      projects.set(key, found);
    } else {
      const nodes = ownerQuery(PROJECTS_QUERY, owner, { title: project }).projectsV2.nodes;
      projects.set(key, pickProject(nodes, project, owner));
    }
  }
  return projects.get(key);
}

export function pickProject(nodes, title, owner) {
  const matches = nodes.filter((p) => p && p.title === title && !p.closed);
  if (matches.length !== 1) {
    throw new UsageError(`Expected exactly one open project titled ${JSON.stringify(title)} owned by `
      + `${owner}, found ${matches.length}. Check docs/agents/issue-tracker.md. ${REPAIR}`);
  }
  return matches[0];
}

export function iterationWindow(it) {
  return [it.startDate, addDays(it.startDate, it.duration - 1)];
}

export function pickIterationField(nodes, wanted = null) {
  let fields = nodes.filter((n) => n && n.configuration);
  if (wanted) {
    fields = fields.filter((f) => f.name === wanted);
    if (!fields.length) throw new UsageError(`The board has no iteration field named ${JSON.stringify(wanted)}.`);
  }
  return fields[0] ?? null;
}

export function currentIteration(field, today) {
  const cfg = field.configuration;
  const every = [...(cfg.completedIterations ?? []), ...(cfg.iterations ?? [])];
  let current = null;
  for (const it of every) {
    const [start, end] = iterationWindow(it);
    if (start <= today && today <= end) {
      current = { title: it.title, start, end, day: daysBetween(start, today) + 1, duration: it.duration };
      break;
    }
  }
  const upcoming = (cfg.iterations ?? [])
    .filter((it) => it.startDate > today)
    .map((it) => ({ title: it.title, start: it.startDate }));
  return [current, upcoming];
}

/**
 * The board, its iteration field name, and the current sprint. A board without
 * an iteration field returns null for the field and sprint; the callers stop
 * and point at the installer, which adds the field.
 */
export function resolveIterations(owner, project, today, iterationField = null) {
  const board = resolveProject(owner, project);
  const nodes = ownerQuery(ITERATION_QUERY, owner, { num: board.number }).projectV2.fields.nodes;
  const field = pickIterationField(nodes, iterationField);
  if (!field) return [board, null, null, []];
  const [current, upcoming] = currentIteration(field, today);
  return [board, field.name, current, upcoming];
}

export function fetchItems(owner, number) {
  const nodes = [];
  let after = null;
  for (;;) {
    const items = ownerQuery(ITEMS_QUERY, owner, { num: number, after }).projectV2.items;
    nodes.push(...items.nodes);
    if (!items.pageInfo.hasNextPage) return nodes;
    after = items.pageInfo.endCursor;
  }
}

export function flatten(node, statusField, iterationField) {
  const content = node.content ?? {};
  if (!content.number) return null;
  let status = null;
  let iteration = null;
  for (const fv of node.fieldValues.nodes) {
    if (!fv) continue;
    const name = fv.field?.name;
    if (name === statusField) status = fv.name ?? null;
    else if (iterationField && name === iterationField) iteration = fv.title ?? null;
  }
  return {
    repo: content.repository.nameWithOwner,
    number: content.number,
    title: content.title,
    url: content.url,
    type: content.__typename,
    state: content.state,
    updatedAt: content.updatedAt,
    status: status || "No status",
    iteration,
    assignees: content.assignees.nodes.map((a) => a.login),
    subIssues: subIssues(content),
  };
}

function subIssues(content) {
  const summary = content.subIssuesSummary ?? {};
  if (!summary.total) return null;
  return {
    total: summary.total,
    completed: summary.completed,
    children: (content.subIssues?.nodes ?? []).map((n) => ({
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      state: n.state,
      assignees: n.assignees.nodes.map((a) => a.login),
    })),
  };
}

/** Bucket the user's board items by lifecycle role and sprint membership. */
export function classify(items, me, names, sprintTitle) {
  const mine = items.filter((i) => i.assignees.includes(me));
  const openMine = mine.filter((i) => i.state === "OPEN");
  const active = [names.started, names.review];
  const scope = mine.filter((i) => sprintTitle && i.iteration === sprintTitle);
  // Work that is underway but never got dropped into an iteration.
  const unscheduled = openMine.filter((i) => i.iteration === null && active.includes(i.status));
  const backlog = openMine.filter((i) => i.iteration === null);
  const bucket = (status) => scope.filter((i) => i.status === status && i.state === "OPEN");
  const known = new Set(Object.values(names));
  const other = {};
  for (const i of scope) {
    if (i.state === "OPEN" && !known.has(i.status)) (other[i.status] ??= []).push(i);
  }
  return {
    sprintItems: {
      inProgress: bucket(names.started),
      inReview: bucket(names.review),
      todo: bucket(names.todo),
      done: scope.filter((i) => i.status === names.done),
      otherStatuses: other,
    },
    unscheduledActive: unscheduled,
    backlogAssigned: backlog,
  };
}

/** Limit a `gh search` call to the listed repositories, or to the whole owner with allRepos. */
export function scopeFlags(owner, repos, allRepos = false) {
  if (repos.length) return repos.map((r) => `--repo=${r}`);
  if (allRepos) return [`--owner=${owner}`];
  throw new UsageError(SCOPE_REQUIRED);
}

function prRows(queryArgs, args) {
  const out = gh(["search", "prs", ...queryArgs, ...scopeFlags(args.owner, args.repos, args.allRepos), "--state=open",
    "--limit=40", "--json", "repository,number,title,url,createdAt,updatedAt,isDraft"]);
  return JSON.parse(out || "[]");
}

export function excerpt(text, limit = 400) {
  return Array.from(text.split(/\s+/).filter(Boolean).join(" ")).slice(0, limit).join("");
}

function prDetail(repo, number) {
  const fields = "headRefName,changedFiles,additions,deletions,mergeable,reviewDecision,isDraft,createdAt,"
    + "updatedAt,reviewRequests,latestReviews,closingIssuesReferences,comments";
  const pr = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", fields]));
  const comments = pr.comments ?? [];
  const last = comments.at(-1) ?? null;
  return {
    branch: pr.headRefName,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision || "none",
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    requestedReviewers: (pr.reviewRequests ?? []).map((r) => r.login || r.slug || null),
    reviews: (pr.latestReviews ?? []).map((r) => ({ author: r.author.login, state: r.state })),
    closes: (pr.closingIssuesReferences ?? []).map((c) => ({
      number: c.number,
      repo: `${c.repository.owner.login}/${c.repository.name}`,
      url: c.url,
    })),
    commentCount: comments.length,
    lastComment: last && {
      author: last.author.login,
      createdAt: last.createdAt,
      url: last.url,
      excerpt: excerpt(last.body),
    },
  };
}

export function viewerLogin() {
  return graphql("query { viewer { login } }").data.viewer.login;
}

export function collect(args, now = new Date()) {
  const { today, timezone, timezoneDefaulted } = sprintToday(args.date, args.timezone, now);
  if (timezoneDefaulted) io.warn(MACHINE_CLOCK);
  const me = viewerLogin();
  const result = { generatedFor: me, today, timezone, timezoneDefaulted, owner: args.owner, statusNames: args.names };

  const [board, iterationField, current, upcoming] = resolveIterations(
    args.owner, args.project, today, args.iterationField);
  if (!iterationField) throw new UsageError(`The board "${board.title}" has no iteration field. ${REPAIR}`);
  const items = fetchItems(args.owner, board.number)
    .map((node) => flatten(node, args.statusField, iterationField))
    .filter(Boolean);
  Object.assign(result, {
    project: { title: board.title, url: board.url },
    iterationField,
    sprint: current,
    upcoming: upcoming.slice(0, 2),
    ...classify(items, me, args.names, current?.title ?? null),
  });

  const reviewsForMe = prRows([`--review-requested=${me}`], args);
  const mentions = prRows([`--mentions=${me}`], args);
  const authored = prRows([`--author=${me}`], args);
  for (const row of [...reviewsForMe, ...authored]) row.detail = prDetail(row.repository.nameWithOwner, row.number);
  const seen = new Set([...reviewsForMe, ...authored].map((r) => r.url));
  result.prs = {
    awaitingMyReview: reviewsForMe,
    mineAwaitingOthers: authored,
    mentioningMe: mentions.filter((m) => !seen.has(m.url)),
  };
  return result;
}

/** Run a script's main function as a command: print usage errors, not stack traces. */
export function runCommand(run) {
  try {
    const output = run(process.argv.slice(2));
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return args.help;
  return JSON.stringify(collect(args), null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runCommand(main);
}
