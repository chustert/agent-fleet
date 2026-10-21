#!/usr/bin/env node
/**
 * Check that a project's skills, tool adapters, and agent-fleet manifest agree.
 *
 * Run from anywhere:
 *
 *     node .agents/scripts/check-skills.mjs [project-root]
 *
 * Without an argument, the project root is two directories above this file,
 * which is where the agent-fleet installer puts it. A skill in .agents/skills/
 * that the manifest does not record belongs to the project. It needs no
 * adapters, but its frontmatter and Markdown links are checked like the
 * fleet's. Other paths the manifest does not record get a note and are not
 * checked: a file left inside a fleet skill's folder or beside a fleet
 * skill's adapter, such as .claude/skills/<name>/references/, and a skill
 * folder that only a tool's own folder holds, such as .claude/skills/<name>/.
 * The installer imports the same checks, so a project and the fleet agree on
 * what a correct installation is. This file is copied into projects, so it
 * uses only Node's standard library.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Frontmatter fields each tool's adapter keeps from the canonical skill.
export const HARNESSES = {
  claude: {
    label: "Claude Code",
    dir: ".claude/skills",
    fields: ["name", "description", "allowed-tools", "argument-hint", "disable-model-invocation",
      "user-invocable", "model"],
  },
  cursor: {
    label: "Cursor",
    dir: ".cursor/skills",
    fields: ["name", "description", "paths", "disable-model-invocation", "icon", "color", "metadata"],
  },
  kiro: {
    label: "Kiro",
    dir: ".kiro/skills",
    fields: ["name", "description"],
  },
};
export const CANONICAL = ".agents/skills";
export const REFERENCES = ".agents/references";
export const MANIFEST = ".agents/agent-fleet.json";
// agent-fleet grew out of skill-fleet. An installation by skill-fleet records
// its files here, and the agent-fleet installer takes it over.
export const LEGACY_MANIFEST = ".agents/skill-fleet.json";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LINK = /\]\(([^)\s]+)\)/g;

// The installer owns only the text between these markers in AGENTS.md and
// CLAUDE.md. Everything else in those files belongs to the project.
export const BLOCK_BEGIN = "<!-- agent-fleet:begin. The agent-fleet installer maintains this section. "
  + "Change it in the fleet and reinstall; a hand edit here stops the next update. -->";
export const BLOCK_END = "<!-- agent-fleet:end -->";
// A section that skill-fleet wrote, under its own markers, counts as the fleet's too.
export const BLOCK = /^<!-- (?:agent|skill)-fleet:begin\b[^\n]*-->\n([\s\S]*?)^<!-- (?:agent|skill)-fleet:end -->\n?/m;
export const LEGACY_BLOCK = /^<!-- skill-fleet:begin\b/m;
export const CLAUDE_IMPORT = /^@(\.\/)?AGENTS\.md\s*$/m;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function findBlock(text) {
  const match = BLOCK.exec(text);
  return match ? match[1] : null;
}

export function withBlock(text, body, prepend = false) {
  const block = `${BLOCK_BEGIN}\n${body}${BLOCK_END}\n`;
  if (BLOCK.test(text)) return text.replace(BLOCK, () => block);
  if (!text.trim()) return block;
  if (prepend) return `${block}\n${text}`;
  return `${text.replace(/\n+$/, "")}\n\n${block}`;
}

export function withoutBlock(text) {
  return text.replace(BLOCK, "");
}

/**
 * Split a SKILL.md into [[key, raw lines]] and the body after the frontmatter.
 * Each field keeps its original lines, including indented continuation lines,
 * so adapters copy values exactly without a YAML parser.
 */
export function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) throw new Error("missing YAML frontmatter");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new Error("unterminated YAML frontmatter");
  const fields = [];
  for (const line of text.slice(4, end).split("\n")) {
    const indented = line.startsWith(" ") || line.startsWith("\t");
    if (fields.length && (!line.trim() || indented)) {
      fields.at(-1)[1].push(line);
    } else if (line.includes(":") && !indented) {
      fields.push([line.split(":", 1)[0].trim(), [line]]);
    } else {
      throw new Error(`unexpected frontmatter line: ${JSON.stringify(line)}`);
    }
  }
  return [fields.map(([key, lines]) => [key, lines.join("\n").replace(/\s+$/, "")]), text.slice(end + 5)];
}

