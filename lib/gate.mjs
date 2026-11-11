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
// A verifier in any tool records its verdict through a round: the lead opens
// one before it starts the verifier and puts its key in the verifier's brief.
// The team's `verifier` agent in Claude Code can also record through its hooks.
// `publish` then posts the verdict to GitHub as a commit status on the exact
// pushed commit, which a repository can require before a pull request merges.
//
// Two things hold a session to this. The bash-guard hook reads the text of each
// shell command before it runs. Text can't tell which directory a command ends
// up in or what a variable holds, so a session-start hook also puts wrappers
// named git and gh first on PATH. They see the real arguments and directory:
// Git itself reports the branches a push updates, and a pull request command is
// judged in the repository it runs in.
//
// Commands:
//   gate.mjs fingerprint [--committed] [--repo <path>]   fingerprint of base..worktree (or base..HEAD);
//                                        in a workspace, of every member, or of one with --repo
//   gate.mjs diff [--committed] [--repo <path>] [--exclude <glob>]...   the exact patch of one repository,
//                                        without the files each glob matches in any case
//   gate.mjs paths                       JSON: repo root, branch, base, run directory, and workspace members
//   gate.mjs set-base <commit> [--repo <path>]   record the branch's base (from start-issue)
//   gate.mjs workspace set <path>... | show | clear   name the repositories an issue changes, from the workspace root
//   gate.mjs round open                  start a verification round: take the patch and print a one-time key
//   gate.mjs record --verdict V --blocking N --issue URL --report PATH [--key K --verifier MODEL]   (verifier only)
//   gate.mjs publish [--base <branch>] [--repo <path>]   post the passing verdict to GitHub as the agent-fleet/verdict
//                                        status of the pushed commit
//   gate.mjs show                        latest verdict and whether it still matches
//   gate.mjs check [--committed]         exit 0 when the gate passes, 1 otherwise
//   gate.mjs hook bash-guard             PreToolUse (Bash) in settings.json: ready PRs, verdict state, default branch
//   gate.mjs hook state-guard            PreToolUse (Edit|Write|NotebookEdit) in settings.json
//   gate.mjs hook session-env            SessionStart in settings.json: the git and gh wrappers, first on PATH
//   gate.mjs hook verifier-start         SubagentStart, matcher ^verifier$
//   gate.mjs hook verifier-stop          SubagentStop, matcher ^verifier$
//   gate.mjs hook observe-only           PreToolUse (Bash) in verifier/reviewer frontmatter
//   gate.mjs hook authorize-record       PreToolUse (Bash) in verifier frontmatter
//   gate.mjs hook write-scope            PreToolUse (Edit|Write|NotebookEdit) in frontmatter
//   gate.mjs hook agent-scope <types..>  PreToolUse (Agent) in frontmatter
//   gate.mjs shim <git|gh|pre-push> ...  what the wrappers run; never run by hand
//
// Node.js 20+, standard library only. State lives in <git-common-dir>/agent-runs/
// (shared by every worktree, never tracked), or in $AGENT_RUNS_DIR when set.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERDICTS = ["PASS", "PASS+NOTES", "FAIL", "BLOCKED"];
const PASSING = new Set(["PASS", "PASS+NOTES"]);
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOKEN_MAX_AGE_MS = 60 * 1000;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GATE_FILE = fileURLToPath(import.meta.url);
// The wrappers this gate puts on PATH sit in a directory of this name. The gate's own git calls must reach the real
// git, so that directory leaves PATH here, and a wrapped command gets the session's PATH back.
const SHIMS_NAME = "agent-fleet-shims";
const SESSION_PATH = process.env.PATH ?? "";
process.env.PATH = SESSION_PATH.split(path.delimiter).filter((dir) => path.basename(dir) !== SHIMS_NAME).join(path.delimiter);
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

function patchText(info, { committed = false, binary = true, excludes = [], base: from = null } = {}) {
  const base = from ?? resolveBase(info);
  const target = committed ? git(["rev-parse", "HEAD"], { cwd: info.root }) : worktreeTree(info.root);
  const args = ["diff", "--no-color", "--no-ext-diff", ...(binary ? ["--binary"] : []), base, target, "--", ".", ...MEMORY_EXCLUDES];
  // An excluded path matches in any case, so a protected file named in another case than on disk still stays out.
  for (const e of excludes) args.push(`:(exclude,glob,icase)${e}`);
  return { base, text: execFileSync("git", args, { cwd: info.root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }) };
}

function fingerprint(info, { committed = false, base: from = null } = {}) {
  const { base, text } = patchText(info, { committed, base: from });
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

// ---------------------------------------------------------------- shell parsing
//
// Best-effort tokenizer: splits a Bash command into simple commands on ; & | &&
// || and newlines, respecting quotes, and also yields the contents of $(...)
// and backticks as commands of their own. Good enough for guardrails, not a
// sandbox.

function splitCommands(src) {
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
    if (c === "\\" && i + 1 < src.length) {
      tok += src[++i];
      inTok = true;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      tok += src.slice(i + 1, end === -1 ? src.length : end);
      inTok = true;
      i = end === -1 ? src.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) s += src[++j];
        else s += src[j];
        j++;
      }
      for (const inner of extractSubstitutions(s)) out.push(...splitCommands(inner));
      tok += s;
      inTok = true;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      }
      out.push(...splitCommands(src.slice(i + 2, j - 1)));
      tok += "$SUBST";
      inTok = true;
      i = j - 1;
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      out.push(...splitCommands(src.slice(i + 1, end === -1 ? src.length : end)));
      i = end === -1 ? src.length : end;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      pushCmd();
    } else if (/\s/.test(c)) {
      pushTok();
    } else {
      tok += c;
      inTok = true;
    }
  }
  pushCmd();
  // Drop leading VAR=value assignments and common wrappers, and split the
  // script a shell runs with -c, such as `bash -c "gh pr ready"`.
  const commands = out
    .map((words) => {
      let w = words.slice();
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
      while (w.length && ["env", "command", "exec", "time", "nohup", "sudo", "xargs"].includes(w[0])) w.shift();
      return w;
    })
    .filter((w) => w.length);
  const nested = [];
  for (const w of commands) {
    if (!SHELLS.has(path.basename(w[0]))) continue;
    const flag = w.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag !== -1 && w[flag + 1] !== undefined) nested.push(...splitCommands(w[flag + 1]));
  }
  return [...commands, ...nested];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

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

const base = (w) => path.basename(w);

// git [global options] <sub> [args]  →  { sub, args, cwdOpt, targets }
// targets are the paths the options point git at: -C, --git-dir, --work-tree.
function parseGit(words) {
  if (base(words[0]) !== "git") return null;
  let i = 1;
  let cwdOpt = null;
  const targets = [];
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(w);
    if (eq) {
      targets.push(eq[2]);
      i += 1;
    } else if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--exec-path") {
      if (w === "-C") cwdOpt = words[i + 1];
      if (w === "-C" || w === "--git-dir" || w === "--work-tree") targets.push(words[i + 1]);
      i += 2;
    } else i += 1;
  }
  return { sub: words[i], args: words.slice(i + 1), cwdOpt, targets };
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
  return { group: words[i], sub: words[i + 1], args: words.slice(i + 2), repo };
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

