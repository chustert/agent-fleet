/**
 * Plan and apply an installation of the agent fleet into a project.
 *
 * The fleet's own files go to .agents/skills/, .agents/references/,
 * .agents/scripts/check-skills.mjs, and .agents/agent-fleet-LICENSE, with a thin
 * adapter per skill for each chosen tool. .agents/agent-fleet.json records a hash of every file written,
 * so an update can tell fleet files from files the project owns or changed.
 *
 * In AGENTS.md and CLAUDE.md the installer owns only the section between the
 * agent-fleet markers. A missing AGENTS.md is created from the setup-project
 * template with the project's name and repository; the rest stays TODO for the
 * setup-project skill. A missing docs/agents/issue-tracker.md is created with
 * the tracker settings the installer knows for certain, such as the board it
 * set up; nothing else in docs/agents/ is written, and an existing file is
 * never changed.
 *
 * With Claude Code, the agent team comes too: agents/ goes to .claude/agents/,
 * agents/automations/ to .claude/automations/, the verification gate and the
 * second-opinion script to .agents/scripts/, and the team's permissions and
 * hooks are merged into .claude/settings.json entry by entry. The manifest
 * records the entries it added, so an update removes only those, and an entry
 * the project removed by hand stays out.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as checks from "./check-skills.mjs";
import { parseRemote } from "./github.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_HARNESSES = ["claude", "cursor"];
const AGENTS_TEMPLATE = path.join(ROOT, "skills/setup-project/templates/AGENTS.template.md");
const CLAUDE_NOTE = "<!-- Keep shared instructions in AGENTS.md; this file only imports it for Claude Code. "
  + "Put personal instructions in CLAUDE.local.md, kept out of Git. -->\n";
const IGNORED = new Set([".DS_Store"]);
// The fleet's MIT notice travels with the copies it makes in a project.
export const LICENSE_TARGET = ".agents/agent-fleet-LICENSE";
export const SETTINGS = ".claude/settings.json";
const TEAM_SETTINGS = path.join(ROOT, "agents/settings.json");
// Agent memory with `memory: local` stays out of Git; this file ignores the rest of its folder.
const MEMORY_IGNORE = ".claude/agent-memory-local/.gitignore";

export function version() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Compare two semantic versions by precedence, numerically, so 1.10.0 is newer
 * than 1.9.0. Returns -1, 0, or 1, or null when either is not a version.
 */
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a ?? "").trim());
  const y = SEMVER.exec(String(b ?? "").trim());
  if (!x || !y) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(x[index]) - Number(y[index]);
    if (difference) return Math.sign(difference);
  }
  // A pre-release, such as 1.5.0-beta.1, comes before its release.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const left = x[4].split(".");
  const right = y[4].split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const numeric = [left[index], right[index]].map((part) => /^\d+$/.test(part));
    if (numeric[0] && numeric[1]) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference) return Math.sign(difference);
    } else if (numeric[0] !== numeric[1]) {
      return numeric[0] ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/** The agent team's definitions, by file name. */
export function agentNames() {
  return fs.readdirSync(path.join(ROOT, "agents"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

export function skillNames() {
  return fs.readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function modeFor(relative) {
  return /(^|\/)scripts\/[^/]+\.mjs$/.test(relative) ? 0o755 : 0o644;
}

/** Map each fleet-managed project path to { content, mode }. */
export function desiredFiles(harnesses) {
  const files = new Map();
  for (const [base, target] of [["skills", checks.CANONICAL], ["references", checks.REFERENCES]]) {
    for (const relative of checks.listFiles(path.join(ROOT, base))) {
      if (relative.split("/").some((part) => IGNORED.has(part))) continue;
      const destination = `${target}/${relative}`;
      files.set(destination, { content: fs.readFileSync(path.join(ROOT, base, relative)), mode: modeFor(destination) });
    }
  }
  files.set(LICENSE_TARGET, { content: fs.readFileSync(path.join(ROOT, "LICENSE")), mode: 0o644 });
  files.set(".agents/scripts/check-skills.mjs", {
    content: fs.readFileSync(path.join(ROOT, "lib/check-skills.mjs")),
    mode: 0o755,
  });
  if (harnesses.includes("claude")) {
    for (const name of agentNames()) {
      files.set(`.claude/agents/${name}.md`, { content: fs.readFileSync(path.join(ROOT, "agents", `${name}.md`)), mode: 0o644 });
    }
    for (const relative of checks.listFiles(path.join(ROOT, "agents/automations"))) {
      if (IGNORED.has(path.basename(relative))) continue;
      files.set(`.claude/automations/${relative}`, {
        content: fs.readFileSync(path.join(ROOT, "agents/automations", relative)), mode: 0o644,
      });
    }
    for (const script of ["gate.mjs", "second-opinion.mjs"]) {
      files.set(`.agents/scripts/${script}`, { content: fs.readFileSync(path.join(ROOT, "lib", script)), mode: 0o755 });
    }
    files.set(MEMORY_IGNORE, { content: Buffer.from("*\n!.gitignore\n"), mode: 0o644 });
  }
  for (const name of skillNames()) {
    const text = fs.readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
    for (const harness of harnesses) {
      const { dir, fields } = checks.HARNESSES[harness];
      files.set(`${dir}/${name}/SKILL.md`, { content: Buffer.from(checks.adapterText(name, text, fields)), mode: 0o644 });
    }
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const NOT_INSTALLED = "exists and was not installed by the fleet";

/** Decide what to do with every fleet file. Returns { actions, conflicts }. */
export function plan(project, files, manifest, force) {
  const installed = manifest?.files ?? {};
  const actions = [];
  const conflicts = [];
  for (const [relative, { content }] of files) {
    const file = path.join(project, relative);
    if (!fs.existsSync(file)) {
      actions.push({ action: "create", path: relative });
      continue;
    }
    const current = checks.sha256(fs.readFileSync(file));
    if (current === checks.sha256(content)) {
      actions.push({ action: "unchanged", path: relative });
    } else if (installed[relative] === current) {
      actions.push({ action: "update", path: relative });
    } else {
      const reason = relative in installed ? "changed since the fleet installed it" : NOT_INSTALLED;
      conflicts.push({ path: relative, reason });
      if (force) actions.push({ action: "overwrite", path: relative });
    }
  }
  for (const [relative, digest] of Object.entries(installed).sort()) {
    if (files.has(relative)) continue;
    const file = path.join(project, relative);
    if (!fs.existsSync(file)) continue;
    if (checks.sha256(fs.readFileSync(file)) === digest) {
      actions.push({ action: "delete", path: relative });
    } else {
      conflicts.push({ path: relative, reason: "was removed from the fleet but changed locally; left in place" });
    }
  }
  return { actions, conflicts };
}

// The update rule, worded as the profile reference words it in "Updating the installation".
const UPDATE_RULE = "ask the user to run `npx agent-fleet@latest update --dry-run` and then "
  + "`npx agent-fleet@latest update` in their own terminal. Do not run it yourself without the user's approval. "
  + "If the user asks you to run it, run `npx agent-fleet@latest update --dry-run --yes` and show the user the "
  + "plan it prints. Run `npx agent-fleet@latest update --yes` only after the user approves that exact plan, with "
  + "the same flags, such as `--board` or `--tools` for a choice the user made. Adding `--force`, which "
  + "overwrites files changed by hand, needs its own approval.";

/** The agent-fleet section of a project's AGENTS.md. */
export function agentsBlock(harnesses) {
  const folders = harnesses.map((h) => `\`${checks.HARNESSES[h].dir}/\``);
  let adapters;
  if (folders.length === 0) adapters = "No tool needs an adapter; each reads `.agents/skills/` directly.";
  else if (folders.length === 1) adapters = `${folders[0]} holds thin adapters that point to them.`;
  else adapters = `${folders.slice(0, -1).join(", ")} and ${folders.at(-1)} hold thin adapters that point to them.`;
  const lines = [
    "## Agent workflow",
    "",
    `The workflow skills in \`.agents/skills/\` come from the agent fleet. ${adapters}`,
    "",
    "- Work items are GitHub issues on the project board that `docs/agents/issue-tracker.md` names. "
      + "The board is required.",
    "- The agent-fleet update creates or repairs the project board on GitHub and updates the fleet's files. "
      + `When the board is missing or incomplete, or the fleet's files need an update, ${UPDATE_RULE} `
      + "Afterwards, run `node .agents/scripts/check-skills.mjs`.",
    "- Before planning, implementing, or reviewing work, read the documents in the order "
      + "`docs/agents/domain.md` sets.",
    "- The project settings the skills read live in `docs/agents/`: `issue-tracker.md` holds the "
      + "tracker, board, lifecycle statuses, and routing; `domain.md` the reading order, boundaries, and "
      + "quality weighting; and `verification.md` the commands, evidence, services that need approval, "
      + "and protected files. Change a project fact there, never in a skill.",
    "- `.agents/references/` holds the models the skills share: the software-quality "
      + "characteristics, the GitHub reference rules, the subagent rules, and one guide per platform.",
    "- Whenever you name a GitHub issue, pull request, comment, commit, workflow run, or project "
      + "item, link it as `.agents/references/github-references.md` specifies.",
    "- Never add AI attribution to a commit, pull request, issue, or comment: no `Co-Authored-By` "
      + "line naming an agent, and no \"Generated with\" footer or tool badge.",
    "- The usual path through an issue is `start-issue`, then `implement` or `implement-slice`, "
      + "then `verify-work`, `prepare-pr`, and `pr-review`. Run `setup-project` when a skill reports a "
      + "missing or `TODO` setting.",
    "- Do not edit by hand the files that `.agents/agent-fleet.json` records, such as the fleet's skills, "
      + "references, adapters, and checker. Only the update changes them. Put a project's own skill in its own "
      + "folder under `.agents/skills/`, and add nothing inside a fleet skill's folder or `.agents/references/`.",
  ];
  if (harnesses.includes("claude")) {
    lines.push("- Claude Code reads this file through the import in `CLAUDE.md`. Personal "
      + "instructions belong in `CLAUDE.local.md`, kept out of Git.");
    lines.push("- `.claude/agents/` holds the agent team. Start it with `claude --agent engineering-lead`: the lead "
      + "takes an issue through the workflow with a developer, a fresh verifier for every round, a reviewer, and a spec "
      + "writer, and asks the user at every approval gate that `docs/agents/autonomy.md` does not cover. "
      + "`.agents/scripts/gate.mjs` and the hooks in `.claude/settings.json` let a pull request become ready for review "
      + "only with a verifier's passing verdict for the exact patch.");
  }
  return lines.join("\n") + "\n";
}

/** The agent-fleet section each instruction file should carry. */
export function instructionBodies(harnesses) {
  const bodies = { "AGENTS.md": agentsBlock(harnesses) };
  if (harnesses.includes("claude")) bodies["CLAUDE.md"] = "@AGENTS.md\n";
  return bodies;
}

function git(project, ...args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * The canonical form of a path. The native call expands Windows short names,
 * such as RUNNER~1, which Git never reports, and Windows paths ignore case.
 */
export function canonicalPath(target) {
  const real = fs.realpathSync.native(target);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function samePath(a, b) {
  try {
    return canonicalPath(a) === canonicalPath(b);
  } catch {
    return false;
  }
}

/** Whether the project directory is the top of its own Git repository. */
export function isGitRoot(project) {
  const top = git(project, "rev-parse", "--show-toplevel");
  return Boolean(top) && samePath(top, project);
}

/** The project's name and GitHub repository, from its own Git remote when it has one. */
export function projectIdentity(project) {
  if (isGitRoot(project)) {
    const remote = parseRemote(git(project, "remote", "get-url", "origin"));
    if (remote) {
      const { owner, name } = remote;
      return { name, repository: `[\`${owner}/${name}\`](https://github.com/${owner}/${name})` };
    }
  }
  return { name: path.basename(project), repository: "TODO: `owner/repo`" };
}

function newInstructionFile(name, body, project) {
  if (name === "CLAUDE.md") return `${checks.withBlock("", body)}\n${CLAUDE_NOTE}`;
  const { name: projectName, repository } = projectIdentity(project);
  const text = fs.readFileSync(AGENTS_TEMPLATE, "utf8")
    .replaceAll("{{project_name}}", projectName)
    .replaceAll("{{repository}}", repository);
  return checks.withBlock(text, body);
}

/**
 * Decide what to do with AGENTS.md and CLAUDE.md. Returns { changes,
 * conflicts, notes, blocks }. Each change is { action, path, text }. blocks is
 * the manifest record: the digest of each file's agent-fleet section, or null
 * when the project removed it on purpose.
 */
export function planInstructions(project, harnesses, manifest, force, restore = force) {
  const recorded = manifest?.blocks ?? {};
  const changes = [];
  const conflicts = [];
  const notes = [];
  const blocks = {};
  for (const [name, body] of Object.entries(instructionBodies(harnesses))) {
    const file = path.join(project, name);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const current = text === null ? null : checks.findBlock(text);
    const digest = checks.sha256(body);
    if (current === null) {
      if (text !== null && name === "CLAUDE.md" && checks.CLAUDE_IMPORT.test(text)) {
        notes.push("CLAUDE.md already imports AGENTS.md, so it stays as it is.");
        continue;
      }
      if (name in recorded && !restore) {
        notes.push(`${name} or its agent-fleet section was removed by hand, so it stays out. `
          + "Rerun with --force to restore it.");
        blocks[name] = null;
        continue;
      }
      const updated = text === null
        ? newInstructionFile(name, body, project)
        : checks.withBlock(text, body, name === "CLAUDE.md");
      changes.push({ action: text === null ? "create" : "update", path: name, text: updated });
      blocks[name] = digest;
    } else if (current === body && !checks.LEGACY_BLOCK.test(text)) {
      changes.push({ action: "unchanged", path: name, text: null });
      blocks[name] = digest;
    } else if (current === body || recorded[name] === checks.sha256(current)) {
      // A section under skill-fleet's markers gets agent-fleet's, even when its text is current.
      changes.push({ action: "update", path: name, text: checks.withBlock(text, body) });
      blocks[name] = digest;
    } else {
      conflicts.push({ path: name, reason: "its agent-fleet section was edited by hand" });
      if (force) {
        changes.push({ action: "overwrite", path: name, text: checks.withBlock(text, body) });
        blocks[name] = digest;
      }
    }
  }
  return { changes, conflicts, notes, blocks };
}

// ------------------------------------------------------------------ settings

const canonical = checks.sortedKeys;

/**
 * The permission rules and hook groups of a settings object, each as
 * { key, list, value }: list is `permissions.allow`, `permissions.ask`,
 * `permissions.deny`, or `hooks.<event>`, and key identifies the entry.
 */
export function settingsEntries(settings) {
  const entries = [];
  for (const kind of ["allow", "ask", "deny"]) {
    for (const rule of settings.permissions?.[kind] ?? []) {
      entries.push({ key: `permissions.${kind} ${rule}`, list: `permissions.${kind}`, value: rule });
    }
  }
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      entries.push({ key: `hooks.${event} ${JSON.stringify(canonical(group))}`, list: `hooks.${event}`, value: group });
    }
  }
  return entries;
}

function listOf(settings, list, create) {
  const [section, name] = list.split(".");
  if (create) {
    settings[section] ??= {};
    settings[section][name] ??= [];
  }
  return settings[section]?.[name] ?? [];
}

function hasEntry(settings, entry) {
  const same = JSON.stringify(canonical(entry.value));
  return listOf(settings, entry.list).some((item) => JSON.stringify(canonical(item)) === same);
}

function removeEntry(settings, entry) {
  const [section, name] = entry.list.split(".");
  const same = JSON.stringify(canonical(entry.value));
  const kept = listOf(settings, entry.list).filter((item) => JSON.stringify(canonical(item)) !== same);
  if (kept.length) settings[section][name] = kept;
  else if (settings[section]) {
    delete settings[section][name];
    if (!Object.keys(settings[section]).length) delete settings[section];
  }
}

/**
 * Decide the change to .claude/settings.json. The team's entries go in when
 * Claude Code is a chosen tool and come out when it is not. An entry the
 * manifest records as added but the file lacks was removed by hand, so it
 * stays out unless forced. Returns { change, notes, record }.
 */
export function planSettings(project, harnesses, manifest, force) {
  const file = path.join(project, SETTINGS);
  const wanted = harnesses.includes("claude")
    ? settingsEntries(JSON.parse(fs.readFileSync(TEAM_SETTINGS, "utf8")))
    : [];
  const owned = new Set(manifest?.settings?.owned ?? []);
  const removed = new Set(manifest?.settings?.removed ?? []);
  const record = { owned: [], removed: [] };
  const notes = [];
  if (!wanted.length && !owned.size) return { change: null, notes, record: null };
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let settings;
  try {
    settings = text === null ? {} : JSON.parse(text);
  } catch {
    notes.push(`${SETTINGS} is not valid JSON, so the agent team's permissions and hooks were not merged. `
      + "Fix the file and rerun the update.");
    return { change: null, notes, record: manifest?.settings ?? null };
  }
  const merged = JSON.parse(JSON.stringify(settings));
  const left = [];
  for (const entry of wanted) {
    if (hasEntry(merged, entry)) {
      // An entry the project had before the fleet added it stays the project's.
      if (owned.has(entry.key)) record.owned.push(entry.key);
    } else if ((owned.has(entry.key) || removed.has(entry.key)) && !force) {
      record.removed.push(entry.key);
      left.push(entry.key);
    } else {
      listOf(merged, entry.list, true).push(entry.value);
      record.owned.push(entry.key);
    }
  }
  const keys = new Set(wanted.map((entry) => entry.key));
  for (const entry of settingsEntries(settings)) {
    if (owned.has(entry.key) && !keys.has(entry.key)) removeEntry(merged, entry);
  }
  if (left.length) {
    notes.push(`${SETTINGS} lacks ${left.length} of the agent team's entries that were removed by hand, so they `
      + "stay out. Rerun with --force to restore them.");
  }
  const updated = JSON.stringify(merged, null, 2) + "\n";
  const unchanged = text !== null && JSON.stringify(canonical(merged)) === JSON.stringify(canonical(settings));
  let change;
  if (unchanged) change = { action: "unchanged", path: SETTINGS, text: null };
  else if (!Object.keys(merged).length && text !== null && owned.size) change = { action: "delete", path: SETTINGS, text: null };
  else change = { action: text === null ? "create" : "update", path: SETTINGS, text: updated };
  const empty = !record.owned.length && !record.removed.length;
  return { change, notes, record: empty ? null : record };
}

function removeEmptyParents(file, stop) {
  let parent = path.dirname(file);
  while (parent !== stop && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
    fs.rmdirSync(parent);
    parent = path.dirname(parent);
  }
}

/**
 * The manifest a skill-fleet installation left, marked as legacy, or null.
 * agent-fleet takes it over: its file hashes tell fleet files from the
 * project's own, its choices carry over, and its markers count as the fleet's.
 */
export function legacyManifest(project) {
  const file = path.join(project, checks.LEGACY_MANIFEST);
  if (!fs.existsSync(file)) return null;
  try {
    return { ...JSON.parse(fs.readFileSync(file, "utf8")), legacy: true };
  } catch {
    throw new Error(`${checks.LEGACY_MANIFEST} is not valid JSON. Restore it from Git, or delete it to install afresh.`);
  }
}

/** Write the planned changes and the manifest. */
export function apply(project, files, installation) {
  const { actions, instructionChanges, blocks, harnesses, instructions, github } = installation;
  for (const { action, path: relative } of actions) {
    const file = path.join(project, relative);
    if (action === "create" || action === "update" || action === "overwrite") {
      const { content, mode } = files.get(relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      fs.chmodSync(file, mode);
    } else if (action === "delete") {
      fs.unlinkSync(file);
      removeEmptyParents(file, project);
    }
  }
  for (const { action, path: relative, text } of instructionChanges) {
    const file = path.join(project, relative);
    if (action === "delete") {
      fs.rmSync(file, { force: true });
      removeEmptyParents(file, project);
    } else if (text !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  const manifest = {
    fleet: "agent-fleet",
    version: version(),
    harnesses,
    instructions,
    files: Object.fromEntries([...files].map(([relative, { content }]) => [relative, checks.sha256(content)])),
    blocks: Object.fromEntries(Object.entries(blocks).sort()),
    ...(installation.settings ? { settings: installation.settings } : {}),
    ...(github ? { github } : {}),
  };
  fs.mkdirSync(path.join(project, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(project, checks.MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(path.join(project, checks.LEGACY_MANIFEST), { force: true });
}

/** The origin remote's GitHub repository, when the project is the top of its own Git repository. */
export function projectRemote(project) {
  return isGitRoot(project) ? parseRemote(git(project, "remote", "get-url", "origin")) : null;
}

export const TRACKER = "docs/agents/issue-tracker.md";
const TRACKER_TEMPLATE = path.join(ROOT, "skills/setup-project/templates/issue-tracker.md");

/** Replace the value of each named row in a Markdown settings table. */
export function fillSettings(text, values) {
  let filled = text;
  for (const [setting, value] of Object.entries(values)) {
    const escaped = setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filled = filled.replace(new RegExp(`^\\| ${escaped} \\| .* \\|$`, "m"), () => `| ${setting} | ${value} |`);
  }
  return filled;
}

/** The tracker settings the installer knows for certain, from GitHub and the board it set up. */
export function trackerSettings({ repo, board, inspection, timeZone }) {
  const names = inspection.statusNames;
  const organization = repo.owner.type === "Organization";
  return {
    "Default repository": `\`${repo.nameWithOwner}\`. A bare issue number refers to this repository.`,
    "Owner type": `\`${organization ? "Organization" : "User"}\`.`,
    "Issue types": organization ? "`Resolve from GitHub`." : "`None`. GitHub issue types exist only for organizations.",
    "Fallback repository": `\`${repo.nameWithOwner}\`.`,
    "Project board": `\`${board.title}\` owned by \`${repo.owner.login}\`: ${board.url}`,
    "Status field": "`Status`.",
    "Lifecycle statuses": `new → \`${names.new}\`; started → \`${names.started}\`; in review → \`${names.review}\`; done → \`${names.done}\`.`,
    "Iteration field": `\`${inspection.iterationName}\`.`,
    "Sprint time zone": `\`${timeZone}\`.`,
    "Default base branch": `\`${repo.defaultBranch}\`.`,
  };
}

/** Create docs/agents/issue-tracker.md from the template when it is missing. */
export function seedTracker(project, settings) {
  const file = path.join(project, TRACKER);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fillSettings(fs.readFileSync(TRACKER_TEMPLATE, "utf8"), settings));
  return true;
}

export const PROFILE = ["issue-tracker.md", "domain.md", "verification.md"];
// The profile file only the agent team reads, which projects with Claude Code need.
export const TEAM_PROFILE = ["autonomy.md"];
const TEMPLATES = path.join(ROOT, "skills/setup-project/templates");
// Tables whose columns are settings in their own right, by the heading above them.
const COLUMN_TABLES = new Set(["Routing", "Boundaries"]);
// A table's delimiter row, with or without the outer pipes, as GitHub renders it: `| --- | --- |` or `--- | ---`.
const TABLE_SEPARATOR = /^(?=.*\|)\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const FENCE = /^(`{3,}|~{3,})/;

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** The lines of text, trimmed, with every line of a fenced code block blanked. */
function proseLines(text) {
  let fence = null;
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // A fence closes with at least as many of the same character and nothing after them.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(marker.length).trim()) {
        fence = null;
      }
      return "";
    }
    if (marker) fence = marker;
    return marker ? "" : line;
  });
}

/**
 * Every Markdown table in text, as { section, subsection, header, rows }, where
 * section is the `##` heading above it and subsection the `###` heading below
 * that. Headings and tables inside fenced code blocks do not count.
 */
export function markdownTables(text) {
  const lines = proseLines(text);
  const tables = [];
  let section = "";
  let subsection = "";
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(##|###) (.+)$/.exec(lines[index]);
    if (heading?.[1] === "##") [section, subsection] = [heading[2].trim(), ""];
    else if (heading) subsection = heading[2].trim();
    if (!lines[index].includes("|") || !TABLE_SEPARATOR.test(lines[index + 1] ?? "")) continue;
    const table = { section, subsection, header: tableCells(lines[index]), rows: [] };
    for (index += 2; index < lines.length && lines[index].includes("|"); index += 1) {
      table.rows.push(tableCells(lines[index]));
    }
    index -= 1;
    tables.push(table);
  }
  return tables;
}

const settingName = (cell) => cell.replace(/[`*]/g, "").trim().toLowerCase();
const isTodo = (cell) => /^TODO\b/.test(cell);

function hasHeading(text, title) {
  const wanted = settingName(title);
  return proseLines(text).some((line) => settingName(/^#+\s+(.+)$/.exec(line)?.[1] ?? "") === wanted);
}

/**
 * The settings a profile template has and a project's profile file lacks.
 * Returns { rows, columns, tables }: rows are { name, component } from the
 * first column of each `Setting` table, where component names the copy of a
 * repeated section, such as one per component, that lacks the row; columns
 * are { table, name } from the routing and boundaries tables; and tables are
 * those tables when the file lacks both the table and its heading. A heading
 * without a table, such as one that records `None`, needs no columns.
 *
 * The copies of a repeated section are the `###` sections under the
 * template's `##` heading. A file without them, whose components are `##`
 * sections of their own, has one copy per such `##` section. Otherwise the
 * file as a whole counts. Either way, a Setting table is a copy only when it
 * shares a row with the template's table and sits in a section whose name no
 * template heading has, so a `## Local stack` table is not a component.
 */
export function missingSettings(template, text) {
  const tables = markdownTables(text);
  const rows = new Set(tables.flatMap((table) => table.rows.map((row) => settingName(row[0]))));
  const missing = { rows: [], columns: [], tables: [] };
  const settingTables = tables.filter((own) => settingName(own.header[0]) === "setting");
  const headings = new Set(proseLines(template).map((line) => /^#{2,3} (.+)$/.exec(line)?.[1]).filter(Boolean)
    .map(settingName));
  for (const table of markdownTables(template)) {
    if (table.header[0] === "Setting") {
      const wanted = table.rows.map(([name]) => name).filter((name) => name && !isTodo(name));
      let copies = [];
      if (isTodo(table.subsection)) {
        const names = new Set(wanted.map(settingName));
        const component = (own) => !headings.has(settingName(own.subsection || own.section))
          && own.rows.some((row) => names.has(settingName(row[0])));
        const candidates = settingTables.filter(component);
        copies = candidates.filter((own) => settingName(own.section) === settingName(table.section) && own.subsection)
          .map((own) => ({ name: own.subsection, rows: own.rows }));
        if (!copies.length && candidates.length && candidates.every((own) => own.section && !own.subsection)) {
          copies = candidates.map((own) => ({ name: own.section, rows: own.rows }));
        }
      }
      if (!copies.length) {
        for (const name of wanted) if (!rows.has(settingName(name))) missing.rows.push({ name, component: null });
      }
      for (const copy of copies) {
        const own = new Set(copy.rows.map((row) => settingName(row[0])));
        for (const name of wanted) {
          if (!own.has(settingName(name))) missing.rows.push({ name, component: copy.name });
        }
      }
    } else if (COLUMN_TABLES.has(table.section)) {
      const own = tables.find((candidate) => settingName(candidate.header[0]) === settingName(table.header[0]));
      if (own) {
        const columns = new Set(own.header.map(settingName));
        for (const name of table.header) {
          if (!columns.has(settingName(name))) missing.columns.push({ table: table.section, name });
        }
      } else if (!hasHeading(text, table.section)) {
        missing.tables.push(table.section);
      }
    }
  }
  return missing;
}

/** For each profile file the project has, the settings its template has and the file lacks. */
export function profileGaps(project) {
  const gaps = [];
  for (const name of [...PROFILE, ...TEAM_PROFILE]) {
    const file = path.join(project, "docs/agents", name);
    const template = path.join(TEMPLATES, name);
    if (!fs.existsSync(file) || !fs.existsSync(template)) continue;
    const missing = missingSettings(fs.readFileSync(template, "utf8"), fs.readFileSync(file, "utf8"));
    if (Object.values(missing).some((list) => list.length)) gaps.push({ path: `docs/agents/${name}`, missing });
  }
  return gaps;
}

/**
 * Plan a complete installation without writing anything. force overwrites the
 * conflicting files; restore, which only the --force flag sets, also brings
 * back what the project removed on purpose: a removed agent-fleet section and
 * removed settings entries.
 */
export function prepare(project, { harnesses, instructions, force, restore = force, manifest }) {
  const files = desiredFiles(harnesses);
  const { actions, conflicts } = plan(project, files, manifest, force);
  const instructionPlan = instructions
    ? planInstructions(project, harnesses, manifest, force, restore)
    : { changes: [], conflicts: [], notes: [], blocks: {} };
  const settingsPlan = planSettings(project, harnesses, manifest, restore);
  return {
    files,
    actions,
    instructionChanges: [...instructionPlan.changes, ...(settingsPlan.change ? [settingsPlan.change] : [])],
    conflicts: [...conflicts, ...instructionPlan.conflicts],
    notes: [...instructionPlan.notes, ...settingsPlan.notes],
    blocks: instructionPlan.blocks,
    settings: settingsPlan.record,
    harnesses,
    instructions,
  };
}