/** The string value of a simple `key: value` field. */
export function scalar(raw) {
  const [first, ...rest] = raw.split("\n");
  const value = first.slice(first.indexOf(":") + 1).trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return [value, ...rest].map((part) => part.trim()).filter(Boolean).join(" ");
}

/** The exact content of a tool adapter that points at the canonical skill. */
export function adapterText(name, canonicalText, fields) {
  const [frontmatter] = splitFrontmatter(canonicalText);
  const kept = frontmatter.filter(([key]) => fields.includes(key)).map(([, raw]) => raw);
  return `---\n${kept.join("\n")}\n---\n\n`
    + `Read \`../../../${CANONICAL}/${name}/SKILL.md\` and follow that canonical workflow in full.\n`;
}

/** Every file below dir, as sorted paths relative to dir with forward slashes. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(dir, "");
  return found.sort();
}

export function canonicalSkills(root) {
  const base = path.join(root, CANONICAL);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(base, entry.name, "SKILL.md")))
    .map((entry) => path.join(base, entry.name))
    .sort();
}

export function checkSkill(directory) {
  const name = path.basename(directory);
  let frontmatter;
  let body;
  try {
    [frontmatter, body] = splitFrontmatter(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"));
  } catch (error) {
    return [`${name}: ${error.message}`];
  }
  const fields = Object.fromEntries(frontmatter);
  const declared = "name" in fields ? scalar(fields.name) : null;
  const description = "description" in fields ? scalar(fields.description) : "";
  const errors = [];
  if (declared !== name) {
    errors.push(`${name}: frontmatter name ${JSON.stringify(declared)} does not match its folder`);
  } else if (!NAME.test(declared) || declared.length > 64) {
    errors.push(`${name}: name must be lowercase words joined by hyphens, at most 64 characters`);
  }
  const length = [...description].length;
  if (!description) errors.push(`${name}: description is missing`);
  else if (length > 1024) errors.push(`${name}: description is ${length} characters; the limit is 1024`);
  if (!body.trim()) errors.push(`${name}: body is empty`);
  return errors;
}

/** Every relative Markdown link in the given directories must resolve, except in the skipped files. */
export function checkLinks(root, directories, skip = new Set()) {
  const errors = [];
  for (const directory of directories) {
    for (const relative of listFiles(directory).filter((file) => file.endsWith(".md"))) {
      const file = path.join(directory, relative);
      if (skip.has(toPosix(path.relative(root, file)))) continue;
      for (const [, target] of fs.readFileSync(file, "utf8").matchAll(LINK)) {
        if (/^[a-z][a-z0-9+.-]*:/.test(target) || target.startsWith("#")) continue;
        if (!fs.existsSync(path.join(path.dirname(file), target.split("#")[0]))) {
          errors.push(`${toPosix(path.relative(root, file))}: broken link to ${target}`);
        }
      }
    }
  }
  return errors;
}

/** Whether the project's Git ignores the path. Outside a Git repository, nothing is ignored. */
function isIgnored(root, relative) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", relative], { stdio: "ignore" });
  return result.status === 0;
}

export function loadManifest(root) {
  const file = path.join(root, MANIFEST);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/**
 * Each fleet skill needs the exact adapter for every tool. With a manifest, a
 * fleet skill is one whose SKILL.md the manifest records. Any other skill
 * belongs to the project, which may give it adapters of its own or none. In a
 * tool's skill folder, a path the manifest records must be a fleet skill's
 * adapter. A path it does not record is left to unmanaged(): a skill only that
 * tool has, or a file left beside a fleet adapter by an earlier copy.
 */
export function checkAdapters(root, skills, harnesses, manifest = null) {
  const errors = [];
  const isFleet = (skill) => !manifest || `${CANONICAL}/${path.basename(skill)}/SKILL.md` in (manifest.files ?? {});
  const fleet = skills.filter(isFleet);
  const names = new Set(fleet.map((skill) => path.basename(skill)));
  const own = new Set(skills.filter((skill) => !isFleet(skill)).map((skill) => path.basename(skill)));
  const recorded = new Set(Object.keys(manifest?.files ?? {}));
  for (const harness of harnesses) {
    const { dir, fields } = HARNESSES[harness];
    for (const skill of fleet) {
      const name = path.basename(skill);
      const adapter = path.join(root, dir, name, "SKILL.md");
      if (!fs.existsSync(adapter)) {
        errors.push(`missing ${harness} adapter for ${name}`);
        continue;
      }
      const expected = adapterText(name, fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), fields);
      if (fs.readFileSync(adapter, "utf8") !== expected) {
        errors.push(`${harness} adapter for ${name} differs from the canonical skill`);
      }
    }
    for (const relative of listFiles(path.join(root, dir))) {
      const parts = relative.split("/");
      if (parts.at(-1) === ".DS_Store" || own.has(parts[0])) continue;
      if (manifest && !recorded.has(`${dir}/${relative}`)) continue;
      if (!names.has(parts[0]) || parts.length !== 2 || parts[1] !== "SKILL.md") {
        errors.push(`unexpected ${harness} skill file: ${dir}/${relative}`);
      }
    }
  }
  return errors;
}

