#!/usr/bin/env node
// Verification gate for the agent dev loop.
//
// A verdict covers one exact patch. This script fingerprints the patch with
// `git patch-id --verbatim` (whitespace counts; line numbers don't, so a clean
// rebase keeps the fingerprint), records verdicts that only the running
// `verifier` subagent may write, and refuses a ready-for-review PR unless the
// latest verdict for the branch is PASS or PASS+NOTES, has no blocking
// findings, and matches the committed and pushed patch. The idea and the
// patch-id rule come from pstack by Lauren Tan (MIT): the
// agent that wrote the code never gets to say it works, and any edit
// invalidates an old verdict.
//
// In a workspace, a repository that holds independent child repositories in
// its subfolders, `gate.mjs workspace set <path>...` names the repositories an
// issue changes. A verdict then covers every one of them, and a pull request in
// any of them needs that verdict. A repository without a workspace file works
// exactly as before.
//
// Commands:
//   gate.mjs fingerprint [--committed] [--repo <path>]   fingerprint of base..worktree (or base..HEAD);
//                                        in a workspace, of every member, or of one with --repo
//   gate.mjs diff [--committed] [--repo <path>] [--exclude <pathspec>]...   the exact patch of one repository
//   gate.mjs paths                       JSON: repo root, branch, base, run directory, and workspace members
//   gate.mjs set-base <commit> [--repo <path>]   record the branch's base (from start-issue)
//   gate.mjs workspace set <path>... | show | clear   name the repositories an issue changes, from the workspace root
//   gate.mjs record --verdict V --blocking N --issue URL --report PATH   (verifier only)
//   gate.mjs show                        latest verdict and whether it still matches
//   gate.mjs check [--committed]         exit 0 when the gate passes, 1 otherwise
//   gate.mjs hook bash-guard             PreToolUse (Bash) in settings.json: ready PRs, verdict state, default branch
//   gate.mjs hook state-guard            PreToolUse (Edit|Write|NotebookEdit) in settings.json
//   gate.mjs hook verifier-start         SubagentStart, matcher ^verifier$
//   gate.mjs hook verifier-stop          SubagentStop, matcher ^verifier$
//   gate.mjs hook observe-only           PreToolUse (Bash) in verifier/reviewer frontmatter
//   gate.mjs hook authorize-record       PreToolUse (Bash) in verifier frontmatter
//   gate.mjs hook write-scope            PreToolUse (Edit|Write|NotebookEdit) in frontmatter
//   gate.mjs hook agent-scope <types..>  PreToolUse (Agent) in frontmatter
//
// Node.js 20+, standard library only. State lives in <git-common-dir>/agent-runs/
// (shared by every worktree, never tracked), or in $AGENT_RUNS_DIR when set.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERDICTS = ["PASS", "PASS+NOTES", "FAIL", "BLOCKED"];
const PASSING = new Set(["PASS", "PASS+NOTES"]);
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOKEN_MAX_AGE_MS = 60 * 1000;
// Agent memory is not part of the patch under verification: agents update it
// after recording a verdict, and it never changes product behaviour.
const MEMORY_EXCLUDES = [":(exclude).claude/agent-memory", ":(exclude).claude/agent-memory-local"];

// ---------------------------------------------------------------- git helpers

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
}

function tryGit(args, opts) {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

function repoInfo(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], { cwd });
  const common = path.resolve(root, git(["rev-parse", "--git-common-dir"], { cwd: root }));
  const named = tryGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root });
  const head = tryGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  const branch = named ?? `detached-${(head ?? "nohead").slice(0, 12)}`;
  return { root, common, branch, detached: !named };
}

function tryRepoInfo(dir) {
  try {
    return repoInfo(dir);
  } catch {
    return null;
  }
}

function defaultBaseRef(root) {
  const head = tryGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  for (const ref of [head, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    if (tryGit(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root })) return ref;
  }
  return null;
}

// Base: AGENT_GATE_BASE, else the base recorded with `set-base` (from the
// start-issue record), else the merge base with the default branch.
function resolveBase(info) {
  const recorded = info.detached ? null : tryGit(["config", "--get", `branch.${info.branch}.agentbase`], { cwd: info.root });
  const override = process.env.AGENT_GATE_BASE || recorded;
  if (override) return git(["rev-parse", "--verify", `${override}^{commit}`], { cwd: info.root });
  const ref = defaultBaseRef(info.root);
  if (!ref) throw new Error("No base: no origin/HEAD, origin/main, main or master. Run `gate.mjs set-base <commit>`.");
  return git(["merge-base", "HEAD", ref], { cwd: info.root });
}

