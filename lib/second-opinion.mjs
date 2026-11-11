#!/usr/bin/env node
/**
 * Second-opinion review from a model of another family, for the reviewer agent.
 *
 *     node .agents/scripts/second-opinion.mjs <base-commit> <worktree-path> <issue-url> <output-file>
 *
 * Writes the exact patch, untracked files included, next to the output file.
 * It leaves out the protected files of the repository and of every agent-fleet
 * installation around it. Then it runs the `Command` row under
 * `Cross-model review` in `docs/agents/autonomy.md`, reading the profile from
 * the repository, or, for a member of a workspace without a profile of its own,
 * from the workspace root that findWorkspace() finds, and running the command
 * from the root it came from,
 * with PROMPT (the review request, which points at the patch file) and OUT
 * (where the reply must end up) in its environment. The command uses POSIX
 * shell syntax; on Windows it runs in Git Bash.
 *
 * Prints SECOND_OPINION_UNAVAILABLE and exits 0 when no command is configured,
 * the program is missing, or it fails, so the review continues single-model.
 * Node.js 20+, standard library only.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Secret files that never leave the machine, whatever the profile lists.
const SECRET_GLOBS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore",
  "**/*.jks", "**/*.mobileprovision", "**/*.tfvars", "**/*service-account*.json", "**/credentials*.json",
  "**/GoogleService-Info.plist", "**/google-services.json", "**/id_rsa*", "**/id_ed25519*"];

const unavailable = (reason) => {
  console.log(`SECOND_OPINION_UNAVAILABLE: ${reason}`);
  process.exit(0);
};

/** The backticked value of the first `| Command | ... |` row, or null. */
export function configuredCommand(text) {
  const match = /^\|\s*Command\s*\|\s*`(.+)`\s*\|/m.exec(text);
  return match ? match[1].trim() : null;
}

/** The backticked paths listed as bullets under `## Protected files`, without TODO entries. */
export function protectedPaths(text) {
  const section = /^## Protected files\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const paths = [];
  for (const line of section.split("\n").filter((l) => /^\s*- /.test(l))) {
    for (const [, value] of line.matchAll(/`([^`]+)`/g)) {
      if (!/^todo\b/i.test(value) && value !== "None") paths.push(value);
    }
  }
  return paths;
}

const gitOut = (cwd, ...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
// Paths compare as the file system resolves them, and Windows paths ignore case.
const sameCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const realPath = (p) => sameCase(fs.realpathSync.native(p));
const commonDir = (dir) => {
  const out = gitOut(dir, "rev-parse", "--git-common-dir");
  return out === null ? null : realPath(path.resolve(dir, out));
};
const MANIFEST = ".agents/agent-fleet.json";
/** A repository's agent-fleet record, or null when it has no installation. */
const installation = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8"));
  } catch {
    return fs.existsSync(path.join(root, MANIFEST)) ? {} : null;
  }
};

/** A path from one folder to another, with forward slashes and each folder name's case as the file system keeps it. */
const relativePath = (from, to) => path.relative(fs.realpathSync.native(from), fs.realpathSync.native(to)).split(path.sep).join("/");

/**
 * The agent-fleet installations around a repository, nearest first, up to
 * eight repositories out: { root, member, path, record, same }. member is the
 * repository's checkout inside root: the repository itself, or, for a worktree
 * kept inside its own main checkout, that checkout, which is an installation
 * with same set. path is member's path from root, empty for same.
 */
function installationsAround(root) {
  const own = commonDir(root);
  const found = [];
  let member = root;
  let dir = path.dirname(root);
  for (let depth = 0; depth < 8; depth++) {
    const outer = gitOut(dir, "rev-parse", "--show-toplevel");
    if (!outer) break; // Not inside another repository.
    const same = commonDir(outer) === own;
    if (same) member = outer; // A checkout of this same repository, with this worktree inside it.
    const record = installation(outer);
    if (record) found.push({ root: outer, member, path: same ? "" : relativePath(outer, member), record, same });
    if (path.dirname(outer) === outer) break;
    dir = path.dirname(outer);
  }
  return found;
}

/**
 * The installed workspace around a repository: { root, member, path, alone },
 * or null. root is the nearest Git repository that contains it and has an
 * agent-fleet installation that is not itself a workspace member, and neither
 * is a checkout of the repository itself. member is the repository's checkout
 * inside root, and path its path from root. When the only installation around
 * is a member's, as in a member cloned on its own, that member is the
 * workspace and alone is set: its profile applies, but the installer doesn't
 * make the repository its member.
 */
export function findWorkspace(root) {
  const others = installationsAround(root).filter((found) => !found.same);
  const workspace = others.find((found) => !found.record.workspace) ?? others[0];
  if (!workspace) return null;
  return { root: workspace.root, member: workspace.member, path: workspace.path, alone: Boolean(workspace.record.workspace) };
}

/**
 * The workspace whose profile also applies to a repository, or null. A
 * repository installed on its own, with --no-workspace, has none.
 */
function profileWorkspace(root) {
  return installation(root)?.workspace === false ? null : findWorkspace(root);
}

/**
 * The parts of a workspace protected-path pattern that apply inside a member at
 * memberPath: what follows the member's own segments, where the pattern's
 * segments, with `*`, `?` and `**`, match them in any case, as the patch's
 * exclusions do. A pattern that matches the member itself, or a folder around
 * it, gives `**`, every file in it. A pattern that can't reach into the member
 * gives nothing.
 */
export function patternsInMember(pattern, memberPath) {
  const segment = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`, "i");
  const after = (pat, member) => {
    if (!member.length) return [pat.length ? pat.join("/") : "**"];
    if (!pat.length) return ["**"]; // The pattern names a folder that holds the member.
    const [head, ...rest] = pat;
    if (head === "**") return [...after(rest, member), ...after(pat, member.slice(1))];
    return segment(head).test(member[0]) ? after(rest, member.slice(1)) : [];
  };
  return [...new Set(after(pattern.split("/").filter(Boolean), memberPath.split("/").filter(Boolean)))].filter(Boolean);
}