export function checkManifest(root, manifest) {
  const errors = [];
  for (const [relative, digest] of Object.entries(manifest.files ?? {}).sort()) {
    const file = path.join(root, relative);
    // A fleet file the project's Git ignores is not in a fresh clone, so its absence is not an error.
    if (!fs.existsSync(file) && isIgnored(root, relative)) continue;
    if (!fs.existsSync(file)) errors.push(`fleet file missing: ${relative}`);
    else if (sha256(fs.readFileSync(file)) !== digest) {
      errors.push(`fleet file changed since install: ${relative}. Change it in the fleet and reinstall.`);
    }
  }
  // A null digest means the project removed the section on purpose.
  const blocks = manifest.blocks ?? {};
  for (const [relative, digest] of Object.entries(blocks).sort()) {
    if (digest === null) continue;
    const file = path.join(root, relative);
    const body = fs.existsSync(file) ? findBlock(fs.readFileSync(file, "utf8")) : null;
    if (body === null) {
      errors.push(`the agent-fleet section in ${relative} is missing. Reinstall to restore it.`);
    } else if (sha256(body) !== digest) {
      errors.push(`the agent-fleet section in ${relative} changed since install. `
        + "Change it in the fleet and reinstall.");
    }
  }
  // The agent team's permissions and hooks, which the installer merged into the Claude Code settings.
  const owned = manifest.settings?.owned ?? [];
  if (owned.length) {
    const file = path.join(root, ".claude/settings.json");
    let settings = null;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      errors.push(".claude/settings.json is missing or not valid JSON, so the agent team's hooks and permissions are off");
    }
    if (settings) {
      const present = new Set(settingsKeys(settings));
      const lost = owned.filter((key) => !present.has(key));
      if (lost.length) {
        errors.push(`.claude/settings.json lacks ${lost.length} of the agent team's entries, such as ${lost[0]}. `
          + "Reinstall to restore them.");
      }
    }
  }
  const managesInstructions = manifest.instructions !== false;
  if (managesInstructions && (manifest.harnesses ?? []).includes("claude") && blocks["CLAUDE.md"] !== null) {
    const claude = path.join(root, "CLAUDE.md");
    if (!fs.existsSync(claude) || !CLAUDE_IMPORT.test(fs.readFileSync(claude, "utf8"))) {
      errors.push("CLAUDE.md does not import AGENTS.md, so Claude Code misses the project instructions");
    }
  }
  return errors;
}

/** A JSON value with its object keys sorted, so two equal hook groups compare equal. */
export function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
  }
  return value;
}

/** The identity of every permission rule and hook group in a settings object, as the installer records them. */
export function settingsKeys(settings) {
  const keys = [];
  for (const kind of ["allow", "ask", "deny"]) {
    for (const rule of settings.permissions?.[kind] ?? []) keys.push(`permissions.${kind} ${rule}`);
  }
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) keys.push(`hooks.${event} ${JSON.stringify(sortedKeys(group))}`);
  }
  return keys;
}