// ---------------------------------------------------------------- wrappers
//
// Reading shell text can't tell which directory a command ends up in, what a
// variable holds, or what a script or an alias runs. The wrappers don't read
// text. By the time one runs, the shell has done its work, so it sees the real
// arguments, directory and environment. They live in the gate's state, a
// session-start hook puts them first on PATH, and each hands the few commands
// that matter to `gate.mjs shim` and every other one straight to the real tool.

const HOOKS_NAME = "agent-fleet-hooks";
// The hooks Git runs on the pushing side. For a push the gate points Git's hooks path at its own directory, where
// pre-push goes through the gate first and each of these passes on to the repository's own hook. Two hooks are left
// out, reference-transaction and post-index-change: Git runs them for every ref or index it writes, and passing each
// call on made a push of a few hundred refs take seconds. A repository's own hooks of those two names don't run
// under a wrapped command.
const CLIENT_HOOKS = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push",
  "pre-auto-gc", "post-rewrite", "sendemail-validate"];
// Git's built-in commands neither push nor stand for an alias, because Git never lets an alias replace one, except
// for these. The wrapper takes the list from Git itself at session start; this one is for a Git that can't give it.
const GIT_NOT_PLAIN = new Set(["push", "send-pack", "submodule", "submodule--helper"]);
const GIT_PLAIN_FALLBACK = ["add", "am", "apply", "bisect", "blame", "branch", "cat-file", "check-ignore", "checkout", "cherry-pick",
  "clean", "clone", "commit", "config", "describe", "diff", "diff-tree", "fetch", "for-each-ref", "grep", "hash-object", "help",
  "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "patch-id", "pull", "read-tree", "rebase",
  "reflog", "remote", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "show", "show-ref", "stash", "status",
  "switch", "symbolic-ref", "tag", "update-index", "update-ref", "var", "version", "worktree", "write-tree"];
// gh commands that open, ready or retarget no pull request. gh never lets an alias or an extension replace one.
const GH_PLAIN = ["alias", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "extension", "gist",
  "gpg-key", "help", "issue", "label", "org", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key",
  "status", "variable", "workflow", "pr checkout", "pr checks", "pr close", "pr comment", "pr diff", "pr list", "pr lock",
  "pr merge", "pr reopen", "pr review", "pr status", "pr unlock", "pr update-branch", "pr view"];
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** A path with forward slashes, which Git, Node and a POSIX shell all take, on Windows too. */
const slashPath = (p) => p.split(path.sep).join("/");
/** A path the way a POSIX shell's PATH names it: on Windows, Git Bash's form, such as /c/Users/me. */
const shellPath = (p) => (process.platform === "win32" ? slashPath(p).replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`) : p);
/** Words of an alias's expansion, with its quotes taken off. */
const splitWords = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));

/** Where a checkout's wrappers live: in the gate's state, one folder per copy of this script. */
function wrappersHome(info) {
  return path.join(runsRoot(info), "_shims", crypto.createHash("sha256").update(GATE_FILE).digest("hex").slice(0, 10));
}

// The wrappers run a copy of this script kept beside them, so they keep working when the checkout's own copy is
// gone, as after switching to a commit from before the installation.
const runnerFile = (home) => path.join(home, "gate.mjs");

const sessionFile = (info, sessionId) => path.join(runsRoot(info), "_sessions", safeId(sessionId));

/** Whether the session-start hook put the wrappers on PATH for the session a hook runs in. */
function sessionHasWrappers(input, infos) {
  return Boolean(input?.session_id) && infos.some((info) => fs.existsSync(sessionFile(info, input.session_id)));
}

function writeExecutable(file, text) {
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // Not written yet.
  }
  if (current === text) return;
  // Written beside the file, made executable, and only then renamed into place, so a command that starts meanwhile
  // never finds half a script or one it can't run.
  const draft = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(draft, text, { mode: 0o755 });
  fs.chmodSync(draft, 0o755);
  fs.renameSync(draft, file);
}

/** The wrapper for git or gh: a shell script that sends `plain` commands straight to the real tool, and the rest to the gate. */
function wrapperScript(tool, plain, home) {
  const subcommand = tool === "git"
    ? [
      "sub=",
      "skip=",
      'for arg in "$@"; do',
      '  if [ -n "$skip" ]; then skip=; continue; fi',
      '  case "$arg" in',
      `    ${[...GIT_VALUE_OPTIONS].join("|")}) skip=1 ;;`,
      "    -*) ;;",
      "    *) sub=$arg; break ;;",
      "  esac",
      "done",
    ]
    : ["sub=$1", '[ "$sub" = pr ] && sub="pr $2"'];
  return [
    "#!/bin/sh",
    "# Written by agent-fleet's verification gate at session start; changes are overwritten.",
    `# Sends a ${tool} command that may ${tool === "git" ? "push" : "open or ready a pull request"} to the gate, and every other one straight to ${tool}.`,
    ...subcommand,
    'case "$sub" in',
    `  ''|${plain.map((name) => (name.includes(" ") ? `"${name}"` : name)).join("|")})`,
    "    set -f; clean=; IFS=:",
    // Every wrappers directory is left out, not only this one: with two sessions' on PATH, each would find the other.
    `    for dir in $PATH; do case "$dir" in */${SHIMS_NAME}|*/${SHIMS_NAME}/) ;; *) clean="\${clean:+$clean:}$dir" ;; esac; done`,
    "    unset IFS; set +f",
    `    real=$(PATH=$clean; command -v ${tool}) || { echo "agent-fleet gate: ${tool} is not on PATH" >&2; exit 127; }`,
    '    exec "$real" "$@" ;;',
    "esac",
    `exec ${shQuote(slashPath(process.execPath))} ${shQuote(slashPath(runnerFile(home)))} shim ${tool} ${shQuote(slashPath(home))} "$@"`,
    "",
  ].join("\n");
}

/** Write the gate's hooks directory: pre-push goes through the gate, and every other hook passes on to the repository's own. */
function writeHooks(home) {
  const hooksDir = path.join(home, HOOKS_NAME);
  fs.mkdirSync(hooksDir, { recursive: true });
  const header = ["#!/bin/sh", "# Written by agent-fleet's verification gate; changes are overwritten."];
  const passOn = [
    ...header,
    "# Passes on to the repository's own hook, which this directory stands in front of while the gate checks a push.",
    `mirror=${shQuote(slashPath(hooksDir))}`,
    "name=${0##*/}",
    'dir=$(git config --type=path --get-all core.hooksPath 2>/dev/null | grep -vxF "$mirror" | tail -n 1)',
    '[ -n "$dir" ] || dir=$(git rev-parse --git-common-dir)/hooks',
    '[ -x "$dir/$name" ] || exit 0',
    'exec "$dir/$name" "$@"',
    "",
  ].join("\n");
  for (const name of CLIENT_HOOKS) {
    const text = name === "pre-push"
      ? [...header, `exec ${shQuote(slashPath(process.execPath))} ${shQuote(slashPath(runnerFile(home)))} shim pre-push ${shQuote(slashPath(home))} "$@"`, ""].join("\n")
      : passOn;
    writeExecutable(path.join(hooksDir, name), text);
  }
  // Nothing else belongs here: a tool that installs hooks into the hooks path may have written its own.
  for (const name of fs.readdirSync(hooksDir)) {
    if (!CLIENT_HOOKS.includes(name)) fs.rmSync(path.join(hooksDir, name), { recursive: true, force: true });
  }
}