function hasProgram(name) {
  const probe = process.platform === "win32" ? ["where", [name]] : ["sh", ["-c", `command -v "${name}"`]];
  return spawnSync(probe[0], probe[1], { stdio: "ignore" }).status === 0;
}

function main(argv) {
  if (argv.length !== 4) {
    console.error("Usage: second-opinion.mjs <base-commit> <worktree-path> <issue-url> <output-file>");
    return 1;
  }
  const [base, worktree, issue, outArg] = argv;
  const out = path.resolve(outArg);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree, encoding: "utf8" }).trim();
  const workspace = profileWorkspace(root);
  const roots = workspace ? [root, workspace.root] : [root];
  const policy = roots.map((r) => path.join(r, "docs/agents/autonomy.md")).find((file) => fs.existsSync(file));
  // The command runs from the root whose profile names it, so a relative path in it resolves there.
  const commandRoot = policy ? path.dirname(path.dirname(path.dirname(policy))) : root;
  const command = policy ? configuredCommand(fs.readFileSync(policy, "utf8")) : null;
  if (!command || command === "None") unavailable("no Command under Cross-model review in docs/agents/autonomy.md");
  const program = command.split(/\s+/)[0];
  if (!hasProgram(program)) unavailable(`'${program}' is not installed or not on PATH`);

  // The protected files of every installation around the repository stay out of the patch, whichever profile
  // applies: a main checkout that holds this worktree, a member this repository is nested in, and the workspace,
  // even for a repository installed on its own. Leaving out more is the safe side. A profile around the repository
  // writes its paths from its own root, so a path inside this repository is also excluded from this root.
  const guarded = [{ root, path: "" }, ...installationsAround(root)];
  const listed = new Set(guarded.flatMap(({ root: r, path: inside }) => {
    const file = path.join(r, "docs/agents/verification.md");
    if (!fs.existsSync(file)) return [];
    return protectedPaths(fs.readFileSync(file, "utf8")).flatMap((p) => [p, ...(inside ? patternsInMember(p, inside) : [])]);
  }));
  const excludes = [...SECRET_GLOBS, ...[...listed].flatMap((p) => [p, `**/${p}`])].flatMap((p) => ["--exclude", p]);
  const gate = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate.mjs");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const patchFile = out.replace(/\.[^./\\]+$/, "") + ".patch";
  const patch = execFileSync(process.execPath, [gate, "diff", ...excludes], {
    cwd: worktree, encoding: "utf8", env: { ...process.env, AGENT_GATE_BASE: base }, maxBuffer: 512 * 1024 * 1024,
  });
  if (!patch.trim()) unavailable(`the patch from ${base} is empty`);
  fs.writeFileSync(patchFile, patch);

  const prompt = [
    `You are an independent senior code reviewer. Review only the change in the patch file ${patchFile}, a unified diff `
      + `from base commit ${base} in the repository at ${root}. The requirement source is ${issue}; read it with `
      + "'gh issue view' if you can. Read surrounding code only to understand contracts and callers. Modify no file, run "
      + "no command that writes, and contact no online service other than reading the issue.",
    "Report two separate sections: 'Specification' (missing, partial, incorrect or unrequested behaviour against the "
      + "issue) and 'Engineering' (correctness, security, reliability, error handling, concurrency, compatibility, "
      + "maintainability, and tests that do not prove the behaviour).",
    "For each finding use exactly this shape:\n[P0|P1|P2|P3] Title\nLocation: path:line\nEvidence: what the code shows\n"
      + "Impact: the concrete consequence\nFix: the smallest change that removes the risk",
    "P0 = severe harm, exploitable, data loss, cannot ship. P1 = likely incorrect behaviour or broken contract. "
      + "P2 = material weakness to fix before or soon after merge. P3 = localized improvement. Use P0 or P1 only with a "
      + "reachable path or violated contract you can point to. Put unconfirmed concerns under 'Unverified risks'. No style "
      + "comments unless they cause real cost. End with one line: 'Open P0-P2: <count>'.",
  ].join("\n\n");

  const shell = process.platform === "win32" ? "bash" : "/bin/sh";
  const result = spawnSync(shell, ["-c", command], {
    cwd: commandRoot, env: { ...process.env, PROMPT: prompt, OUT: out }, stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) unavailable("the configured command failed; see its output above");
  if (!fs.existsSync(out) || !fs.statSync(out).size) unavailable(`the command wrote nothing to ${out}`);
  console.log(`Second opinion written to ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