/** Problems with the installation at root. An empty list means it is correct. */
export function check(root) {
  root = path.resolve(root);
  const skills = canonicalSkills(root);
  if (!skills.length) return [`no skills found in ${path.join(root, CANONICAL)}`];
  const errors = skills.flatMap(checkSkill);
  const manifest = loadManifest(root);
  let harnesses;
  if (manifest) {
    harnesses = manifest.harnesses ?? [];
    errors.push(...checkManifest(root, manifest));
  } else {
    harnesses = Object.keys(HARNESSES).filter((h) => fs.existsSync(path.join(root, HARNESSES[h].dir)));
  }
  errors.push(...checkAdapters(root, skills, harnesses, manifest));
  const linked = [CANONICAL, REFERENCES].map((dir) => path.join(root, dir)).filter((dir) => fs.existsSync(dir));
  // A file left inside a fleet skill's folder is a leftover, not a skill, so its links are not checked.
  const leftovers = manifest ? unmanaged(root, manifest).filter((p) => p.startsWith(`${CANONICAL}/`) && !p.endsWith("/")) : [];
  errors.push(...checkLinks(root, linked, new Set(leftovers)));
  return errors;
}

/** Whether the manifest records the path, or a path inside it when it is a folder. */
function isRecorded(recorded, relative) {
  return recorded.some((file) => file === relative || file.startsWith(`${relative}/`));
}

/**
 * Paths the manifest does not record, which are notes, never errors: in
 * .agents/skills/, a skill folder the fleet did not install and a file inside
 * a fleet skill folder, such as a script left over from an earlier copy; and
 * in the skill folder of each installed tool, a file beside a fleet skill's
 * adapter, such as a reference left by an earlier full copy, and a folder or
 * file that belongs to no skill in .agents/skills/, such as a skill only that
 * tool has. A project's own skill may keep adapters of any form, so they get
 * no note.
 */
export function unmanaged(root, manifest = loadManifest(root)) {
  const base = path.join(root, CANONICAL);
  if (!manifest) return [];
  const recorded = new Set(Object.keys(manifest.files ?? {}));
  const owned = new Set([...recorded].filter((file) => file.startsWith(`${CANONICAL}/`)).map((file) => file.split("/")[2]));
  const entries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
    .filter((entry) => entry.name !== ".DS_Store").sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const found = [];
  const folders = entries(base).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of folders) {
    if (!owned.has(name)) {
      found.push(`${CANONICAL}/${name}/`);
      continue;
    }
    for (const relative of listFiles(path.join(base, name))) {
      const file = `${CANONICAL}/${name}/${relative}`;
      if (!relative.split("/").includes(".DS_Store") && !recorded.has(file)) found.push(file);
    }
  }
  for (const harness of manifest.harnesses ?? []) {
    const dir = HARNESSES[harness]?.dir;
    if (!dir) continue;
    for (const entry of entries(path.join(root, dir))) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory() && (owned.has(entry.name) || isRecorded([...recorded], relative))) {
        // A fleet skill's adapter folder: checkAdapters covers the adapter, and any other file is a leftover.
        for (const file of listFiles(path.join(root, relative))) {
          if (!file.split("/").includes(".DS_Store") && !recorded.has(`${relative}/${file}`)) found.push(`${relative}/${file}`);
        }
      } else if (!folders.includes(entry.name) && !recorded.has(relative)) {
        // A folder named after a project's own skill in .agents/skills/ holds that skill's adapters.
        found.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
      }
    }
  }
  return found;
}

/** The note for the paths unmanaged() found, as lines, or no lines when there are none. */
export function unmanagedNote(paths) {
  if (!paths.length) return [];
  return [
    "Note: the fleet does not manage these skill paths:",
    ...paths.map((relative) => `  ${relative}`),
    "A path left over from an earlier copy of the fleet can be deleted. A project's own skill can stay, "
      + "unless it does the same job as a fleet skill, which setup-project checks. "
      + `In ${CANONICAL}/, its frontmatter and links are checked like the fleet's.`,
  ];
}

export function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

function main(argv) {
  const root = argv[0] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const errors = check(root);
  const note = unmanagedNote(unmanaged(root));
  if (note.length) process.stdout.write(note.join("\n") + "\n");
  if (errors.length) {
    process.stderr.write(errors.map((error) => `- ${error}`).join("\n") + "\n");
    return 1;
  }
  const manifest = loadManifest(root);
  const tools = manifest ? (manifest.harnesses ?? []).join(", ") || "no tools" : "the tools found";
  process.stdout.write(`${canonicalSkills(root).length} skills, adapters for ${tools}, and links check out.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