// Tree of the working directory, including untracked files .gitignore does not
// exclude, built in a throwaway index so the real index is untouched.
function worktreeTree(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    if (tryGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root })) git(["read-tree", "HEAD"], { cwd: root, env });
    git(["add", "-A", "."], { cwd: root, env });
    return git(["write-tree"], { cwd: root, env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function patchText(info, { committed = false, binary = true, excludes = [] } = {}) {
  const base = resolveBase(info);
  const target = committed ? git(["rev-parse", "HEAD"], { cwd: info.root }) : worktreeTree(info.root);
  const args = ["diff", "--no-color", "--no-ext-diff", ...(binary ? ["--binary"] : []), base, target, "--", ".", ...MEMORY_EXCLUDES];
  for (const e of excludes) args.push(`:(exclude,glob)${e}`);
  return { base, text: execFileSync("git", args, { cwd: info.root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }) };
}

function fingerprint(info, { committed = false } = {}) {
  const { base, text } = patchText(info, { committed });
  if (!text.trim()) return { base, fingerprint: "empty" };
  const id = git(["patch-id", "--verbatim"], { cwd: info.root, input: text }).split(/\s+/)[0];
  return { base, fingerprint: id || "empty" };
}

// ---------------------------------------------------------------- state

function runsRoot(info) {
  if (process.env.AGENT_RUNS_DIR) {
    const id = crypto.createHash("sha256").update(info.common).digest("hex").slice(0, 10);
    return path.join(process.env.AGENT_RUNS_DIR, `${path.basename(path.dirname(info.common))}-${id}`);
  }
  return path.join(info.common, "agent-runs");
}

function runDirPath(info) {
  return path.join(runsRoot(info), info.branch.replace(/[^A-Za-z0-9._-]/g, "__"));
}

function runDir(info) {
  const dir = runDirPath(info);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateDir(info, name) {
  const dir = path.join(runsRoot(info), "_" + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const safeId = (id) => String(id || "default").replace(/[^A-Za-z0-9._-]/g, "_");
const lockFile = (info, agentId) => path.join(stateDir(info, "locks"), `verifier-${safeId(agentId)}.lock`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function latestVerdict(info) {
  return readJson(path.join(runDir(info), "latest.json"));
}

// ---------------------------------------------------------------- workspaces
//
// The workspace file lives in the workspace root's run directory and lists its
// members as paths from the workspace root, "." being the workspace's own
// repository. Gate state for a workspace issue lives in that run directory too,
// whichever member a command or hook starts in.

const WORKSPACE_FILE = "workspace.json";
const toPosix = (p) => p.split(path.sep).join("/");
const memberDir = (ws, rel) => path.resolve(ws.root, ...rel.split("/"));

/** The members recorded for the workspace whose root is info.root, or null. */
function workspaceMembers(info) {
  const data = readJson(path.join(runDirPath(info), WORKSPACE_FILE));
  return Array.isArray(data?.members) && data.members.length ? data.members : null;
}

/** The repository of one member, by its path from the workspace root. */
function memberRepo(ws, rel) {
  if (rel === ".") return ws;
  const dir = memberDir(ws, rel);
  const info = fs.existsSync(dir) ? tryRepoInfo(dir) : null;
  if (!info || realish(info.root) !== realish(dir)) {
    throw new Error(`${rel} is not the root of a Git repository of its own. Name the issue's repositories again with \`gate.mjs workspace set\`.`);
  }
  return info;
}

/** The workspace that lists a repository as a member: { ws, members, rel }, or null. */
function enclosingWorkspace(info) {
  // Walk up the repositories that contain this one, so a member nested in another member is found too.
  let dir = path.dirname(info.root);
  for (let depth = 0; depth < 8 && dir !== path.dirname(dir); depth++) {
    const ws = tryRepoInfo(dir);
    if (!ws) return null;
    const members = workspaceMembers(ws);
    const rel = toPosix(path.relative(ws.root, info.root));
    if (members?.includes(rel)) return { ws, members, rel };
    dir = path.dirname(ws.root);
  }
  return null;
}

/**
 * Where the gate's state lives for a repository. In a workspace, info is the
 * workspace root, members lists the member paths, and rel is this repository's
 * member. Otherwise members is null and info is the repository itself.
 */
function contextOf(info) {
  // Membership comes first: a member answers to the workspace's verdict even if it has a workspace file of its own.
  const outer = enclosingWorkspace(info);
  if (outer) return { info: outer.ws, members: outer.members, rel: outer.rel };
  const members = workspaceMembers(info);
  if (members) return { info, members, rel: "." };
  return { info, members: null, rel: null };
}

const gateContext = (cwd = process.cwd()) => contextOf(repoInfo(cwd));

function memberStates(ws, members, { committed = false } = {}) {
  return members.map((rel) => {
    const info = memberRepo(ws, rel);
    const { base, fingerprint: fp } = fingerprint(info, { committed });
    return { path: rel, branch: info.branch, base, fingerprint: fp };
  });
}

/** One fingerprint for a workspace change: every member's path and patch. */
function combinedFingerprint(states) {
  const id = crypto.createHash("sha256").update(JSON.stringify(states.map((s) => [s.path, s.fingerprint]))).digest("hex");
  return `workspace-${id.slice(0, 40)}`;
}

/** The fingerprint of what a context covers: one repository, or every workspace member. */
function contextFingerprint(ctx, { committed = false } = {}) {
  if (!ctx.members) return { ...fingerprint(ctx.info, { committed }), repos: null };
  const repos = memberStates(ctx.info, ctx.members, { committed });
  return { base: null, fingerprint: combinedFingerprint(repos), repos };
}

/** Whether a Git origin URL names the same repository as a slug such as `<owner>/<name>` or `github.com/<owner>/<name>`. */
function sameRepository(origin, slug) {
  const lastTwo = (s) => s.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/").toLowerCase();
  return Boolean(origin) && lastTwo(slug).includes("/") && lastTwo(origin) === lastTwo(slug);
}

/** Whether a `gh --repo` slug names a repository's origin: the origin ends in the slug, and its owner and name match. */
function isOrigin(root, slug) {
  const origin = tryGit(["remote", "get-url", "origin"], { cwd: root }) ?? "";
  return origin.replace(/\.git$/, "").endsWith(slug.replace(/^.*github\.com[/:]/, "")) && sameRepository(origin, slug);
}

/** The repository of a workspace issue whose origin a `gh --repo` slug names, the workspace root or a member, or null. */
function memberForSlug(ctx, slug) {
  for (const root of new Set([ctx.info.root, ...ctx.members.map((rel) => memberDir(ctx.info, rel))])) {
    const info = fs.existsSync(root) ? tryRepoInfo(root) : null;
    if (info && realish(info.root) === realish(root) && isOrigin(root, slug)) return info;
  }
  return null;
}

/** The default branches of a workspace's root and members. */
function workspaceDefaults(ctx) {
  return [ctx.info.root, ...ctx.members.map((rel) => memberDir(ctx.info, rel))].map((dir) => defaultBranch(dir));
}

// ---------------------------------------------------------------- shell parsing
//
// Best-effort tokenizer: splits a Bash command into simple commands on ; & | &&
// || and newlines, respecting quotes, and also yields the contents of $(...)
// and backticks as commands of their own. Good enough for guardrails, not a
// sandbox. It knows no heredocs or comments, so it reads their text as
// commands too, which errs toward refusing.
//
// Every change since its first version makes it read more, never less, so a
// change can only make the gate refuse more. It finds commands behind shell
// keywords such as `then`, and behind wrappers that take options, such as
// `timeout 10` or `sudo -u <user>`. It reads every script a shell takes, as an
// argument wherever the shell appears or as a here-string, `eval` and `trap`
// strings, and the command `find -exec` runs. Where a quote or substitution
// never closes, so the rest of the line reads as one word, it reads the line a
// second time with that character taken literally, and keeps both readings.

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Commands that run the command after their own options.
const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "sudo", "xargs", "nice", "timeout", "stdbuf", "builtin"]);
// Words that can come before a command in a compound command.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
const COMMAND_WORDS = new Set(["gh", "git", ...SHELLS]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const base = (w) => path.basename(w);

/**
 * A command's words without leading assignments, keywords and wrappers, with
 * the wrappers' options, such as `env -C <dir>`, `sudo -u <user>` or `timeout
 * 10`. Notes in state.chdir when a wrapper changes directory.
 */
function normalize(words, state) {
  let w = words.slice();
  for (;;) {
    while (w.length && (ASSIGNMENT.test(w[0]) || KEYWORDS.has(w[0]))) w.shift();
    if (!w.length || !WRAPPERS.has(base(w[0]))) return w;
    const wrapper = base(w.shift());
    const next = w.findIndex((t) => ASSIGNMENT.test(t) || WRAPPERS.has(base(t)) || COMMAND_WORDS.has(base(t)));
    if (next > 0) {
      const chdir = { env: /^(-[A-Za-z]*C|--chdir)/, sudo: /^(-[A-Za-z]*D|--chdir)/ }[wrapper];
      if (chdir && w.slice(0, next).some((t) => chdir.test(t))) state.chdir = true;
      w = w.slice(next);
    }
  }
}

/**
 * The simple commands of a command line, each as its words without leading
 * assignments, keywords and wrappers. Sets state.unclosed when a quote or
 * substitution never closes, and state.chdir when a backtick substitution
 * names a command, as in `\`echo cd\` <dir>`, since the reader drops it from
 * the words. In literal mode, a character that never closes counts as itself.
 */
function readCommands(src, state, literal = false) {
  const out = [];
  let cur = [];
  let tok = "";
  let inTok = false;
  const pushTok = () => {
    if (inTok) cur.push(tok);
    tok = "";
    inTok = false;
  };
  const pushCmd = () => {
    pushTok();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    let open = false;
    if (c === "\\" && i + 1 < src.length) {
      tok += src[++i];
      inTok = true;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      open = end === -1;
      if (!(open && literal)) {
        tok += src.slice(i + 1, open ? src.length : end);
        inTok = true;
        i = open ? src.length : end;
      }
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) s += src[++j];
        else s += src[j];
        j++;
      }
      open = j >= src.length;
      if (!(open && literal)) {
        for (const inner of extractSubstitutions(s)) out.push(...readCommands(inner, state, literal));
        tok += s;
        inTok = true;
        i = j;
      }
    } else if (c === "$" && src[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      }
      open = depth > 0;
      if (!(open && literal)) {
        out.push(...readCommands(src.slice(i + 2, j - 1), state, literal));
        tok += "$SUBST";
        inTok = true;
        i = j - 1;
      }
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      open = end === -1;
      if (!inTok && cur.every((w) => ASSIGNMENT.test(w) || KEYWORDS.has(w) || WRAPPERS.has(base(w)))) state.chdir = true;
      if (!(open && literal)) {
        out.push(...readCommands(src.slice(i + 1, open ? src.length : end), state, literal));
        i = open ? src.length : end;
      }
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      pushCmd();
    } else if (/\s/.test(c)) {
      pushTok();
    } else {
      tok += c;
      inTok = true;
    }
    if (open) {
      state.unclosed = true;
      // Literal mode: the character that never closes is part of a word, and the text after it is read as usual.
      if (literal) {
        tok += c;
        inTok = true;
      }
    }
  }
  pushCmd();
  const commands = out.map((words) => normalize(words, state)).filter((w) => w.length);
  const nested = [];
  for (const w of commands) {
    // The script a shell runs: each word after its -c option, as in `bash -c -- '<script>'`, wherever the shell
    // appears, as under `find -exec sh -c`, and a here-string, as in `bash <<< '<script>'`.
    const shellAt = w.findIndex((t) => SHELLS.has(base(t)));
    if (shellAt !== -1) {
      const flag = w.findIndex((arg, index) => index > shellAt && /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag !== -1) for (const script of w.slice(flag + 1)) nested.push(...readCommands(script, state, literal));
      w.forEach((arg, k) => {
        const here = arg.indexOf("<<<");
        if (k > shellAt && here !== -1) nested.push(...readCommands(arg.slice(here + 3) || (w[k + 1] ?? ""), state, literal));
      });
    }
    // `eval` runs its arguments as one script, and `trap` each of its own.
    if (w[0] === "eval") nested.push(...readCommands(w.slice(1).join(" "), state, literal));
    if (w[0] === "trap") for (const script of w.slice(1)) nested.push(...readCommands(script, state, literal));
    // `find -exec` and its kin run the command after them.
    const exec = base(w[0]) === "find" ? w.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t)) : -1;
    if (exec !== -1) {
      const run = normalize(w.slice(exec + 1), state);
      if (run.length) nested.push(run);
    }
  }
  return [...commands, ...nested];
}

/** A command line, read: its commands, and whether it may change directory in a way the words don't show (chdir). */
function readCommandLine(src) {
  const state = {};
  const commands = readCommands(src, state);
  // A quote or substitution that never closes makes the rest of the line one word, though bash may read it otherwise,
  // as in a comment such as `# don't`. Read the line again with that character taken literally, and keep both readings.
  if (state.unclosed) commands.push(...readCommands(src, state, true));
  return { commands, chdir: Boolean(state.chdir) };
}

/** The commands of a command line, each without its leading assignments, keywords and wrappers. */
const splitCommands = (src) => readCommandLine(src).commands;

function extractSubstitutions(s) {
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        j++;
      }
      found.push(s.slice(i + 2, j - 1));
      i = j - 1;
    } else if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(s.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

// git [global options] <sub> [args]  →  { sub, args, cwdOpts, targets, configs, gitDir }
// targets are the paths the options point git at: -C, --git-dir, --work-tree. cwdOpts are the -C paths in order,
// configs the -c settings, and gitDir whether --git-dir or --work-tree is set.
function parseGit(words) {
  if (base(words[0]) !== "git") return null;
  let i = 1;
  const cwdOpts = [];
  const targets = [];
  const configs = [];
  let gitDir = false;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(w);
    if (eq) {
      targets.push(eq[2]);
      gitDir = true;
      i += 1;
    } else if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--exec-path") {
      if (w === "-C") cwdOpts.push(words[i + 1]);
      if (w === "-c") configs.push(words[i + 1] ?? "");
      if (w === "--git-dir" || w === "--work-tree") gitDir = true;
      if (w === "-C" || w === "--git-dir" || w === "--work-tree") targets.push(words[i + 1]);
      i += 2;
    } else i += 1;
  }
  return { sub: words[i], args: words.slice(i + 1), cwdOpts, targets, configs, gitDir };
}