/** Write a checkout's wrappers and hooks, and return the directory that goes on PATH. */
function writeWrappers(info) {
  const home = wrappersHome(info);
  const shims = path.join(home, SHIMS_NAME);
  fs.mkdirSync(shims, { recursive: true });
  writeExecutable(runnerFile(home), fs.readFileSync(GATE_FILE, "utf8"));
  // Wrappers of checkouts that started no session for a long time, such as removed worktrees.
  const now = new Date();
  fs.utimesSync(home, now, now);
  for (const name of fs.readdirSync(path.dirname(home))) {
    const other = path.join(path.dirname(home), name);
    if (other !== home && now - fs.statSync(other).mtimeMs > SESSION_MAX_AGE_MS) fs.rmSync(other, { recursive: true, force: true });
  }
  const builtins = (tryGit(["--list-cmds=builtins"]) ?? "").split(/\s+/).filter((name) => /^[a-z0-9-]+$/.test(name));
  const plain = (builtins.length ? builtins : GIT_PLAIN_FALLBACK).filter((name) => !GIT_NOT_PLAIN.has(name));
  writeExecutable(path.join(shims, "git"), wrapperScript("git", plain, home));
  writeExecutable(path.join(shims, "gh"), wrapperScript("gh", GH_PLAIN, home));
  writeHooks(home);
  return shims;
}

/** An environment in which Git looks for its hooks in the gate's directory, in this command and in every git it starts. */
function withGateHooks(env, home) {
  const count = Number(env.GIT_CONFIG_COUNT || 0);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: slashPath(path.join(home, HOOKS_NAME)),
  };
}

/** The same environment without the gate's hooks path, for the repository's own hook and everything it runs. */
function withoutGateHooks(env) {
  const out = { ...env };
  const kept = [];
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT || 0); i++) {
    const key = out[`GIT_CONFIG_KEY_${i}`];
    const value = out[`GIT_CONFIG_VALUE_${i}`];
    delete out[`GIT_CONFIG_KEY_${i}`];
    delete out[`GIT_CONFIG_VALUE_${i}`];
    if (!(String(key).toLowerCase() === "core.hookspath" && path.basename(String(value)) === HOOKS_NAME)) kept.push([key, value]);
  }
  kept.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  if (kept.length) out.GIT_CONFIG_COUNT = String(kept.length);
  else delete out.GIT_CONFIG_COUNT;
  return out;
}

/** The real program behind a wrapper: the first one on PATH outside the wrappers' directory. */
function realBinary(name) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of process.env.PATH.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

function refuse(reason) {
  process.stderr.write(`Verification gate: ${reason}\n`);
  process.exit(1);
}

/**
 * Run the real tool in place of the wrapper, with the session's PATH, wrappers included, so whatever it starts meets
 * them too. The wrapper ends as the tool ends: with its exit status, or by its signal, and a signal sent to the
 * wrapper goes on to the tool.
 */
function runReal(name, args, env = process.env, input = null) {
  const file = realBinary(name);
  if (!file) {
    process.stderr.write(`agent-fleet gate: ${name} is not on PATH.\n`);
    process.exit(127);
  }
  const child = spawn(file, args, { stdio: [input === null ? "inherit" : "pipe", "inherit", "inherit"], env: { ...env, PATH: SESSION_PATH } });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, () => child.kill(signal));
  child.on("error", (e) => {
    process.stderr.write(`agent-fleet gate: could not run ${name}: ${e.message}\n`);
    process.exit(126);
  });
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    for (const each of signals) process.removeAllListeners(each);
    process.kill(process.pid, signal);
  });
  if (input !== null) {
    // The tool may end without reading all of it; its exit status still stands.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
}

const DEFAULT_BRANCH_PUSH = (name) => `Never push to the default branch (${name}). Push the issue branch and open a pull request.`;

/**
 * `git` as the session ran it, for every command but Git's plain built-ins. It runs with Git's hooks path pointed at
 * the gate's directory, in this command and in every git it starts, so Git itself reports the branches a push is
 * about to update to the pre-push check below. That reaches a push an alias stands for, one a shell alias, a
 * submodule command or a Git extension runs, and one Git corrects a typo into.
 */
function shimGit(argv, home) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += GIT_VALUE_OPTIONS.has(argv[i]) ? 2 : 1;
  let globals = argv.slice(0, i);
  let words = argv.slice(i);
  let shellAlias = "";
  // Ask Git what an alias stands for, with the same options, so `-C` and `-c alias.x=…` count as they will.
  for (let depth = 0; depth < 10 && words.length && !GIT_NOT_PLAIN.has(words[0]); depth++) {
    const value = tryGit([...globals, "config", "--get", `alias.${words[0]}`]);
    if (!value) break;
    if (value.startsWith("!")) {
      shellAlias = value;
      break;
    }
    const expansion = splitWords(value);
    let k = 0;
    while (k < expansion.length && expansion[k].startsWith("-")) k += GIT_VALUE_OPTIONS.has(expansion[k]) ? 2 : 1;
    // An alias may start with options of its own, such as -c.
    globals = [...globals, ...expansion.slice(0, k)];
    words = [...expansion.slice(k), ...words.slice(1)];
  }
  const [sub, ...args] = words;
  if (sub === "send-pack") refuse("`git send-pack` pushes without the check that keeps the default branch safe. Use `git push`.");
  // An alias for one of Git's plain built-ins is that built-in. Git LFS writes its hooks into the hooks path when it
  // installs, and pushes files, never a branch.
  const builtin = !shellAlias && !GIT_NOT_PLAIN.has(sub) && (tryGit(["--list-cmds=builtins"]) ?? "").split(/\s+/).includes(sub);
  if (builtin || (sub === "lfs" && !shellAlias)) return runReal("git", argv);
  const env = withGateHooks(process.env, home);
  let command = argv;
  // Git takes any unambiguous start of a long option, so `--no-verif` skips the hooks as well.
  const skipsHooks = (arg) => arg.startsWith("--no-veri") && "--no-verify".startsWith(arg);
  if (sub === "push" && args.some(skipsHooks)) {
    // The push runs without the option, so the gate's check stays, and the check then skips the repository's own hook.
    command = [...globals, "push", ...args.filter((arg) => !skipsHooks(arg))];
    env.AGENT_GATE_NO_VERIFY = "1";
  } else if ((shellAlias || sub === "submodule") && /--no-veri|hookspath/i.test([shellAlias, ...args].join(" "))) {
    // Git starts what a shell alias or `submodule foreach` runs by itself, so the wrapper can't take the option out.
    refuse("this command may run a push that skips Git's hooks, and with them the check that keeps the default branch safe. "
      + "Run the push as a command of its own.");
  }
  // A setting that outranks the environment, such as `-c` or an included file, would point Git's hooks elsewhere.
  const hooksPath = spawnSync(realBinary("git") ?? "git", [...globals, "config", "--get", "core.hooksPath"], { env, encoding: "utf8" });
  if (hooksPath.status === 1) {
    refuse("this Git ignores the setting the gate's push check relies on. The check needs Git 2.31 or later.");
  }
  // With any other failure Git can't read its config here, such as with `-C` to a missing directory, and fails the
  // command itself.
  if (hooksPath.status === 0 && path.basename(hooksPath.stdout.trim()) !== HOOKS_NAME) {
    refuse("this command sets Git's hooks path, which would skip the check that keeps the default branch safe. Run it without that setting.");
  }
  writeHooks(home);
  return runReal("git", command, env);
}

