/**
 * GitHub setup for the installer: the GitHub CLI and its login, the project's
 * GitHub repository, and the project board every workflow skill runs on.
 *
 * Every call to GitHub goes through a gh function passed in by the caller, so
 * tests can answer for GitHub. It takes (args, { input, interactive }) and
 * returns { status, stdout, stderr, missing }.
 */

import { spawnSync } from "node:child_process";

export const INSTALL_URL = "https://cli.github.com";
export const STATUS_FIELD = "Status";
export const ITERATION_FIELD = "Sprint";
export const SPRINT_DAYS = 14;
export const SPRINT_COUNT = 6;
// The lifecycle the skills move issues through, in board order.
export const STATUSES = [
  { role: "new", name: "Todo", color: "GRAY", description: "Planned, not started" },
  { role: "started", name: "In progress", color: "YELLOW", description: "Someone is working on it" },
  { role: "review", name: "In review", color: "PURPLE", description: "A pull request is waiting for review" },
  { role: "done", name: "Done", color: "GREEN", description: "Merged or closed" },
];
// Scopes a classic gh token needs: repo for issues and pull requests, project for the board.
export const REQUIRED_SCOPES = ["repo", "project"];
const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

export class GitHubError extends Error {}

/** Run the real gh. With interactive set, gh gets the terminal, such as for a login. */
export function runGh(args, { input, interactive = false } = {}) {
  const res = spawnSync("gh", args, interactive
    ? { stdio: "inherit" }
    : { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { status: null, stdout: "", stderr: res.error.message, missing: res.error.code === "ENOENT" };
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", missing: false };
}

/** Run another program with the terminal, such as a package manager. Returns its exit status. */
export function runProgram(command, args) {
  const res = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  return res.error ? null : res.status;
}

export function hasProgram(command) {
  const res = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !res.error && res.status === 0;
}

export function ghVersion(gh) {
  const res = gh(["--version"]);
  return res.status === 0 ? res.stdout.split("\n")[0].trim() : null;
}

/** The command that installs gh on this platform without administrator rights, if there is one. */
export function installCommand(platform, has) {
  if (platform === "darwin" && has("brew")) return { command: "brew", args: ["install", "gh"] };
  if (platform === "win32" && has("winget")) {
    return { command: "winget", args: ["install", "--id", "GitHub.cli", "--exact", "--source", "winget"] };
  }
  return null;
}

/** Who gh is logged in as, and the scopes of its token. Scopes are null for tokens that report none. */
export function authState(gh) {
  const res = gh(["api", "--include", "user"]);
  if (res.status !== 0) return { loggedIn: false, detail: res.stderr.trim() };
  const [head, ...body] = res.stdout.split(/\r?\n\r?\n/);
  const header = head.split(/\r?\n/).find((line) => /^x-oauth-scopes:/i.test(line));
  const scopes = header ? header.slice(header.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { loggedIn: true, login: JSON.parse(body.join("\n\n")).login, scopes };
}

export function missingScopes(scopes) {
  return scopes ? REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : [];
}

export function parseRemote(url) {
  const match = GITHUB_REMOTE.exec(url.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

/**
 * Run a GraphQL request through gh. With notFound set, a response whose only
 * errors are NOT_FOUND, such as for a board number the owner lacks, returns
 * its data with null in place of what GitHub could not find.
 */
export function graphql(gh, query, variables = {}, { notFound = false } = {}) {
  const res = gh(["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }) });
  let body = null;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    // gh printed no JSON body, so the status and stderr explain the failure.
  }
  if (notFound && body?.data && body.errors?.length && body.errors.every((e) => e.type === "NOT_FOUND")) {
    return body.data;
  }
  if (res.status !== 0) {
    const detail = res.stderr.trim();
    if (/scope/i.test(detail)) {
      throw new GitHubError(`GitHub refused the request for lack of a token scope: ${detail}\n`
        + "Run gh auth refresh --scopes project, then rerun agent-fleet.");
    }
    throw new GitHubError(`GitHub request failed: ${detail}`);
  }
  if (body?.errors?.length) throw new GitHubError(`GitHub request failed: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
}

const BOARD_FIELDS = "id number title url closed";

export function repository(gh, { owner, name }) {
  const data = graphql(gh, `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id nameWithOwner url
      defaultBranchRef { name }
      owner { __typename login id }
      projectsV2(first: 20) { nodes { ${BOARD_FIELDS} } }
    }
  }`, { owner, name });
  if (!data.repository) throw new GitHubError(`GitHub has no repository ${owner}/${name} that this account can see.`);
  const repo = data.repository;
  return {
    id: repo.id,
    nameWithOwner: repo.nameWithOwner,
    name,
    url: repo.url,
    defaultBranch: repo.defaultBranchRef?.name ?? "main",
    owner: { login: repo.owner.login, id: repo.owner.id, type: repo.owner.__typename },
    boards: repo.projectsV2.nodes.filter((board) => board && !board.closed),
  };
}

/** Up to 20 of the owner's open boards, most recently updated first, to offer as choices. */
export function ownerBoards(gh, login) {
  const data = graphql(gh, `query($login: String!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner { projectsV2(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${BOARD_FIELDS} } } }
    }
  }`, { login });
  return (data.repositoryOwner?.projectsV2?.nodes ?? []).filter((board) => board && !board.closed);
}

/** The owner's board with this number, open or closed, or null when GitHub has none this account can see. */
export function ownerBoard(gh, login, number) {
  const data = graphql(gh, `query($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner { projectV2(number: $number) { ${BOARD_FIELDS} } }
    }
  }`, { login, number }, { notFound: true });
  return data.repositoryOwner?.projectV2 ?? null;
}

/**
 * The owner's open boards with exactly this title, however many boards the
 * owner has. GitHub's search matches words, so the title is compared here.
 */
export function boardsTitled(gh, login, title) {
  const found = [];
  let after = null;
  do {
    const data = graphql(gh, `query($login: String!, $title: String!, $after: String) {
      repositoryOwner(login: $login) {
        ... on ProjectV2Owner {
          projectsV2(first: 100, query: $title, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { ${BOARD_FIELDS} }
          }
        }
      }
    }`, { login, title, after });
    const page = data.repositoryOwner?.projectsV2;
    found.push(...(page?.nodes ?? []).filter((board) => board && !board.closed && board.title === title));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return found;
}

export function boardFields(gh, boardId) {
  const data = graphql(gh, `query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
            ... on ProjectV2IterationField { id name dataType configuration { duration } }
            ... on ProjectV2Field { id name dataType }
          }
        }
      }
    }
  }`, { id: boardId });
  return data.node?.fields?.nodes?.filter(Boolean) ?? [];
}

/**
 * Compare a board with the workflow's needs. statusNames maps each lifecycle
 * role to the board's own option name, which may differ in case.
 */
export function inspectBoard(fields) {
  const status = fields.find((f) => f.name === STATUS_FIELD && f.dataType === "SINGLE_SELECT") ?? null;
  const iteration = fields.find((f) => f.dataType === "ITERATION") ?? null;
  const statusNames = {};
  const missingStatuses = [];
  for (const wanted of STATUSES) {
    const option = status?.options.find((o) => o.name.toLowerCase() === wanted.name.toLowerCase());
    if (option) statusNames[wanted.role] = option.name;
    else missingStatuses.push(wanted);
  }
  for (const wanted of missingStatuses) statusNames[wanted.role] = wanted.name;
  return { status, iterationName: iteration?.name ?? null, statusNames, missingStatuses };
}

/** Plain-language list of what a board still needs. */
export function describeRepairs(inspection) {
  const repairs = [];
  if (!inspection.status) repairs.push(`add a ${STATUS_FIELD} field with ${STATUSES.map((s) => s.name).join(", ")}`);
  else if (inspection.missingStatuses.length) {
    repairs.push(`add ${inspection.missingStatuses.map((s) => s.name).join(", ")} to the ${STATUS_FIELD} field`);
  }
  if (!inspection.iterationName) repairs.push(`add a ${ITERATION_FIELD} field with ${SPRINT_DAYS / 7}-week sprints`);
  return repairs;
}

/** The Monday of the week containing the given date, as YYYY-MM-DD. */
export function mondayOf(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

export function sprintConfiguration(today) {
  const startDate = mondayOf(today);
  const iterations = Array.from({ length: SPRINT_COUNT }, (_, index) => {
    const [y, m, d] = startDate.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, d + index * SPRINT_DAYS)).toISOString().slice(0, 10);
    return { title: `${ITERATION_FIELD} ${index + 1}`, startDate: start, duration: SPRINT_DAYS };
  });
  return { startDate, duration: SPRINT_DAYS, iterations };
}

/**
 * Bring a board up to the workflow's needs. On a board the installer just
 * created, the Status options become exactly the workflow's, keeping their IDs.
 * On an existing board, existing options stay as they are and only missing
 * ones are added, so no item loses its status.
 */
export function repairBoard(gh, boardId, inspection, { normalize = false, today = new Date() } = {}) {
  if (!inspection.status) {
    graphql(gh, `mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { clientMutationId } }`, {
      input: {
        projectId: boardId, dataType: "SINGLE_SELECT", name: STATUS_FIELD,
        singleSelectOptions: STATUSES.map(({ name, color, description }) => ({ name, color, description })),
      },
    });
  } else if (normalize || inspection.missingStatuses.length) {
    const existing = inspection.status.options;
    const byName = (name) => existing.find((o) => o.name.toLowerCase() === name.toLowerCase());
    const options = normalize
      ? [
        ...STATUSES.map(({ name, color, description }) => ({ id: byName(name)?.id, name, color, description })),
        ...existing.filter((o) => !STATUSES.some((s) => s.name.toLowerCase() === o.name.toLowerCase())),
      ]
      : [
        ...existing.map(({ id, name, color, description }) => ({ id, name, color, description: description ?? "" })),
        ...inspection.missingStatuses.map(({ name, color, description }) => ({ name, color, description })),
      ];
    graphql(gh, `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { clientMutationId } }`, {
      input: { fieldId: inspection.status.id, singleSelectOptions: options.map((o) => (o.id ? o : omitId(o))) },
    });
  }
  if (!inspection.iterationName) {
    graphql(gh, `mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { clientMutationId } }`, {
      input: {
        projectId: boardId, dataType: "ITERATION", name: ITERATION_FIELD,
        iterationConfiguration: sprintConfiguration(today),
      },
    });
  }
}

function omitId({ id, ...rest }) {
  return rest;
}

export function createBoard(gh, repo, title) {
  const data = graphql(gh, `mutation($input: CreateProjectV2Input!) {
    createProjectV2(input: $input) { projectV2 { ${BOARD_FIELDS} } }
  }`, { input: { ownerId: repo.owner.id, title, repositoryId: repo.id } });
  return data.createProjectV2.projectV2;
}

export function linkBoard(gh, boardId, repositoryId) {
  graphql(gh, `mutation($input: LinkProjectV2ToRepositoryInput!) {
    linkProjectV2ToRepository(input: $input) { clientMutationId }
  }`, { input: { projectId: boardId, repositoryId } });
}

export function defaultBoardTitle(repo) {
  return `${repo.name} Sprints`;
}