// gh [global flags] <group> <sub> [args]  →  { group, sub, args, repo }
function parseGh(words) {
  if (base(words[0]) !== "gh") return null;
  let i = 1;
  let repo = null;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-R" || w === "--repo" || w === "--hostname") {
      if (w !== "--hostname") repo = words[i + 1];
      i += 2;
    } else if (w.startsWith("--repo=")) {
      repo = w.slice(7);
      i += 1;
    } else i += 1;
  }
  const group = words[i];
  if (group !== "pr") return { group, sub: words[i + 1], args: words.slice(i + 2), repo };
  // `gh pr` also takes its flags before the subcommand, as in `gh pr -R <owner>/<name> create`.
  let j = i + 1;
  while (j < words.length && words[j].startsWith("-")) {
    if (words[j] === "-R" || words[j] === "--repo") {
      repo ??= words[j + 1];
      j += 2;
    } else {
      if (words[j].startsWith("--repo=")) repo ??= words[j].slice(7);
      j += 1;
    }
  }
  const args = words.slice(j + 1);
  // `gh pr new` is gh's alias for `gh pr create`, and gh also takes --repo after the subcommand.
  return { group, sub: words[j] === "new" ? "create" : words[j], args, repo: repo ?? flagValue(args, "-R", "--repo") };
}

// Options that take a value in the next word, so that word is no positional argument.
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const GH_VALUE_FLAGS = new Set(["-B", "--base", "-t", "--title", "-b", "--body", "-F", "--body-file", "-H", "--head",
  "-m", "--milestone", "-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-p", "--project", "-T", "--template",
  "-R", "--repo", "-q", "--jq", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer", "--add-assignee",
  "--remove-assignee", "--add-project", "--remove-project"]);

/** The positional arguments of a command's arguments: no options, and no values of the options that take one. */
function positionalArgs(args, valueFlags) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    if (valueFlags.has(args[k])) k++;
    else if (!args[k].startsWith("-")) out.push(args[k]);
  }
  return out;
}

// A flag is on when it appears bare or with a value other than false, 0, no or off.
const hasFlag = (args, ...names) =>
  args.some((a) => names.some((n) => a === n
    || (n.startsWith("--") && a.startsWith(n + "=") && !/^(false|0|no|off)$/i.test(a.slice(n.length + 1)))));

function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (n.startsWith("--") && args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return null;
}

// Does a `gh api` call write? (any method but GET, or fields/input without -X GET)
function ghApiWrites(args) {
  const method = (flagValue(args, "-X", "--method") || "").toUpperCase();
  if (method && method !== "GET") return true;
  const hasBody = hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
  if (hasBody && method !== "GET") return true;
  const joined = args.join(" ");
  return /\bgraphql\b/.test(joined) && /\bmutation\b/.test(joined);
}