/** Whether a push URL is a directory on this machine: a scratch or mirror repository, not the hosting service. */
function isLocalPath(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false; // a URL with a scheme, file:// included
  if (/^[A-Za-z]:[\\/]/.test(url)) return true; // a Windows drive path
  const colon = url.indexOf(":");
  return colon === -1 || url.slice(0, colon).includes("/"); // anything else with a colon is host:path
}

/** Git's pre-push hook for a wrapped push: refuse the default branch, then pass on to the repository's own hook. */
function shimPrePush(args) {
  const [remote, url] = args;
  const input = fs.readFileSync(0, "utf8");
  const names = new Set(["main", "master", defaultBranch(process.cwd())]);
  const remoteHead = remote ? tryGit(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]) : null;
  if (remoteHead?.startsWith(`${remote}/`)) names.add(remoteHead.slice(remote.length + 1));
  // A test suite or a script may push `main` to a repository it made in a folder. That is not the default branch
  // this check keeps safe, so a remote given as a directory path passes.
  // Each line: <local ref> <local object> <remote ref> <remote object>.
  for (const line of url && isLocalPath(url) ? [] : input.split("\n").filter(Boolean)) {
    const branch = /^refs\/heads\/(.+)$/.exec(line.split(" ")[2] ?? "")?.[1];
    if (branch && names.has(branch)) refuse(DEFAULT_BRANCH_PUSH(branch));
  }
  // The push was asked to skip hooks: the gate's check has run, and the repository's own hook stays skipped.
  if (process.env.AGENT_GATE_NO_VERIFY) process.exit(0);
  const env = withoutGateHooks(process.env);
  let configured = null;
  try {
    configured = execFileSync("git", ["config", "--type=path", "--get-all", "core.hooksPath"], { env, encoding: "utf8" }).split("\n").filter(Boolean).at(-1);
  } catch {
    // No hooks path of the repository's own: its hooks are in its Git directory.
  }
  const own = path.join(configured ? path.resolve(configured) : path.resolve(git(["rev-parse", "--git-common-dir"]), "hooks"), "pre-push");
  try {
    fs.accessSync(own, fs.constants.X_OK);
  } catch {
    process.exit(0);
  }
  const options = { input, stdio: ["pipe", "inherit", "inherit"], env: { ...env, PATH: SESSION_PATH } };
  // Git for Windows runs hooks with its shell. Elsewhere the hook runs as the program it is, or, as Git does for a
  // hook without a `#!` line, with the shell.
  let result = process.platform === "win32" ? spawnSync("sh", [own, ...args], options) : spawnSync(own, args, options);
  // Node 20 reports the failure by its number alone, not by name.
  if (result.error && (result.error.code === "ENOEXEC" || result.error.errno === -os.constants.errno.ENOEXEC)) {
    result = spawnSync("sh", [own, ...args], options);
  }
  if (result.error) process.stderr.write(`agent-fleet gate: could not run the repository's own pre-push hook: ${result.error.message}\n`);
  process.exit(result.status ?? 1);
}

// gh options that take a value, so gh reads the next word, or the rest of the same word, as that value.
const GH_VALUE_FLAGS = new Set(["-B", "--base", "-t", "--title", "-b", "--body", "-F", "--body-file", "-H", "--head",
  "-m", "--milestone", "-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-p", "--project", "-T", "--template",
  "-R", "--repo", "--recover", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer", "--add-assignee",
  "--remove-assignee", "--add-project", "--remove-project"]);

/**
 * A `gh pr` command's options as gh reads them: its flags, the values of the options that take one, in every form
 * (`--head <v>`, `--head=<v>`, `-H <v>`, `-H<v>`), and its positional arguments. A word that is an option's value
 * never counts as a flag, so `--title --draft` gives a title, not a draft.
 */
function ghOptions(args) {
  const flags = [];
  const values = {};
  const positionals = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === "--") {
      positionals.push(...args.slice(k + 1));
      break;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!arg.startsWith("-") || arg === "-") positionals.push(arg);
    else if (GH_VALUE_FLAGS.has(name)) (values[name] ??= []).push(equals === -1 ? args[++k] : arg.slice(equals + 1));
    else if (!arg.startsWith("--") && arg.length > 2 && GH_VALUE_FLAGS.has(arg.slice(0, 2))) (values[arg.slice(0, 2)] ??= []).push(arg.slice(2).replace(/^=/, ""));
    else flags.push(arg);
  }
  const of = (...names) => names.flatMap((name) => values[name] ?? []).filter((value) => value !== undefined);
  return { flags, positionals, of };
}

// gh <group> <sub> [args] as gh itself reads its arguments  →  { group, sub, args, repos }
// repos are the repositories named before the subcommand; `ghOptions` reads the ones after it.
function ghArguments(words) {
  const repos = [];
  // The number of words a repository flag at k takes: `-R <repo>`, `--repo <repo>`, `--repo=<repo>` or `-R<repo>`.
  const repoFlag = (k) => {
    const w = words[k];
    if (w === "-R" || w === "--repo") return repos.push(words[k + 1]) && 2;
    if (w.startsWith("--repo=")) return repos.push(w.slice(7)) && 1;
    if (/^-R./.test(w)) return repos.push(w.slice(2).replace(/^=/, "")) && 1;
    return w === "--hostname" ? 2 : 1;
  };
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += repoFlag(i);
  const group = words[i];
  let j = i + 1;
  // `gh pr` also takes its flags before the subcommand, as in `gh pr -R <owner>/<name> create`.
  if (group === "pr") while (j < words.length && words[j].startsWith("-")) j += repoFlag(j);
  // `gh pr new` is gh's own alias for `gh pr create`.
  return { group, sub: group === "pr" && words[j] === "new" ? "create" : words[j], args: words.slice(j + 1), repos: repos.filter((r) => r !== undefined) };
}

/** The host and `<owner>/<name>` of a pull request URL, or null. */
function prUrl(arg) {
  const m = /^(?:https?:\/\/)?([^/\s:@]+)[/:]([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(arg);
  return m ? { host: m[1].toLowerCase(), slug: m[2] } : null;
}

/** Whether a pull request URL names a repository's origin: its owner and name, and its host when the origin has one. */
function urlIsOrigin(root, url) {
  const origin = tryGit(["remote", "get-url", "origin"], { cwd: root }) ?? "";
  const host = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)|^[^@/]+@([^:]+):/i.exec(origin);
  return isOrigin(root, url.slug) && (!host || (host[1] ?? host[2]).toLowerCase() === url.host);
}

/** A gh alias written out, as `gh alias list` gives it. A shell alias stays as it is: it runs gh by name, through the wrapper. */
function expandGhAlias(words) {
  const file = realBinary("gh");
  const listed = file ? spawnSync(file, ["alias", "list"], { encoding: "utf8" }) : null;
  if (!listed || listed.status !== 0) return words;
  for (const line of listed.stdout.split("\n")) {
    const m = /^([^\s:]+):\s*(.*)$/.exec(line);
    if (!m || m[1] !== words[0]) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (!value || value.startsWith("|") || value.startsWith(">") || value.startsWith("!")) return words;
    return [...splitWords(value), ...words.slice(1)];
  }
  return words;
}

const READY_PR_NEEDS = "A ready-for-review PR needs a PASS or PASS+NOTES verdict from a fresh verifier for the exact committed patch "
  + "(check: node .agents/scripts/gate.mjs check --committed). Open it with --draft if you only need CI.";
const USE_GH_PR = "open, ready or retarget PRs with `gh pr create` or `gh pr ready` so the gate can check them, not `gh api`; "
  + "a GraphQL query from a file can't be checked, so pass it with -f query=… instead.";
const PR_MUTATIONS = /createPullRequest|markPullRequestReadyForReview|updatePullRequestBranch/;

/** Whether the text of a `gh api` call opens, readies or retargets a pull request, or sends a GraphQL query from a file. */
function ghApiGated(sub, args) {
  const apiArgs = [sub, ...args];
  const target = apiArgs.join(" ");
  return (ghApiWrites(apiArgs) && (/\/pulls\b/.test(target) || PR_MUTATIONS.test(target))) || (sub === "graphql" && hasFlag(args, "--input"));
}

/**
 * `gh api` as the session ran it. The wrapper can read what the hook can't: the request body `--input` names and the
 * fields `-F key=@file` reads, standard input included. So a GraphQL query from a file passes unless it opens or
 * readies a pull request.
 */
function shimGhApi(argv, sub, args) {
  let stdin = null;
  const contents = (file) => {
    try {
      // Standard input is kept as bytes and handed on unchanged: it may be a file to upload.
      return (file === "-" ? (stdin ??= fs.readFileSync(0)) : fs.readFileSync(file)).toString("utf8");
    } catch {
      return ""; // gh reports a file it can't read.
    }
  };
  // The value of an option at k, in any of its forms: `--input <v>`, `--input=<v>`, `-F <v>` or `-F<v>`.
  const words = [sub, ...args].filter((word) => word !== undefined);
  const valueAt = (k, short, long) => {
    const arg = words[k];
    if (arg === short || arg === long) return words[k + 1] ?? null;
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    return short && arg.startsWith(short) && !arg.startsWith("--") && arg.length > 2 ? arg.slice(2) : null;
  };
  const read = [];
  for (let k = 0; k < words.length; k++) {
    const input = valueAt(k, null, "--input");
    if (input) read.push(contents(input));
    const fromFile = /^[^=]+=@(.+)$/.exec(valueAt(k, "-F", "--field") ?? "");
    if (fromFile) read.push(contents(fromFile[1]));
  }
  const target = words.join(" ");
  // Whether the call writes: a method other than GET, or fields or a body without -X GET, in every form gh takes.
  const methods = words.flatMap((_, k) => [valueAt(k, "-X", "--method")]).filter(Boolean).map((m) => m.toUpperCase());
  const sendsBody = words.some((_, k) => valueAt(k, "-f", "--raw-field") || valueAt(k, "-F", "--field") || valueAt(k, null, "--input"));
  const writes = methods.some((m) => m !== "GET") || (sendsBody && !methods.includes("GET"));
  // A JSON body may spell a name with escapes, such as `\/`; what GitHub reads is the decoded text.
  const decoded = read.map((text) => {
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      return text;
    }
  });
  const request = [target, ...read, ...decoded].join("\n");
  if ((writes && /\/pulls\b/.test(target)) || PR_MUTATIONS.test(request)) {
    refuse("open, ready or retarget PRs with `gh pr create` or `gh pr ready` so the gate can check them, not `gh api`.");
  }
  if (writes && /\/statuses\//.test(target) && request.includes(STATUS_CONTEXT)) {
    refuse(`the ${STATUS_CONTEXT} status is posted only by \`node .agents/scripts/gate.mjs publish\`, which checks the verdict first.`);
  }
  return runReal("gh", argv, process.env, stdin);
}

/**
 * `gh` as the session ran it. A command that opens, readies or retargets a pull request is judged in the repository
 * it runs in, or the one `--repo` or GH_REPO names, against that repository's branch, verdict and pushed commit.
 */