/** A `cd` path, the way Git Bash on Windows also writes it, such as `/c/Users/me`. */
function resolveCdPath(from, target) {
  let t = target;
  if (t === "~" || t.startsWith("~/")) t = path.join(os.homedir(), t.slice(1));
  if (process.platform === "win32" && /^\/[A-Za-z](\/|$)/.test(t)) t = `${t[1]}:\\${t.slice(3)}`;
  return path.resolve(from, t);
}

/**
 * The directories the commands of a line may run in: cwd, and each target of a
 * `cd`, `pushd` or `chdir` on it, resolved from cwd and from the target before
 * it. null when the line changes directory in a way the gate can't resolve: a
 * target with an expansion, `cd -`, `env -C`, `sudo -D`, a script read with
 * `source` or `.`, or a command named by an expansion or a substitution.
 */
function possibleDirs(line, raw, cwd) {
  if (line.chdir) return null;
  const dirs = [cwd];
  let last = cwd;
  for (const w of line.commands) {
    if (w[0] === "source" || w[0] === "." || /[$`]/.test(w[0])) return null;
    if (!["cd", "pushd", "chdir"].includes(w[0])) continue;
    const args = w.slice(1).filter((a) => a !== "--");
    // The reader drops a backtick substitution from its word, so a target could have held one.
    if (args.includes("-") || raw.includes("`")) return null;
    const target = args.find((a) => !a.startsWith("-")) ?? "~";
    if (/[$*?[{]/.test(target)) return null;
    dirs.push(resolveCdPath(cwd, target), (last = resolveCdPath(last, target)));
  }
  return dirs;
}

// ---------------------------------------------------------------- gate logic

function evaluate(info, { committed }) {
  const v = latestVerdict(info);
  const current = fingerprint(info, { committed });
  if (!v) return { ok: false, reason: `No verdict recorded for branch ${info.branch}. Run a fresh verifier first.` };
  if (!PASSING.has(v.verdict)) return { ok: false, reason: `Latest verdict is ${v.verdict}. Fix the findings and re-verify.` };
  if (Number(v.blocking) !== 0) return { ok: false, reason: `Latest verdict has ${v.blocking} open P0-P2 finding(s).` };
  if (v.fingerprint !== current.fingerprint) {
    return {
      ok: false,
      reason:
        `The verified patch (${v.fingerprint.slice(0, 12)}) differs from the ${committed ? "committed" : "working-tree"} patch ` +
        `(${current.fingerprint.slice(0, 12)}): the code changed after verification, or not everything verified is committed. Re-verify.`,
    };
  }
  return { ok: true, reason: `Verified ${v.verdict} at ${v.recorded_at} matches the current ${committed ? "committed" : "working-tree"} patch.` };
}

/**
 * Judge a workspace verdict. It must cover exactly the members the workspace
 * names now. Without a target, every member's working-tree patch, or committed
 * patch with `committed`, must match. With a target, the member a pull request
 * comes from, that member's committed patch must match, and every other
 * member's committed or working-tree patch, so a verdict for a change across
 * repositories stops covering it once any part of it changes.
 */
function evaluateWorkspace(ctx, { committed, target = null }) {
  const v = latestVerdict(ctx.info);
  if (!v) return { ok: false, reason: `No verdict recorded for the workspace on branch ${ctx.info.branch}. Run a fresh verifier first.` };
  if (!PASSING.has(v.verdict)) return { ok: false, reason: `Latest verdict is ${v.verdict}. Fix the findings and re-verify.` };
  if (Number(v.blocking) !== 0) return { ok: false, reason: `Latest verdict has ${v.blocking} open P0-P2 finding(s).` };
  if (!Array.isArray(v.repos)) {
    return { ok: false, reason: "The latest verdict covers the workspace's own repository, not its members. Re-verify after `gate.mjs workspace set`." };
  }
  const covered = v.repos.map((r) => r.path);
  const missing = ctx.members.filter((rel) => !covered.includes(rel));
  const extra = covered.filter((rel) => !ctx.members.includes(rel));
  if (missing.length || extra.length) {
    return {
      ok: false,
      reason: `The workspace now names ${ctx.members.join(", ")}, but the latest verdict covers ${covered.join(", ")}. Re-verify the change as it is now.`,
    };
  }
  if (target !== null && !covered.includes(target)) {
    return { ok: false, reason: `${target} is not part of the latest verdict, which covers ${covered.join(", ")}. Re-verify with it included.` };
  }
  for (const r of v.repos) {
    const info = memberRepo(ctx.info, r.path);
    if (info.branch !== r.branch) return { ok: false, reason: `${r.path} is on ${info.branch}, but the verdict covers ${r.branch}.` };
    // The committed patch first: after the documented commit, it is the one that matches, and it is cheaper.
    const modes = target === null ? [committed] : r.path === target ? [true] : [true, false];
    if (!modes.some((c) => fingerprint(info, { committed: c }).fingerprint === r.fingerprint)) {
      const which = target === null ? (committed ? "committed" : "working-tree") : r.path === target ? "committed" : "current";
      return {
        ok: false,
        reason: `The verified patch of ${r.path} (${r.fingerprint.slice(0, 12)}) differs from its ${which} patch: the code changed after ` +
          "verification, or not everything verified is committed. Re-verify.",
      };
    }
  }
  return { ok: true, reason: `Verified ${v.verdict} at ${v.recorded_at} covers ${covered.join(", ")}, and every patch still matches.` };
}

/** The gate's judgement for a repository: its workspace verdict when it is a member, else its own. */
function judge(info, { committed }) {
  const ctx = contextOf(info);
  return ctx.members ? evaluateWorkspace(ctx, { committed, target: ctx.rel }) : evaluate(ctx.info, { committed });
}

function pushedMatchesHead(info) {
  const head = git(["rev-parse", "HEAD"], { cwd: info.root });
  const pushed = tryGit(["rev-parse", "--verify", "-q", "@{push}"], { cwd: info.root });
  if (!pushed) return { ok: false, reason: "The branch has no pushed counterpart. Push it before opening a ready PR." };
  if (pushed !== head) return { ok: false, reason: "The pushed branch differs from HEAD. Push the verified commit (or re-verify what was pushed)." };
  return { ok: true };
}

// The real path of a file that may not exist yet: the nearest existing
// ancestor resolved through symlinks, such as macOS's /var -> /private/var,
// with the rest appended.
function realish(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = fs.realpathSync.native(existing);
  const joined = path.join(real, ...rest);
  return process.platform === "win32" ? joined.toLowerCase() : joined;
}

// ---------------------------------------------------------------- hook I/O

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
  );
  process.exit(0);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      flags._.push(a);
      continue;
    }
    // `--key=value` as well as `--key value`.
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const key = a.slice(2, eq);
      if (key === "exclude") (flags.exclude ??= []).push(a.slice(eq + 1));
      else flags[key] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      if (key === "exclude") (flags.exclude ??= []).push(next);
      else flags[key] = next;
      i++;
    }
  }
  return flags;
}

// ---------------------------------------------------------------- hooks