function shimGh(argv) {
  const gh = ghArguments(!argv[0] || argv[0].startsWith("-") || ["pr", "api"].includes(argv[0]) ? argv : expandGhAlias(argv));
  if (gh.group === "api") return shimGhApi(argv, gh.sub, gh.args);
  const options = ghOptions(gh.args);
  const kind = gh.group !== "pr" ? null
    : gh.sub === "create" && !hasFlag(options.flags, "--draft", "-d") ? "create"
      : gh.sub === "ready" && !hasFlag(options.flags, "--undo") ? "ready"
        : gh.sub === "edit" && options.of("-B", "--base").length ? "retarget" : null;
  if (!kind) return runReal("gh", argv);
  const here = tryRepoInfo(process.cwd());
  if (!here) refuse("not in a git repository, so the patch can't be checked.");
  // gh uses the last of a repeated flag, so a command naming two repositories or branches can't be judged.
  const named = [...gh.repos, ...options.of("-R", "--repo")];
  const repos = named.length ? named : [process.env.GH_REPO].filter(Boolean);
  const heads = options.of("-H", "--head");
  if (new Set(repos).size > 1 || new Set(heads).size > 1) {
    refuse("name the repository and the head branch once each, so the gate checks the one gh uses.");
  }
  const [slug] = repos;
  let target = here;
  if (slug && !isOrigin(here.root, slug)) {
    // In a workspace, a pull request for another repository of the issue may name it from here.
    const ctx = contextOf(here);
    target = ctx.members ? memberForSlug(ctx, slug) : null;
    if (!target) {
      refuse(`${slug} is neither this directory's repository nor one that \`gate.mjs workspace set\` named, `
        + "so the patch can't be checked.");
    }
  }
  const [head] = heads;
  if (head && head.split(":").pop() !== target.branch) {
    refuse(`run this from the branch being proposed (--head ${head}, but ${target.root} is on ${target.branch}).`);
  }
  const [selector] = options.positionals;
  if (kind !== "create" && selector !== undefined) {
    // The pull request may be another repository's, or another branch's than the one the verdict covers.
    const url = prUrl(selector);
    if (url && !urlIsOrigin(target.root, url)) {
      refuse(`${selector} belongs to another repository than ${target.root}. Run it from that repository's own directory.`);
    }
    let branch = selector.split(":").pop();
    if (url || /^#?\d+$/.test(selector)) {
      const view = spawnSync(realBinary("gh") ?? "gh", ["pr", "view", selector.replace(/^#/, ""), "--json", "headRefName,isCrossRepository",
        ...(slug ? ["--repo", slug] : [])], { cwd: slug ? process.cwd() : target.root, encoding: "utf8" });
      let pr = null;
      try {
        pr = view.status === 0 ? JSON.parse(view.stdout) : null;
      } catch {
        // Not JSON: treated as not found.
      }
      if (!pr?.headRefName) refuse(`could not look up pull request ${selector}, so the gate can't tell which branch it proposes.`);
      branch = pr.isCrossRepository ? `a fork's ${pr.headRefName}` : pr.headRefName;
    }
    if (branch !== target.branch) {
      refuse(`pull request ${selector} proposes ${branch}, not the branch checked out in ${target.root} (${target.branch}). `
        + "Run it from that branch.");
    }
  }
  let verdict;
  try {
    verdict = judge(target, { committed: true });
  } catch (e) {
    refuse(`the patch could not be evaluated: ${e.message}`);
  }
  if (!verdict.ok) refuse(`${verdict.reason} ${READY_PR_NEEDS}`);
  const pushed = pushedMatchesHead(target);
  if (!pushed.ok) refuse(pushed.reason);
  // A new base gives the pull request another patch, which the verdict and the commit's status must cover too.
  const [newBase] = kind === "retarget" ? options.of("-B", "--base") : [];
  if (newBase) {
    const ctx = contextOf(target);
    const v = latestVerdict(ctx.info);
    const mismatch = patchAgainst(target, newBase, ctx.members ? v.repos.find((r) => r.path === ctx.rel)?.fingerprint : v.fingerprint);
    if (mismatch) refuse(mismatch);
  }
  return runReal("gh", argv);
}

// ---------------------------------------------------------------- verification rounds
//
// A round lets a verifier in any tool, on any model, record a verdict. The lead
// opens it just before it starts the verifier: the gate takes the patch, as the
// team's verifier-start hook does, and prints a one-time key, which the lead
// puts in that verifier's brief and nowhere else. The round keeps only the
// key's digest. `record --key` then checks the patch against the one taken at
// the start, and uses the round up. Where the gate's hooks run, the agent that
// opened a round can't record it, so whoever wrote the code needs another agent
// to say it works.

const keyDigest = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
const roundFile = (info, key) => path.join(stateDir(info, "rounds"), `${keyDigest(key).slice(0, 40)}.json`);
const openerFile = (info, input) =>
  path.join(stateDir(info, "rounds"), `opener-${safeId(input.session_id)}-${safeId(input.agent_id ?? "main")}.json`);
const sameAgent = (a, b) => a.session_id === b.session_id && (a.agent_id ?? null) === (b.agent_id ?? null);

/** Open a round for the change a context covers; returns the key and what the round took. */
function openRound(ctx) {
  const { info } = ctx;
  const dir = stateDir(info, "rounds");
  const now = Date.now();
  // Who opened it, as the gate's hook saw the command a moment ago. Without the hooks, nobody knows.
  let opener = null;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const data = readJson(file);
    const age = now - Date.parse(data?.issued ?? data?.started ?? 0);
    const fresh = name.startsWith("opener-") ? age < TOKEN_MAX_AGE_MS : age < LOCK_MAX_AGE_MS;
    if (!fresh) fs.rmSync(file, { force: true });
    // Parallel issues share this directory, one checkout each, so only an opener of this checkout and branch counts.
    else if (name.startsWith("opener-") && data.root === info.root && data.branch === info.branch && (!opener || data.issued > opener.issued)) {
      opener = { ...data, file };
    }
  }
  if (opener) fs.rmSync(opener.file, { force: true });
  const fp = contextFingerprint(ctx);
  const key = crypto.randomBytes(16).toString("hex");
  const round = {
    branch: info.branch, fingerprint: fp.fingerprint, repos: fp.repos ? fp.repos.map(({ path: rel, branch }) => ({ path: rel, branch })) : null,
    started: new Date().toISOString(), opener: opener ? { session_id: opener.session_id, agent_id: opener.agent_id ?? null } : null,
  };
  fs.writeFileSync(roundFile(info, key), JSON.stringify(round) + "\n");
  return { key, branch: info.branch, fingerprint: fp.fingerprint, ...(fp.repos ? { repos: fp.repos } : {}) };
}

// ---------------------------------------------------------------- publishing
//
// GitHub can't see the verdict, which lives in the Git directory. `publish`
// posts it as a commit status on the pushed commit, after checking that the
// verdict passes for it and that the pull request's patch, taken from where the
// branch leaves its base branch, is the one verified. A status belongs to one
// commit, so any later push leaves the pull request without it until the new
// patch is verified and published. Only gate.mjs posts it: the gh wrapper
// refuses a status of this name sent any other way.

const STATUS_CONTEXT = "agent-fleet/verdict";

/** Why a repository's committed patch against a base branch is not the verified one, or null when it is. */
function patchAgainst(target, baseBranch, expected) {
  const tip = tryGit(["rev-parse", "--verify", "-q", `refs/remotes/origin/${baseBranch}^{commit}`], { cwd: target.root });
  if (!tip) return `origin/${baseBranch} is not known here. Fetch it, or name the pull request's base with --base.`;
  const from = git(["merge-base", "HEAD", tip], { cwd: target.root });
  // The gate already compared the patch from the base it uses; another base needs a patch of its own.
  let usual = null;
  try {
    usual = resolveBase(target);
  } catch {
    // No base of its own: compare from the merge base.
  }
  if (from === usual) return null;
  const actual = fingerprint(target, { committed: true, base: from }).fingerprint;
  return actual === expected ? null
    : `The pull request's patch against ${baseBranch} (${actual.slice(0, 12)}) is not the verified patch (${String(expected).slice(0, 12)}): `
      + "the verifier took the patch from another base.";
}