/** The default branch's short name, from origin/HEAD, else main or master. */
function defaultBranch(root) {
  const head = tryGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  if (head) return head.replace(/^origin\//, "");
  return tryGit(["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: root }) ? "main" : "master";
}

/** The run directories' roots that apply to a directory: its repository's, and its workspace's when it is a member. */
function stateRoots(cwd) {
  const info = tryRepoInfo(cwd);
  if (!info) return [];
  const ws = enclosingWorkspace(info)?.ws;
  return [...new Set([runsRoot(info), ...(ws ? [runsRoot(ws)] : [])])];
}

/** Whether a path, once real, could be gate state at all: under an `agent-runs` directory or $AGENT_RUNS_DIR. */
function underRuns(file) {
  const real = realish(file);
  const custom = process.env.AGENT_RUNS_DIR ? realish(path.resolve(process.env.AGENT_RUNS_DIR)) : null;
  return real.split(path.sep).includes("agent-runs") || (custom !== null && (real === custom || real.startsWith(custom + path.sep)));
}

/** Whether a path, once real, falls in the gate's own state under any of the roots: tokens, locks and verdict records. */
function isGateState(roots, file) {
  const abs = realish(file);
  return roots.some((runs) => {
    const root = realish(runs);
    if (!(abs === root || abs.startsWith(root + path.sep))) return false;
    const [top] = path.relative(root, abs).split(path.sep);
    return top.startsWith("_") || ["latest.json", "verdicts.jsonl"].includes(path.basename(abs));
  });
}

const UNCLEAR_DIRECTORY = "Verification gate: this command line changes directory in a way the gate can't resolve, such as "
  + "`cd $DIR`, `cd -`, `env -C`, `source` or a backtick substitution, so it can't tell which repository the command acts on. "
  + "Run the directory change as a command of its own first, then this command.";

/** Refuse a push that could reach a default branch. */
function checkPush(g, { line, raw, cwd, info, ctx }) {
  const main = defaultBranch(info.root);
  // In a workspace, the default branch of the workspace root and of every member too.
  const protectedNames = new Set(["main", "master", main, ...(ctx.members ? workspaceDefaults(ctx) : [])]);
  const positional = g.args.filter((arg) => !arg.startsWith("-"));
  const refspecs = positional.slice(1);
  const destination = (spec) => (spec.includes(":") ? spec.split(":").pop() : spec).replace(/^\+/, "");
  const isHead = (spec) => ["HEAD", "@"].includes(destination(spec));
  const protectedName = (spec) => protectedNames.has(destination(spec).replace(/^(refs\/)?heads\//, ""));
  if (hasFlag(g.args, "--all", "--mirror", "--branches")
    || (refspecs.length === 0 && info.branch === main)
    || refspecs.some((spec) => protectedName(spec) || (isHead(spec) && info.branch === main))) {
    deny(`Never push to the default branch (${main}). Push the issue branch and open a pull request.`);
  }
  if (refspecs.some((spec) => /[*?[]/.test(spec)) || g.configs.some((c) => /^(remote\..*\.push|push\.default)=/i.test(c))) {
    deny("Verification gate: name the branch to push plainly, as `git push <remote> <branch>`. A glob, or a push "
      + "refspec or push.default set with -c, could reach the default branch.");
  }
  // A push that names no branch, or names HEAD or an expansion, pushes the branch checked out where it runs.
  const named = positionalArgs(g.args, PUSH_VALUE_FLAGS).slice(1);
  if (named.length && !named.some((spec) => isHead(spec) || /[$`]/.test(spec))) return;
  if (ctx.members) {
    deny("Verification gate: in a workspace, name the branch to push, as `git -C <repository> push -u origin <branch>`. "
      + "A bare `git push`, HEAD, @ or an expansion pushes whatever the repository it runs in has checked out, and the "
      + "gate can't tell which repository that is.");
  }
  // Check each repository it may run in: this one, and any a `cd` or `-C` on the line leads to.
  const dirs = possibleDirs(line, raw, cwd);
  if (!dirs || g.gitDir || /\bGIT_(DIR|WORK_TREE)=/.test(raw)) deny(UNCLEAR_DIRECTORY);
  for (const dir of dirs) {
    let at = dir;
    for (const opt of g.cwdOpts) at = at && opt !== undefined && !/[$`]/.test(opt) ? resolveCdPath(at, opt) : null;
    if (!at) deny(UNCLEAR_DIRECTORY);
    const repo = fs.existsSync(at) ? tryRepoInfo(at) : null;
    if (!repo) continue;
    if (["main", "master", defaultBranch(repo.root)].includes(repo.branch)) {
      deny(`Never push to the default branch: this push may run in ${repo.root}, which has ${repo.branch} checked out. `
        + "Name the issue branch, as `git push <remote> <branch>`.");
    }
    if (!named.length && tryGit(["config", "--get-regexp", "^remote\\..*\\.push$"], { cwd: repo.root })) {
      deny(`Verification gate: ${repo.root} configures a push refspec, so a push that names no branch could reach the `
        + "default branch. Name the branch, as `git push <remote> <branch>`.");
    }
  }
}

/** Refuse a pull request command on a line that changes into another repository, which the gate would not judge. */
function checkSameRepository({ line, raw, cwd, info, ctx }) {
  const dirs = possibleDirs(line, raw, cwd);
  if (!dirs) deny(UNCLEAR_DIRECTORY);
  for (const dir of dirs) {
    const repo = fs.existsSync(dir) ? tryRepoInfo(dir) : null;
    if (repo && realish(repo.root) !== realish(info.root)) {
      deny(`Verification gate: this command line changes into ${repo.root}, another repository than ${info.root}, so the `
        + `gate would judge the wrong one. Run \`cd ${repo.root}\` as a command of its own first, then this command`
        + (ctx.members ? ", or name the repository from here with `gh pr create --repo <owner>/<name> --head <branch>`." : "."));
    }
  }
}

/** The pull request commands the gate checks. Refuses a pull request write through `gh api`, which it can't check. */
function gatedCommands(commands) {
  const gated = [];
  for (const w of commands) {
    const gh = parseGh(w);
    if (!gh) continue;
    if (gh.group === "pr" && gh.sub === "create" && !hasFlag(gh.args, "--draft", "-d")) gated.push({ gh, kind: "create" });
    else if (gh.group === "pr" && gh.sub === "ready" && !hasFlag(gh.args, "--undo")) gated.push({ gh, kind: "ready" });
    else if (gh.group === "pr" && gh.sub === "edit" && hasFlag(gh.args, "--base", "-B")) gated.push({ gh, kind: "retarget" });
    else if (gh.group === "api") {
      const apiArgs = [gh.sub, ...gh.args];
      const target = apiArgs.join(" ");
      const graphqlInput = gh.sub === "graphql" && (hasFlag(gh.args, "--input")
        || gh.args.some((a, k) => ["-F", "--field"].includes(gh.args[k - 1]) && /^query=@/.test(a)) || gh.args.some((a) => /^--field=query=@/.test(a)));
      const prWrite = ghApiWrites(apiArgs) && (/\/pulls\b/.test(target) || /createPullRequest|markPullRequestReadyForReview|updatePullRequestBranch/.test(target));
      if (prWrite || graphqlInput) {
        deny("Verification gate: open, ready or retarget PRs with `gh pr create` or `gh pr ready` so the gate can check them, "
          + "not `gh api`; a GraphQL query from a file can't be checked, so pass it with -f query=… instead.");
      }
    }
  }
  return gated;
}

const hooks = {
  // Settings PreToolUse on every Bash call: protect the verdict state, never
  // push the default branch, and gate ready PRs wherever they hide in a command.
  "bash-guard"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    const stateWords = /(?:^|[\\/])(_tokens|_locks|latest\.json|verdicts\.jsonl)\b/;
    if (stateWords.test(raw) && (raw.includes("agent-runs") || stateRoots(cwd).some((root) => raw.includes(root)))) {
      deny("The verdict state (tokens, locks, latest.json, verdicts.jsonl) is written only by gate.mjs. Use `node .agents/scripts/gate.mjs show` to read it.");
    }
    const line = readCommandLine(raw);
    const pushes = line.commands.map(parseGit).filter((g) => g && g.sub === "push");
    const gated = gatedCommands(line.commands);
    if (!pushes.length && !gated.length) process.exit(0);
    const info = tryRepoInfo(cwd);
    const ctx = info ? contextOf(info) : null;
    const where = { line, raw, cwd, info, ctx };
    if (info) for (const g of pushes) checkPush(g, where);
    if (!gated.length) process.exit(0);
    if (!info) deny("Verification gate: not in a git repository, so the patch can't be checked.");
    if (/\b(GH_REPO|GIT_DIR|GIT_WORK_TREE)=/.test(raw)) {
      deny("Verification gate: GH_REPO, GIT_DIR and GIT_WORK_TREE change which repository gh acts on, so the gate can't "
        + "tell which patch to check. Run the command from the repository's own directory, or pass --repo.");
    }
    for (const { gh, kind } of gated) {
      const head = flagValue(gh.args, "--head", "-H");
      let target = info;
      if (gh.repo && !isOrigin(info.root, gh.repo)) {
        if (!ctx.members) deny(`Verification gate: --repo ${gh.repo} is not this checkout's origin, so the patch can't be checked.`);
        // In a workspace, a pull request for another repository of the issue may name it, and its branch, from here.
        if (kind !== "create") {
          deny(`Verification gate: run \`gh pr ${gh.sub}\` for ${gh.repo} from that repository's own directory, so the gate can `
            + "check the patch it covers.");
        }
        if (!head) deny(`Verification gate: --repo ${gh.repo} names another repository than this directory's. Pass --head <branch> too.`);
        target = memberForSlug(ctx, gh.repo);
        if (!target) {
          deny(`Verification gate: --repo ${gh.repo} is the origin of neither the workspace root nor a repository that `
            + "`gate.mjs workspace set` named, so the patch can't be checked.");
        }
      } else {
        checkSameRepository(where);
      }
      // A pull request named by its URL, as the command's selector, may live in another repository than the one the gate
      // judges. URLs in flag values, such as a companion link in --body, don't count.
      for (const arg of positionalArgs(gh.args, GH_VALUE_FLAGS)) {
        const url = /github\.com[/:]([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(arg);
        if (url && !isOrigin(target.root, url[1])) {
          deny(`Verification gate: ${arg} belongs to another repository than this directory's. Run it from that repository's own directory.`);
        }
      }
      if (head && head.split(":").pop() !== target.branch) {
        deny(`Verification gate: run this from the branch being proposed (--head ${head}, but HEAD is ${target.branch}).`);
      }
      try {
        const r = judge(target, { committed: true });
        if (!r.ok) {
          deny(
            `Verification gate: ${r.reason} A ready-for-review PR needs a PASS or PASS+NOTES verdict from a fresh verifier for the ` +
              `exact committed patch (check: node .agents/scripts/gate.mjs check --committed). Open it with --draft if you only need CI.`,
          );
        }
        const p = pushedMatchesHead(target);
        if (!p.ok) deny(`Verification gate: ${p.reason}`);
      } catch (e) {
        deny(`Verification gate could not evaluate the patch: ${e.message}`);
      }
    }
    process.exit(0);
  },

  // Settings SubagentStart, matcher ^verifier$: lock, and snapshot the patch.
  "verifier-start"(input, cwd) {
    let ctx = null;
    try {
      ctx = gateContext(cwd);
      const fp = contextFingerprint(ctx);
      fs.writeFileSync(
        lockFile(ctx.info, input.agent_id),
        JSON.stringify({
          agent_id: input.agent_id ?? null, branch: ctx.info.branch, fingerprint: fp.fingerprint,
          repos: fp.repos ? fp.repos.map(({ path: rel, branch }) => ({ path: rel, branch })) : null, started: new Date().toISOString(),
        }),
      );
    } catch (e) {
      // In a repository, record why the patch couldn't be taken, such as a workspace member that is gone, so `record`
      // reports the cause instead of a missing session. Outside one there is nothing to lock.
      // The lock goes where `record` and verifier-stop look: the workspace's state when cwd is in a member.
      const info = ctx?.info ?? tryRepoInfo(cwd);
      if (info) {
        fs.writeFileSync(lockFile(info, input.agent_id),
          JSON.stringify({ agent_id: input.agent_id ?? null, error: e.message, started: new Date().toISOString() }));
        process.stdout.write(`Verification gate: the patch could not be taken at the start of verification: ${e.message}\n`);
      }
    }
    process.exit(0);
  },

  // Settings SubagentStop, matcher ^verifier$: no finishing without a verdict.
  "verifier-stop"(input, cwd) {
    let info;
    try {
      info = gateContext(cwd).info;
    } catch {
      process.exit(0);
    }
    const file = lockFile(info, input.agent_id);
    const lock = readJson(file);
    const release = () => {
      fs.rmSync(file, { force: true });
      process.exit(0);
    };
    if (input.stop_hook_active === true) release(); // already reminded once; never loop
    if (lock?.error) release(); // no verdict can be recorded; the verifier reports the cause as BLOCKED
    const v = latestVerdict(info);
    const started = lock ? Date.parse(lock.started) : 0;
    if (v && (!started || Date.parse(v.recorded_at) >= started)) release();
    process.stderr.write(
      "Before you finish, write your record and run: node .agents/scripts/gate.mjs record --verdict <PASS|PASS+NOTES|FAIL|BLOCKED> " +
        "--blocking <n> --issue <url> --report <file>. Use BLOCKED with the exact blocker when you could not verify.\n",
    );
    process.exit(2);
  },

  // Verifier frontmatter PreToolUse on Bash: mint a one-use token for its own
  // `gate.mjs record` call. Frontmatter hooks run only while that subagent is
  // active, so no other agent can obtain a token.
  "authorize-record"(input, cwd) {
    const commands = splitCommands(String(input?.tool_input?.command ?? ""));
    const records = commands.filter((w) => w.some((t) => /gate\.mjs$/.test(t)) && w.includes("record"));
    if (!records.length) process.exit(0);
    if (commands.length > 1) deny("Run `gate.mjs record` as a command of its own, not combined with others.");
    try {
      const { info } = gateContext(cwd);
      fs.writeFileSync(
        path.join(stateDir(info, "tokens"), `record-${safeId(input.agent_id)}.json`),
        JSON.stringify({ agent_id: input.agent_id ?? null, issued: new Date().toISOString() }),
      );
    } catch {
      // Not a repository: record will fail on its own.
    }
    process.exit(0);
  },

  // Verifier/reviewer frontmatter PreToolUse on Bash: observe, never change.
  "observe-only"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    // The checkout is the repository, and in a workspace every member too: they all sit under the workspace root.
    const roots = [];
    const info = tryRepoInfo(cwd);
    if (info) {
      roots.push(info.root);
      const ctx = contextOf(info);
      if (ctx.members) roots.push(ctx.info.root);
    }
    const realRoots = roots.map((r) => realish(r));
    for (const w of splitCommands(raw)) {
      const g = parseGit(w);
      if (g && g.sub) {
        // Commands pointed at a throwaway worktree outside the checkout are fine, but
        // only when every path git is pointed at (-C, --git-dir, --work-tree, GIT_DIR) is outside.
        const isOutside = (p) => {
          const real = realish(path.resolve(cwd, p));
          return realRoots.length > 0 && realRoots.every((r) => real !== r && !real.startsWith(r + path.sep));
        };
        const outside = g.targets.length > 0 && g.targets.every(isOutside) && !/\bGIT_(DIR|WORK_TREE|INDEX_FILE)=/.test(raw);
        const worktreeRemovable = g.sub === "worktree" && g.args[0] === "remove"
          && g.args.slice(1).filter((arg) => !arg.startsWith("-")).every((p) => {
            const real = realish(path.resolve(cwd, p));
            const tmp = realish(os.tmpdir());
            return real.startsWith(tmp + path.sep) && isOutside(p);
          });
        const readOnlyForm =
          (g.sub === "stash" && ["list", "show"].includes(g.args[0])) ||
          (g.sub === "tag" && (g.args.length === 0 || hasFlag(g.args, "-l", "--list", "-n", "--contains", "--points-at"))) ||
          (g.sub === "branch" && !hasFlag(g.args, "-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "-u", "--unset-upstream")) ||
          (g.sub === "worktree" && (g.args[0] === "list" || (g.args[0] === "add" && hasFlag(g.args, "--detach")) || worktreeRemovable)) ||
          (g.sub === "remote" && (g.args.length === 0 || ["-v", "show", "get-url"].includes(g.args[0])));
        const writes = [
          "commit", "push", "checkout", "switch", "reset", "stash", "clean", "rebase", "merge", "cherry-pick", "am", "apply",
          "restore", "rm", "mv", "tag", "revert", "update-ref", "filter-branch", "branch", "notes", "pull", "remote", "worktree",
          "submodule", "config", "gc", "prune", "replace", "symbolic-ref", "update-index", "add",
        ];
        if (writes.includes(g.sub) && !readOnlyForm && !(outside && !["push", "update-ref", "config"].includes(g.sub))) {
          deny(
            `Observe only: \`git ${g.sub}\` changes the checkout, history or config. To inspect the base, use ` +
              "`git worktree add --detach <temp-dir> <base>` and run commands there with `git -C <temp-dir>`.",
          );
        }
      }
      const gh = parseGh(w);
      if (gh) {
        const ghWrites = {
          pr: ["create", "edit", "comment", "close", "reopen", "merge", "ready", "review", "checkout", "lock", "unlock", "update-branch", "revert"],
          issue: ["create", "edit", "comment", "close", "reopen", "delete", "transfer", "pin", "unpin", "lock", "unlock", "develop"],
          release: ["create", "edit", "delete", "upload", "delete-asset"],
          project: ["create", "edit", "delete", "item-add", "item-edit", "item-delete", "item-archive", "field-create", "field-delete", "link", "unlink", "copy", "close", "mark-template"],
          label: ["create", "edit", "delete", "clone"],
          repo: ["create", "edit", "delete", "fork", "rename", "archive", "sync", "clone"],
          workflow: ["run", "enable", "disable"],
          run: ["rerun", "cancel", "delete"],
          secret: ["set", "delete"],
          variable: ["set", "delete"],
        };
        if ((ghWrites[gh.group] ?? []).includes(gh.sub) || (gh.group === "api" && ghApiWrites([gh.sub, ...gh.args]))) {
          deny(`Observe only: \`gh ${gh.group} ${gh.sub}\` writes to GitHub or changes the checkout. Report back instead.`);
        }
      }
    }
    process.exit(0);
  },

  // Frontmatter PreToolUse on Edit|Write|NotebookEdit: writes only to the run
  // directory, the system temp directory, and agent memory.
  "write-scope"(input, cwd) {
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!target) process.exit(0);
    const abs = realish(path.resolve(cwd, String(target)));
    const within = (dir) => {
      const real = realish(dir);
      return abs === real || abs.startsWith(real + path.sep);
    };
    try {
      const info = repoInfo(cwd);
      // The run directories: this repository's, and its workspace's when it is a member.
      const roots = stateRoots(cwd);
      if (isGateState(roots, abs)) deny("The verdict state is written only by gate.mjs.");
      const inRepo = [...roots, path.join(info.root, ".claude", "agent-memory-local"), path.join(info.root, ".claude", "agent-memory")];
      if (inRepo.some(within)) process.exit(0);
      if (within(info.root)) {
        deny(`This agent never edits the checkout. Write only under the run directory (node .agents/scripts/gate.mjs paths) or its memory; ${abs} is in the working tree.`);
      }
    } catch {
      // Not a repository: only temp is allowed.
    }
    if (within(os.tmpdir())) process.exit(0);
    deny(
      `This agent writes only under the run directory (node .agents/scripts/gate.mjs paths), the temp directory, or its memory. ` +
        `${abs} is outside them.`,
    );
  },

  // Settings PreToolUse on Edit|Write|NotebookEdit: no agent writes the verdict state.
  "state-guard"(input, cwd) {
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!target) process.exit(0);
    try {
      const file = path.resolve(cwd, String(target));
      if (underRuns(file) && isGateState(stateRoots(cwd), file)) deny("The verdict state is written only by gate.mjs.");
    } catch {
      // Not a repository: nothing to protect.
    }
    process.exit(0);
  },

  // Frontmatter PreToolUse on Agent: spawn only the listed subagent types.
  "agent-scope"(input, _cwd, allowedTypes) {
    const type = input?.tool_input?.subagent_type ?? "general-purpose";
    if (allowedTypes.includes(type)) process.exit(0);
    deny(`This agent may only spawn: ${allowedTypes.join(", ")}. Requested: ${type}.`);
  },
};

/** The --repo option of a gate command, as a path from the workspace root, or null; a bare --repo is an error. */
function repoFlag(f) {
  if (f.repo === true) throw new Error("--repo needs a path from the workspace root, such as --repo <path>.");
  return typeof f.repo === "string" ? toPosix(f.repo) : null;
}

// ---------------------------------------------------------------- commands

const commands = {
  fingerprint(argv) {
    const f = parseFlags(argv);
    const committed = Boolean(f.committed);
    const rel = repoFlag(f);
    if (rel !== null) {
      const info = memberRepo(gateContext().info, rel);
      const { base: b, fingerprint: fp } = fingerprint(info, { committed });
      return console.log(JSON.stringify({ path: rel, branch: info.branch, base: b, fingerprint: fp }));
    }
    const ctx = gateContext();
    const { base: b, fingerprint: fp, repos } = contextFingerprint(ctx, { committed });
    console.log(JSON.stringify(repos ? { branch: ctx.info.branch, fingerprint: fp, repos } : { branch: ctx.info.branch, base: b, fingerprint: fp }));
  },

  // The patch of one repository: the one you are in, or a workspace member with --repo.
  diff(argv) {
    const f = parseFlags(argv);
    const rel = repoFlag(f);
    const info = rel !== null ? memberRepo(gateContext().info, rel) : repoInfo();
    process.stdout.write(patchText(info, { committed: Boolean(f.committed), binary: false, excludes: f.exclude ?? [] }).text);
  },

  paths() {
    const ctx = gateContext();
    const { info } = ctx;
    const baseOf = (repo) => {
      try {
        return resolveBase(repo);
      } catch {
        return null;
      }
    };
    const out = { root: info.root, branch: info.branch, base: ctx.members ? baseOf(info) : resolveBase(info), runDir: runDir(info) };
    if (ctx.members) {
      out.members = ctx.members.map((rel) => {
        const m = memberRepo(info, rel);
        return { path: rel, root: m.root, branch: m.branch, base: baseOf(m) };
      });
    }
    console.log(JSON.stringify(out, null, 2));
  },

  "set-base"(argv) {
    const f = parseFlags(argv);
    const rel = repoFlag(f);
    const info = rel !== null ? memberRepo(gateContext().info, rel) : repoInfo();
    if (info.detached) throw new Error("HEAD is detached; switch to the issue branch first.");
    const sha = git(["rev-parse", "--verify", `${f._[0]}^{commit}`], { cwd: info.root });
    git(["config", `branch.${info.branch}.agentbase`, sha], { cwd: info.root });
    console.log(JSON.stringify({ ...(rel !== null ? { path: rel } : {}), branch: info.branch, base: sha }));
  },

  // Run from the workspace root: name the repositories the issue changes.
  workspace(argv) {
    const [action, ...paths] = argv;
    const { info } = gateContext();
    const file = path.join(runDir(info), WORKSPACE_FILE);
    if (action === "set") {
      if (!paths.length) throw new Error("Name each repository the issue changes, as a path from the workspace root.");
      const members = [...new Set(paths.map((p) => toPosix(path.normalize(p)).replace(/\/+$/, "") || "."))];
      for (const rel of members) {
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${rel} is outside the workspace root.`);
        memberRepo(info, rel);
      }
      fs.writeFileSync(file, JSON.stringify({ members, set_at: new Date().toISOString() }, null, 2) + "\n");
    } else if (action === "clear") {
      fs.rmSync(file, { force: true });
    } else if (action !== "show") {
      throw new Error("Usage: gate.mjs workspace <set <path>...|show|clear>, run from the workspace root.");
    }
    const members = (workspaceMembers(info) ?? []).map((rel) => {
      const m = memberRepo(info, rel);
      return { path: rel, root: m.root, branch: m.branch };
    });
    console.log(JSON.stringify({ root: info.root, branch: info.branch, members }, null, 2));
  },

  record(argv) {
    const f = parseFlags(argv);
    const ctx = gateContext();
    const { info } = ctx;
    // The token proves the call came from the verifier (see authorize-record).
    const tokens = stateDir(info, "tokens");
    const now = Date.now();
    const token = fs
      .readdirSync(tokens)
      .map((name) => ({ file: path.join(tokens, name), data: readJson(path.join(tokens, name)) }))
      .find((t) => t.data && now - Date.parse(t.data.issued) < TOKEN_MAX_AGE_MS);
    if (!token) {
      console.error("Refused: only the verifier subagent may record a verdict.");
      process.exit(1);
    }
    fs.rmSync(token.file, { force: true });
    const lock = readJson(lockFile(info, token.data.agent_id));
    if (lock?.error) {
      console.error(`Refused: the gate could not take the patch when verification started: ${lock.error} Report BLOCKED with this cause.`);
      process.exit(1);
    }
    if (!lock || now - Date.parse(lock.started) > LOCK_MAX_AGE_MS) {
      console.error("Refused: no live verifier session for this agent.");
      process.exit(1);
    }
    const verdict = String(f.verdict ?? "").toUpperCase();
    if (!VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${VERDICTS.join(", ")}`);
    const blocking = Number(f.blocking);
    if (!Number.isInteger(blocking) || blocking < 0) throw new Error("--blocking must be the count of Fail criteria plus open P0-P2 findings.");
    if (PASSING.has(verdict) && blocking > 0) throw new Error(`${verdict} with ${blocking} blocking finding(s) is contradictory. Record FAIL.`);
    if (!f.report || !fs.existsSync(String(f.report))) throw new Error("--report must point to the written verification record.");
    const fp = contextFingerprint(ctx);
    if (lock.branch !== info.branch) throw new Error(`Verification started on ${lock.branch}, but HEAD is now ${info.branch}.`);
    for (const started of lock.repos ?? []) {
      const current = fp.repos?.find((r) => r.path === started.path);
      if (current && current.branch !== started.branch) {
        throw new Error(`Verification started with ${started.path} on ${started.branch}, but it is now on ${current.branch}.`);
      }
    }
    if (PASSING.has(verdict) && fp.fingerprint !== lock.fingerprint) {
      throw new Error(
        "The patch changed while you were verifying (an edit, or untracked files a build or the harness created; see `git status`). " +
          "Your evidence covers the earlier patch. Record FAIL or BLOCKED naming the files, or ask for them to be ignored and re-verify.",
      );
    }
    const entry = {
      branch: info.branch,
      issue: f.issue ?? null,
      base: fp.base,
      fingerprint: lock.fingerprint,
      head: tryGit(["rev-parse", "HEAD"], { cwd: info.root }),
      verdict,
      blocking,
      report: path.resolve(String(f.report)),
      verifier: token.data.agent_id,
      recorded_at: new Date().toISOString(),
    };
    if (fp.repos) {
      entry.repos = fp.repos.map((r) => ({ ...r, head: tryGit(["rev-parse", "HEAD"], { cwd: memberDir(info, r.path) }) }));
    }
    const dir = runDir(info);
    fs.appendFileSync(path.join(dir, "verdicts.jsonl"), JSON.stringify(entry) + "\n");
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(entry, null, 2) + "\n");
    console.log(JSON.stringify(entry, null, 2));
  },

  show() {
    const ctx = gateContext();
    const { info } = ctx;
    const v = latestVerdict(info);
    if (!v) return console.log(JSON.stringify({ branch: info.branch, verdict: null }));
    const current = contextFingerprint(ctx).fingerprint;
    console.log(JSON.stringify({ ...v, matches_worktree: v.fingerprint === current, current_fingerprint: current }, null, 2));
  },

  check(argv) {
    const committed = Boolean(parseFlags(argv).committed);
    const ctx = gateContext();
    const r = ctx.members ? evaluateWorkspace(ctx, { committed }) : evaluate(ctx.info, { committed });
    console.log(r.reason);
    process.exit(r.ok ? 0 : 1);
  },

  hook(argv) {
    const [which, ...rest] = argv;
    if (!hooks[which]) throw new Error(`Unknown hook: ${which}`);
    const input = readStdinJson();
    const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
    hooks[which](input, cwd, rest);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error("Usage: gate.mjs <fingerprint|diff|paths|set-base|workspace|record|show|check|hook> [...]");
  process.exit(1);
}
try {
  commands[cmd](rest);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