function publishVerdict(target, { base = null } = {}) {
  const verdict = judge(target, { committed: true });
  if (!verdict.ok) throw new Error(`${verdict.reason} Nothing was posted.`);
  const pushed = pushedMatchesHead(target);
  if (!pushed.ok) throw new Error(`${pushed.reason} Nothing was posted.`);
  const ctx = contextOf(target);
  const v = latestVerdict(ctx.info);
  const expected = ctx.members ? v.repos.find((r) => r.path === ctx.rel)?.fingerprint : v.fingerprint;
  const gh = realBinary("gh");
  if (!gh) throw new Error("gh is not on PATH, so the status can't be posted.");
  // The base branch the pull request targets: the open pull request's, else as named, else the default branch.
  const view = spawnSync(gh, ["pr", "view", "--json", "baseRefName,state"], { cwd: target.root, encoding: "utf8", input: "" });
  let open = null;
  try {
    const pr = view.status === 0 ? JSON.parse(view.stdout) : null;
    open = pr?.baseRefName && (pr.state ?? "OPEN") === "OPEN" ? pr.baseRefName : null;
  } catch {
    // No pull request yet.
  }
  if (open && base && base !== open) {
    throw new Error(`The open pull request targets ${open}, not ${base}. Nothing was posted.`);
  }
  const baseBranch = open ?? base ?? defaultBranch(target.root);
  const mismatch = patchAgainst(target, baseBranch, expected);
  if (mismatch) throw new Error(`${mismatch} Nothing was posted.`);
  const head = git(["rev-parse", "HEAD"], { cwd: target.root });
  const by = v.via === "round" ? v.verifier : "the verifier agent";
  const also = ctx.members && ctx.members.length > 1 ? `, with ${ctx.members.filter((rel) => rel !== ctx.rel).join(", ")}` : "";
  const description = `${v.verdict} from ${by} for patch ${String(expected).slice(0, 12)}${also}`.slice(0, 140);
  const args = ["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${head}`, "-f", "state=success", "-f", `context=${STATUS_CONTEXT}`,
    "-f", `description=${description}`];
  if (/^https:\/\/\S+$/.test(v.issue ?? "")) args.push("-f", `target_url=${v.issue}`);
  const posted = spawnSync(gh, args, { cwd: target.root, encoding: "utf8", input: "" });
  if (posted.status !== 0) throw new Error(`gh could not post the status: ${(posted.stderr || posted.stdout || "").trim()}`);
  return { repository: target.root, commit: head, base: baseBranch, context: STATUS_CONTEXT, state: "success", description };
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
 * patch with `committed`, must match; with `either`, one of the two. With a
 * target, the member a pull request comes from, that member's committed patch
 * must match, and every other member's committed or working-tree patch, so a
 * verdict for a change across repositories stops covering it once any part of
 * it changes.
 */
function evaluateWorkspace(ctx, { committed, target = null, either = false }) {
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
    const modes = either ? [true, false] : target === null ? [committed] : r.path === target ? [true] : [true, false];
    if (!modes.some((c) => fingerprint(info, { committed: c }).fingerprint === r.fingerprint)) {
      const which = either ? "current" : target === null ? (committed ? "committed" : "working-tree") : r.path === target ? "committed" : "current";
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

/** Whether a path, once real, falls in the gate's own state under any of the roots: tokens, locks, verdict records and the workspace file. */
function isGateState(roots, file) {
  const abs = realish(file);
  return roots.some((runs) => {
    const root = realish(runs);
    if (!(abs === root || abs.startsWith(root + path.sep))) return false;
    const [top] = path.relative(root, abs).split(path.sep);
    return top.startsWith("_") || ["latest.json", "verdicts.jsonl", WORKSPACE_FILE].includes(path.basename(abs));
  });
}

/**
 * Rounds, as bash-guard sees them: note who runs `gate.mjs round open`, for the round to keep, and refuse
 * `gate.mjs record --key` from the agent that opened that round.
 */
function guardRounds(input, cwd, calls) {
  if (!calls.length || !input?.session_id) return;
  const info = tryRepoInfo(cwd);
  if (!info) return;
  const home = contextOf(info).info;
  for (const words of calls) {
    const [sub, ...rest] = words.slice(words.findIndex((t) => /gate\.mjs$/.test(t)) + 1);
    if (sub === "round" && rest[0] === "open") {
      fs.writeFileSync(openerFile(home, input), JSON.stringify({
        session_id: input.session_id, agent_id: input.agent_id ?? null, root: home.root, branch: home.branch, issued: new Date().toISOString(),
      }) + "\n");
    }
    const key = sub === "record" ? flagValue(rest, "--key") : null;
    // The hook can only match a key it can read, so a key passed through a variable or a substitution is refused.
    if (key !== null && !/^[0-9a-f]{32}$/.test(key)) {
      deny("Verification gate: pass the round's key to `gate.mjs record --key` as it is, the 32 characters your brief gives.");
    }
    const round = key ? readJson(roundFile(home, key)) : null;
    if (round?.opener && sameAgent(round.opener, input)) {
      deny("Verification gate: the agent that opened this verification round can't record its verdict. The verifier the "
        + "round's key was given to records it.");
    }
  }
}

const hooks = {
  // Settings PreToolUse on every Bash call: protect the verdict state, never
  // push the default branch, and gate ready PRs wherever they hide in a command.
  // It judges from the command's text and the directory the session is in. The
  // wrappers judge the same commands again where they really run.
  "bash-guard"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    const stateWords = /(?:^|[^\w.-])(_tokens|_locks|_rounds|_shims|_sessions|latest\.json|verdicts\.jsonl|workspace\.json)\b/;
    if (stateWords.test(raw) && (raw.includes("agent-runs") || stateRoots(cwd).some((root) => raw.includes(root)))) {
      deny("The verdict state (tokens, locks, wrappers, latest.json, verdicts.jsonl, workspace.json) is written only by gate.mjs. "
        + "Use `node .agents/scripts/gate.mjs show` or `workspace show` to read it.");
    }
    const commands = splitCommands(raw);
    guardRounds(input, cwd, commands.filter((w) => w.some((t) => /gate\.mjs$/.test(t))));
    const pushes = commands.map(parseGit).filter((g) => g?.sub === "push");
    const ghs = commands.map(parseGh).filter(Boolean);
    if (!pushes.length && !ghs.length) process.exit(0);
    const info = tryRepoInfo(cwd);
    const ctx = info ? contextOf(info) : null;
    if (info) {
      const main = defaultBranch(info.root);
      for (const g of pushes) {
        const positional = g.args.filter((arg) => !arg.startsWith("-"));
        const refspecs = positional.slice(1);
        const protectedName = (ref) => ["main", "master", main].includes(ref.replace(/^\+/, "").replace(/^refs\/heads\//, ""));
        const pushesMain =
          hasFlag(g.args, "--all", "--mirror") ||
          (refspecs.length === 0 && info.branch === main) ||
          refspecs.some((spec) => {
            const dst = spec.includes(":") ? spec.split(":").pop() : spec;
            return protectedName(dst) || (dst.replace(/^\+/, "") === "HEAD" && info.branch === main);
          });
        if (pushesMain) {
          deny(DEFAULT_BRANCH_PUSH(main) + (ctx.members
            ? " This check reads the command against the directory the session is in, so in a workspace name the repository "
              + "and the branch: `git -C <repository> push -u origin <branch>`."
            : ""));
        }
      }
    }
    const gated = [];
    for (const gh of ghs) {
      if (gh.group === "pr" && gh.sub === "create" && !hasFlag(gh.args, "--draft", "-d")) gated.push({ gh, kind: "create" });
      else if (gh.group === "pr" && gh.sub === "ready" && !hasFlag(gh.args, "--undo")) gated.push({ gh, kind: "ready" });
      else if (gh.group === "pr" && gh.sub === "edit" && hasFlag(gh.args, "--base", "-B")) gated.push({ gh, kind: "retarget" });
      else if (gh.group === "api" && ghApiGated(gh.sub, gh.args)) deny(`Verification gate: ${USE_GH_PR}`);
    }
    if (ctx?.members && (pushes.length || gated.length)) {
      // In a workspace the repository a command acts on depends on where it runs, which its text can't tell. The
      // wrappers check that, so without them nothing here pushes or opens a pull request.
      if (!sessionHasWrappers(input, [info, ctx.info])) {
        deny("Verification gate: in a workspace, a push or a pull request command is checked where it runs, by the git and gh "
          + "wrappers the gate's session-start hook puts on PATH. This session has none. Start a new session in this project; "
          + "if that doesn't help, `.claude/settings.json` lacks the gate's SessionStart hook.");
      }
      if (!gated.length) process.exit(0);
      try {
        // Which member the pull request belongs to is the wrapper's to judge. Here the change as a whole must be verified.
        const r = evaluateWorkspace(ctx, { committed: true, either: true });
        if (!r.ok) deny(`Verification gate: ${r.reason} ${READY_PR_NEEDS}`);
      } catch (e) {
        deny(`Verification gate could not evaluate the patch: ${e.message}`);
      }
      process.exit(0);
    }
    if (!gated.length) process.exit(0);
    if (!info) deny("Verification gate: not in a git repository, so the patch can't be checked.");
    for (const { gh } of gated) {
      const head = flagValue(gh.args, "--head", "-H");
      if (head && head.split(":").pop() !== info.branch) {
        deny(`Verification gate: run this from the branch being proposed (--head ${head}, but HEAD is ${info.branch}).`);
      }
      if (gh.repo) {
        const origin = tryGit(["remote", "get-url", "origin"], { cwd: info.root }) ?? "";
        if (!origin.replace(/\.git$/, "").endsWith(gh.repo.replace(/^.*github\.com[/:]/, ""))) {
          deny(`Verification gate: --repo ${gh.repo} is not this checkout's origin, so the patch can't be checked.`);
        }
      }
    }
    try {
      const r = evaluate(info, { committed: true });
      if (!r.ok) deny(`Verification gate: ${r.reason} ${READY_PR_NEEDS}`);
      const p = pushedMatchesHead(info);
      if (!p.ok) deny(`Verification gate: ${p.reason}`);
      process.exit(0);
    } catch (e) {
      deny(`Verification gate could not evaluate the patch: ${e.message}`);
    }
  },

  // Settings SessionStart: write the git and gh wrappers into the gate's state and put them first on PATH for every
  // Bash command of the session, the agent's and its subagents'.
  "session-env"(input, cwd) {
    const project = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR) ? process.env.CLAUDE_PROJECT_DIR : cwd;
    const info = tryRepoInfo(project);
    if (!info) process.exit(0); // Not a repository: the gate has nothing to check here.
    // What a session-start hook prints reaches the agent, so it knows when the second check is missing.
    const inactive = (why) => {
      process.stdout.write(`agent-fleet's verification gate: the git and gh wrappers are not active in this session (${why}). `
        + "The gate's hook still reads each command's text, but it can't tell where a command runs. In a workspace of several "
        + "repositories it therefore refuses every push and pull request command.\n");
      process.exit(0);
    };
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (!envFile) inactive("this tool gives session-start hooks no CLAUDE_ENV_FILE to set PATH with");
    try {
      const shims = writeWrappers(info);
      // The harness runs this file before each Bash command, so the line must be safe to run more than once.
      fs.appendFileSync(envFile, `agent_fleet_shims=${shQuote(shellPath(shims))}; case ":$PATH:" in *":$agent_fleet_shims:"*) ;; `
        + '*) PATH="$agent_fleet_shims:$PATH"; export PATH ;; esac\n');
      if (input?.session_id) {
        const marker = sessionFile(info, input.session_id);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ started: new Date().toISOString(), wrappers: shims }) + "\n");
        // Markers of sessions long over.
        for (const name of fs.readdirSync(path.dirname(marker))) {
          const file = path.join(path.dirname(marker), name);
          if (Date.now() - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) fs.rmSync(file, { force: true });
        }
      }
    } catch (e) {
      inactive(`they could not be set up: ${e.message}`);
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
    // A record with a round's key needs no token, and a token left unused would let anyone record for 60 seconds.
    if (records.some((w) => w.some((t) => t === "--key" || t.startsWith("--key=")))) process.exit(0);
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
        const outside = g.targets.length > 0 && g.targets.every(isOutside) && !/\bGIT_(DIR|WORK_TREE|INDEX_FILE)\+?=/.test(raw);
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

  // Run from the workspace root or any repository of the change: start a verification round for a verifier in any tool.
  round(argv) {
    if (argv[0] !== "open" || argv.length > 1) throw new Error("Usage: gate.mjs round open, run by the lead just before it starts a verifier.");
    console.log(JSON.stringify(openRound(gateContext()), null, 2));
  },

  record(argv) {
    const f = parseFlags(argv);
    const ctx = gateContext();
    const { info } = ctx;
    const now = Date.now();
    let lock;
    let recorder;
    let useUp = () => {};
    if (f.key !== undefined) {
      // A round's key: the lead gave it to this verifier only.
      if (typeof f.key !== "string") throw new Error("--key needs the key from your brief.");
      const file = roundFile(info, f.key);
      lock = readJson(file);
      if (!lock || now - Date.parse(lock.started) > LOCK_MAX_AGE_MS) {
        console.error("Refused: no open verification round has this key. The lead opens one with `gate.mjs round open` and gives "
          + "you its key; each key records one verdict.");
        process.exit(1);
      }
      recorder = { via: "round", verifier: typeof f.verifier === "string" ? f.verifier : "a verifier that gave no model" };
      useUp = () => fs.rmSync(file, { force: true });
    } else {
      // The token proves the call came from the team's verifier agent (see authorize-record).
      const tokens = stateDir(info, "tokens");
      const token = fs
        .readdirSync(tokens)
        .map((name) => ({ file: path.join(tokens, name), data: readJson(path.join(tokens, name)) }))
        .find((t) => t.data && now - Date.parse(t.data.issued) < TOKEN_MAX_AGE_MS);
      if (!token) {
        console.error("Refused: only a verifier may record a verdict, with the key of the round the lead opened for it.");
        process.exit(1);
      }
      fs.rmSync(token.file, { force: true });
      lock = readJson(lockFile(info, token.data.agent_id));
      if (lock?.error) {
        console.error(`Refused: the gate could not take the patch when verification started: ${lock.error} Report BLOCKED with this cause.`);
        process.exit(1);
      }
      if (!lock || now - Date.parse(lock.started) > LOCK_MAX_AGE_MS) {
        console.error("Refused: no live verifier session for this agent.");
        process.exit(1);
      }
      recorder = { via: "verifier agent", verifier: token.data.agent_id };
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
      ...recorder,
      recorded_at: new Date().toISOString(),
    };
    if (fp.repos) {
      entry.repos = fp.repos.map((r) => ({ ...r, head: tryGit(["rev-parse", "HEAD"], { cwd: memberDir(info, r.path) }) }));
    }
    const dir = runDir(info);
    fs.appendFileSync(path.join(dir, "verdicts.jsonl"), JSON.stringify(entry) + "\n");
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(entry, null, 2) + "\n");
    useUp();
    console.log(JSON.stringify(entry, null, 2));
  },

  // Post the passing verdict as the agent-fleet/verdict status of the pushed commit: of this repository, or of a
  // workspace member with --repo.
  publish(argv) {
    const f = parseFlags(argv);
    const rel = repoFlag(f);
    if (f.base === true) throw new Error("--base needs the branch the pull request targets.");
    const target = rel !== null ? memberRepo(gateContext().info, rel) : repoInfo();
    console.log(JSON.stringify(publishVerdict(target, { base: f.base ?? null }), null, 2));
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

  // What the wrappers on PATH run: `shim <git|gh|pre-push> <wrappers' home> [arguments...]`.
  shim(argv) {
    const [tool, home, ...args] = argv;
    if (tool === "git" && home) return shimGit(args, home);
    if (tool === "gh" && home) return shimGh(args);
    if (tool === "pre-push" && home) return shimPrePush(args);
    throw new Error("Usage: gate.mjs shim <git|gh|pre-push> <home> [arguments...], run by the wrappers the gate puts on PATH.");
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
  console.error("Usage: gate.mjs <fingerprint|diff|paths|set-base|workspace|round|record|publish|show|check|hook|shim> [...]");
  process.exit(1);
}
try {
  commands[cmd](rest);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
